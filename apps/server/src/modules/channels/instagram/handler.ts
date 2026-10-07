import type { ChannelConnection, WebhookEvent } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { getPrisma } from '../../../db/client.js';
import { AppError, errorMessage, isRetryable } from '../../../lib/errors.js';
import { childLogger } from '../../../lib/logger.js';
import { findOrCreateLead } from '../../crm/service.js';
import { isTrivialComment, parseAgentSettings } from '../../engine/business-rules.js';
import { runAgentPipeline } from '../../engine/pipeline.js';
import { getMediaAssetWithData, publicMediaUrl } from '../../media/service.js';
import { claimIdempotency, releaseIdempotency } from '../shared/idempotency.js';
import { getInstagramClient } from './service.js';

/**
 * Make the account behave like a person who is actually there: mark the
 * message seen the moment it arrives, then show the typing bubble for as long
 * as the agent is thinking.
 *
 * Instagram clears the bubble on its own after a short while, so it is
 * refreshed on an interval rather than sent once — generation takes several
 * seconds and a bubble that vanished before the reply lands reads as nobody
 * being there, which is the same failure the Telegram handler had.
 *
 * Entirely cosmetic: every error is swallowed. A missing bubble must never
 * cost a reply.
 */
function startInstagramPresence(client: InstagramClient, igsid: string): () => void {
  let stopped = false;
  void client.sendSenderAction(igsid, 'mark_seen').catch(() => undefined);
  const ping = (): void => {
    if (stopped) return;
    void client.sendSenderAction(igsid, 'typing_on').catch(() => undefined);
  };
  ping();
  const timer = setInterval(ping, 5_000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    // Sending the reply clears the bubble, but an outcome with no reply
    // (silent, escalated) would otherwise leave it spinning forever.
    void client.sendSenderAction(igsid, 'typing_off').catch(() => undefined);
  };
}

/**
 * Instagram event processing: the comment flow (spec §11) and the DM flow
 * (spec §12), built strictly on supported capabilities:
 *  - public comment reply (POST /{comment-id}/replies)
 *  - ONE private reply per comment within 7 days (recipient.comment_id)
 *  - DM replies within the 24-hour window (recipient.id = IGSID)
 */

interface CommentValue {
  id?: string;
  text?: string;
  parent_id?: string;
  from?: { id?: string; username?: string };
  media?: { id?: string; media_product_type?: string };
}

interface MessagingItem {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: { mid?: string; text?: string; is_echo?: boolean };
}

export async function processInstagramEvent(event: WebhookEvent): Promise<void> {
  const payload = event.payload as unknown as {
    kind: 'comment' | 'dm';
    accountId: string;
    value?: CommentValue;
    field?: string;
    messaging?: MessagingItem;
  };
  const prisma = getPrisma();

  const connection = await prisma.channelConnection.findFirst({
    where: { channel: 'INSTAGRAM', externalAccountId: payload.accountId },
  });
  if (!connection || connection.status !== 'connected') {
    await markEvent(event.id, 'SKIPPED', 'no connected Instagram account for this entry id');
    return;
  }

  if (payload.kind === 'comment') {
    await processComment(event, connection, payload.value ?? {}, payload.field === 'live_comments');
  } else {
    await processDm(event, connection, payload.messaging ?? {});
  }
}

// ─────────────────────────────── Comment flow (spec §11) ───────────────────────────────

async function processComment(
  event: WebhookEvent,
  connection: ChannelConnection,
  value: CommentValue,
  isLive: boolean,
): Promise<void> {
  const prisma = getPrisma();
  const requestId = randomUUID();
  const tenantId = connection.tenantId;
  const log = childLogger({ module: 'ig-comment', requestId, webhookEventId: event.id, tenantId });

  const commentId = value.id;
  const commenterId = value.from?.id;
  const text = (value.text ?? '').trim();
  if (!commentId || !commenterId) {
    await markEvent(event.id, 'SKIPPED', 'malformed comment payload');
    return;
  }
  // Never react to the business account's own comments (incl. our own replies) — loop guard.
  if (commenterId === connection.externalAccountId) {
    await markEvent(event.id, 'SKIPPED', 'own comment (echo of our reply)');
    return;
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    await markEvent(event.id, 'FAILED', 'tenant not found');
    return;
  }

  const lead = await findOrCreateLead(
    tenantId,
    { channel: 'INSTAGRAM', externalId: commenterId, username: value.from?.username ?? null },
    { source: 'INSTAGRAM' },
  );

  const mediaId = value.media?.id ?? 'unknown-media';
  const conversation = await prisma.conversation.upsert({
    where: {
      tenantId_kind_externalThreadId: {
        tenantId,
        kind: 'INSTAGRAM_COMMENT_THREAD',
        externalThreadId: `${mediaId}:${commenterId}`,
      },
    },
    create: {
      tenantId,
      kind: 'INSTAGRAM_COMMENT_THREAD',
      channel: 'INSTAGRAM',
      externalThreadId: `${mediaId}:${commenterId}`,
      leadId: lead.id,
      lastMessageAt: new Date(),
      metadata: { mediaId, mediaProductType: value.media?.media_product_type ?? null },
    },
    update: { lastMessageAt: new Date() },
  });

  try {
    await prisma.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        tenantId,
        direction: 'INBOUND',
        role: 'USER',
        content: text || '(empty comment)',
        externalMessageId: commentId,
        metadata: { parentId: value.parent_id ?? null, isLive },
      },
    });
  } catch (err) {
    // Retry of this event: comment already recorded — continue so the reply
    // still happens. Send idempotency keys prevent double replies.
    if ((err as { code?: string }).code !== 'P2002') throw err;
    log.info('comment already recorded (retry) — continuing');
  }
  await prisma.lead.update({ where: { id: lead.id }, data: { lastInteractionAt: new Date() } });

  const agent = await prisma.agent.findUnique({
    where: { tenantId_type: { tenantId, type: 'INSTAGRAM_COMMENT' } },
  });
  if (!agent || !agent.enabled) {
    await markEvent(event.id, 'SKIPPED', agent ? 'agent disabled' : 'no comment agent configured');
    return;
  }

  // Emoji/mention-only comments: recorded above, but no AI run or reply.
  if (parseAgentSettings(agent).skipTrivialComments && isTrivialComment(text)) {
    await markEvent(event.id, 'SKIPPED', 'trivial comment (mentions/emoji only)');
    return;
  }

  const outcome = await runAgentPipeline({
    tenantId,
    tenantName: tenant.name,
    agent,
    conversationId: conversation.id,
    lead,
    channelKey: 'instagram_comment',
    inboundText: text || '(empty comment)',
    username: value.from?.username ?? null,
    requestId,
    extraContext: [
      `<comment_context media_id="${mediaId}" media_type="${value.media?.media_product_type ?? 'unknown'}" is_reply="${Boolean(value.parent_id)}" is_live="${isLive}"/>`,
    ],
  });

  if (outcome.status === 'failed') {
    // Retryable: the queue re-runs this event (message already persisted; sends
    // below are idempotency-guarded), then dead-letters after bounded attempts.
    throw new AppError(outcome.error ?? 'agent pipeline failed', { retryable: true });
  }

  const client = getInstagramClient(connection);
  const decision = outcome.decision;
  const verdict = outcome.verdict;

  // Private reply first (it is the scarce, one-shot resource — spec §11).
  // Live comments: private replies are the ONLY supported response and work
  // during the broadcast; public /replies is rejected for live video.
  if (decision?.sendPrivateReply && verdict?.privateReplyText) {
    const key = `ig_private_reply:${commentId}`;
    const claimed = await claimIdempotency(tenantId, key);
    if (claimed) {
      try {
        const res = await client.sendPrivateReply(commentId, verdict.privateReplyText);
        await prisma.conversationMessage.create({
          data: {
            conversationId: conversation.id,
            tenantId,
            direction: 'OUTBOUND',
            role: 'AGENT',
            content: verdict.privateReplyText,
            externalMessageId: res.message_id ?? `private-reply:${commentId}`,
            metadata: { type: 'private_reply', commentId, aiExecutionId: outcome.aiExecutionId ?? null },
          },
        });
        log.info({ commentId }, 'private reply sent');
      } catch (err) {
        if (isRetryable(err)) {
          // Release the one-shot claim so the queue retry can attempt the send
          // again — otherwise a transient IG error permanently burns the only
          // private reply this comment will ever allow.
          await releaseIdempotency(tenantId, key);
          throw err;
        }
        log.warn({ err: errorMessage(err) }, 'private reply failed permanently');
      }
    } else {
      log.info({ commentId }, 'private reply already sent for this comment — skipped');
    }
  }

  // Public reply (top-level comments only; the API cannot reply to live-video comments).
  const suppressPublic =
    isLive ||
    (decision?.sendPrivateReply && verdict?.privateReplyText && !outcome.settings.publicReplyOnPrivate);
  if (verdict?.reply && !suppressPublic) {
    const key = `ig_comment_reply:${commentId}`;
    const claimed = await claimIdempotency(tenantId, key);
    if (claimed) {
      try {
        const res = await client.replyToComment(commentId, verdict.reply);
        await prisma.conversationMessage.create({
          data: {
            conversationId: conversation.id,
            tenantId,
            direction: 'OUTBOUND',
            role: 'AGENT',
            content: verdict.reply,
            externalMessageId: res.id ?? `reply:${commentId}`,
            metadata: { type: 'public_reply', commentId, aiExecutionId: outcome.aiExecutionId ?? null },
          },
        });
        log.info({ commentId }, 'public comment reply sent');
      } catch (err) {
        if (isRetryable(err)) {
          await releaseIdempotency(tenantId, key);
          throw err;
        }
        log.warn({ err: errorMessage(err) }, 'public comment reply failed permanently');
      }
    } else {
      log.info({ commentId }, 'comment already replied — skipped (duplicate protection)');
    }
  }

  await markEvent(event.id, 'PROCESSED');
}

// ─────────────────────────────── DM flow (spec §12) ───────────────────────────────

async function processDm(
  event: WebhookEvent,
  connection: ChannelConnection,
  messaging: MessagingItem,
): Promise<void> {
  const prisma = getPrisma();
  const requestId = randomUUID();
  const tenantId = connection.tenantId;
  const log = childLogger({ module: 'ig-dm', requestId, webhookEventId: event.id, tenantId });

  const igsid = messaging.sender?.id;
  const mid = messaging.message?.mid;
  const text = (messaging.message?.text ?? '').trim();
  if (!igsid || !mid) {
    await markEvent(event.id, 'SKIPPED', 'malformed messaging payload');
    return;
  }
  if (messaging.message?.is_echo || igsid === connection.externalAccountId) {
    await markEvent(event.id, 'SKIPPED', 'echo of our own message');
    return;
  }
  if (!text) {
    await markEvent(event.id, 'SKIPPED', 'non-text message (attachment/sticker) — recorded only');
    return;
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    await markEvent(event.id, 'FAILED', 'tenant not found');
    return;
  }

  const lead = await findOrCreateLead(
    tenantId,
    { channel: 'INSTAGRAM', externalId: igsid },
    { source: 'INSTAGRAM' },
  );

  const client = getInstagramClient(connection);
  // Consent to read the profile exists once the user has messaged us — enrich best-effort.
  if (!lead.username || !lead.name) {
    try {
      const profile = await client.getUserProfile(igsid);
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          username: lead.username ?? profile.username ?? undefined,
          name: lead.name ?? profile.name ?? undefined,
        },
      });
      if (profile.username) {
        await prisma.leadIdentity.updateMany({
          where: { tenantId, channel: 'INSTAGRAM', externalId: igsid },
          data: { username: profile.username },
        });
      }
    } catch {
      // consent/permission errors are expected in some states — not fatal
    }
  }

  const conversation = await prisma.conversation.upsert({
    where: {
      tenantId_kind_externalThreadId: { tenantId, kind: 'INSTAGRAM_DM', externalThreadId: igsid },
    },
    create: {
      tenantId,
      kind: 'INSTAGRAM_DM',
      channel: 'INSTAGRAM',
      externalThreadId: igsid,
      leadId: lead.id,
      lastMessageAt: new Date(),
    },
    update: { lastMessageAt: new Date(), leadId: lead.id },
  });

  try {
    await prisma.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        tenantId,
        direction: 'INBOUND',
        role: 'USER',
        content: text,
        externalMessageId: mid,
        metadata: { timestamp: messaging.timestamp ?? null },
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
    log.info('inbound DM already recorded (retry) — continuing');
  }
  await prisma.lead.update({ where: { id: lead.id }, data: { lastInteractionAt: new Date() } });

  const agent = await prisma.agent.findUnique({
    where: { tenantId_type: { tenantId, type: 'INSTAGRAM_DM' } },
  });
  if (!agent || !agent.enabled) {
    await markEvent(event.id, 'SKIPPED', agent ? 'agent disabled' : 'no DM agent configured');
    return;
  }

  // 24-hour platform window: retried/stale events must not attempt a send.
  const eventAgeMs = messaging.timestamp ? Date.now() - Number(messaging.timestamp) : 0;
  if (eventAgeMs > 23.5 * 3600_000) {
    await markEvent(event.id, 'SKIPPED', 'inbound message older than the 24h messaging window');
    return;
  }

  const freshLead = await prisma.lead.findUnique({ where: { id: lead.id } });
  // Seen + typing start now, not after the model answers.
  const stopPresence = startInstagramPresence(client, igsid);
  let outcome;
  try {
    outcome = await runAgentPipeline({
      tenantId,
      tenantName: tenant.name,
      agent,
      conversationId: conversation.id,
      lead: freshLead ?? lead,
      channelKey: 'instagram_dm',
      inboundText: text,
      username: freshLead?.username ?? null,
      requestId,
    });
  } finally {
    stopPresence();
  }

  if (outcome.status === 'failed') {
    throw new AppError(outcome.error ?? 'agent pipeline failed', { retryable: true });
  }

  if (outcome.status === 'replied' && outcome.verdict?.reply) {
    // Idempotency: a queue retry after a partial failure must not DM the user twice.
    const key = `ig_dm_reply:${mid}`;
    if (await claimIdempotency(tenantId, key)) {
      let res: { message_id?: string };
      try {
        res = await client.sendMessage(igsid, outcome.verdict.reply);
      } catch (err) {
        if (isRetryable(err)) {
          await releaseIdempotency(tenantId, key);
        }
        throw err;
      }
      await prisma.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          tenantId,
          direction: 'OUTBOUND',
          role: 'AGENT',
          content: outcome.verdict.reply,
          externalMessageId: res.message_id ?? `dm:${mid}:reply`,
          metadata: { aiExecutionId: outcome.aiExecutionId ?? null },
        },
      });
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date(), agentId: agent.id },
      });
      log.info('dm reply sent');
    } else {
      log.info('dm reply already sent for this message — skipped (retry)');
    }

    // One optional image attachment: Meta downloads it from our public
    // /files/media URL, so APP_URL must be a public HTTPS base.
    if (outcome.verdict.imageId) {
      const imageUrl = publicMediaUrl(outcome.verdict.imageId);
      if (!imageUrl) {
        log.warn('image requested but APP_URL is not a public HTTPS URL — skipping image');
      } else if (await claimIdempotency(tenantId, `ig_dm_image:${mid}`)) {
        const asset = await getMediaAssetWithData(tenantId, outcome.verdict.imageId);
        if (asset) {
          try {
            const imgRes = await client.sendImageMessage(igsid, imageUrl);
            await prisma.conversationMessage.create({
              data: {
                conversationId: conversation.id,
                tenantId,
                direction: 'OUTBOUND',
                role: 'AGENT',
                content: `[rasm: ${asset.name}]`,
                externalMessageId: imgRes.message_id ?? `dm:${mid}:image`,
                metadata: {
                  type: 'image',
                  imageAssetId: asset.id,
                  aiExecutionId: outcome.aiExecutionId ?? null,
                },
              },
            });
            log.info('dm image sent');
          } catch (err) {
            if (isRetryable(err)) {
              await releaseIdempotency(tenantId, `ig_dm_image:${mid}`);
              throw err;
            }
            log.warn({ err: errorMessage(err) }, 'dm image failed permanently — text already sent');
          }
        }
      }
    }
  }

  await markEvent(event.id, 'PROCESSED');
}

// ─────────────────────────────── shared helpers ───────────────────────────────

async function markEvent(
  id: string,
  status: 'PROCESSED' | 'SKIPPED' | 'FAILED',
  error?: string,
): Promise<void> {
  await getPrisma()
    .webhookEvent.update({
      where: { id },
      data: { status, error: error?.slice(0, 500), processedAt: new Date() },
    })
    .catch(() => undefined);
}
