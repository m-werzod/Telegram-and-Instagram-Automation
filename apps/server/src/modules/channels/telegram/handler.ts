import type { ChannelConnection, WebhookEvent } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { getPrisma } from '../../../db/client.js';
import { AppError, errorMessage, isRetryable } from '../../../lib/errors.js';
import { childLogger } from '../../../lib/logger.js';
import { findOrCreateLead } from '../../crm/service.js';
import { runAgentPipeline } from '../../engine/pipeline.js';
import { resolveManualAction } from '../../manual-actions/service.js';
import { claimIdempotency, releaseIdempotency } from '../shared/idempotency.js';
import { getTelegramClient } from './service.js';
import {
  splitMessage,
  TELEGRAM_MAX_MESSAGE,
  type TgBusinessConnection,
  type TgUpdate,
} from './client.js';

/** Business-connection state persisted on the ChannelConnection metadata. */
export interface StoredBusinessConnection {
  id: string;
  ownerId: number;
  ownerName: string;
  ownerUsername: string | null;
  userChatId: number;
  isEnabled: boolean;
  canReply: boolean;
  canReadMessages: boolean;
  connectedAt: number;
}

export function toStoredBusinessConnection(bc: TgBusinessConnection): StoredBusinessConnection {
  return {
    id: bc.id,
    ownerId: bc.user.id,
    ownerName: [bc.user.first_name, bc.user.last_name].filter(Boolean).join(' '),
    ownerUsername: bc.user.username ?? null,
    userChatId: bc.user_chat_id,
    isEnabled: bc.is_enabled,
    canReply: bc.rights?.can_reply ?? false,
    canReadMessages: bc.rights?.can_read_messages ?? false,
    connectedAt: bc.date,
  };
}

/**
 * Telegram event processing (spec §14): update → lead → conversation →
 * persist inbound → agent pipeline → send reply → persist outbound.
 * The event row is already persisted & deduplicated by update_id.
 *
 * Two distinct flows share this webhook:
 *  - bot chats (update.message)                → TELEGRAM agent
 *  - the owner's PERSONAL account chats via a Telegram Business connection
 *    (update.business_*)                       → TELEGRAM_PERSONAL agent
 */
export async function processTelegramEvent(event: WebhookEvent): Promise<void> {
  const prisma = getPrisma();
  const requestId = randomUUID();
  const log = childLogger({ module: 'telegram-handler', requestId, webhookEventId: event.id });

  const { connectionId, update } = event.payload as unknown as {
    connectionId: string;
    update: TgUpdate;
  };

  const connection = await prisma.channelConnection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.status !== 'connected') {
    await markEvent(event.id, 'SKIPPED', 'connection missing or disconnected');
    return;
  }
  const tenantId = connection.tenantId;

  if (update.business_connection) {
    await handleBusinessConnection(event, connection, update.business_connection);
    return;
  }
  if (update.business_message) {
    await processPersonalMessage(event, connection, update, requestId);
    return;
  }
  if (update.edited_business_message || update.deleted_business_messages) {
    await markEvent(event.id, 'SKIPPED', 'business edit/delete event (recorded only)');
    return;
  }

  const message = update.message;
  // Only plain private-chat text messages are handled autonomously. Everything
  // else is recorded and skipped (edited messages, callbacks, group chatter).
  if (!message || !message.text || !message.from || message.from.is_bot) {
    await markEvent(event.id, 'SKIPPED', 'not a processable user text message');
    return;
  }
  if (message.chat.type !== 'private') {
    await markEvent(event.id, 'SKIPPED', `unsupported chat type: ${message.chat.type}`);
    return;
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    await markEvent(event.id, 'FAILED', 'tenant not found');
    return;
  }

  // CRM identity resolution (never duplicate a person — spec §9).
  const fullName = [message.from.first_name, message.from.last_name].filter(Boolean).join(' ');
  const lead = await findOrCreateLead(
    tenantId,
    { channel: 'TELEGRAM', externalId: String(message.from.id), username: message.from.username ?? null },
    { name: fullName || null, source: 'TELEGRAM' },
  );

  const conversation = await prisma.conversation.upsert({
    where: {
      tenantId_kind_externalThreadId: {
        tenantId,
        kind: 'TELEGRAM_CHAT',
        externalThreadId: String(message.chat.id),
      },
    },
    create: {
      tenantId,
      kind: 'TELEGRAM_CHAT',
      channel: 'TELEGRAM',
      externalThreadId: String(message.chat.id),
      leadId: lead.id,
      lastMessageAt: new Date(),
    },
    update: { lastMessageAt: new Date(), leadId: lead.id },
  });

  // Persist inbound before anything expensive (spec §54). Unique on
  // (conversationId, externalMessageId) makes this idempotent: on a RETRY of
  // this same event the row already exists — continue processing so the reply
  // still happens (event-level dedup already blocks true duplicates).
  try {
    await prisma.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        tenantId,
        direction: 'INBOUND',
        role: 'USER',
        content: message.text,
        externalMessageId: String(message.message_id),
        metadata: { updateId: update.update_id },
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
    log.info('inbound message already recorded (retry) — continuing');
  }
  await prisma.lead.update({ where: { id: lead.id }, data: { lastInteractionAt: new Date() } });

  const agent = await prisma.agent.findUnique({
    where: { tenantId_type: { tenantId, type: 'TELEGRAM' } },
  });
  if (!agent || !agent.enabled) {
    // Event and message are safely recorded; no autonomous response (spec §5).
    await markEvent(event.id, 'SKIPPED', agent ? 'agent disabled' : 'no telegram agent configured');
    return;
  }

  const outcome = await runAgentPipeline({
    tenantId,
    tenantName: tenant.name,
    agent,
    conversationId: conversation.id,
    lead,
    channelKey: 'telegram',
    inboundText: message.text,
    username: message.from.username ?? null,
    requestId,
  });

  if (outcome.status === 'failed') {
    // Retryable: the queue re-runs this event; sends below are idempotency-guarded.
    throw new AppError(outcome.error ?? 'agent pipeline failed', { retryable: true });
  }

  if (outcome.status === 'replied' && outcome.verdict?.reply) {
    const client = getTelegramClient(connection);
    try {
      await client.sendChatAction(message.chat.id, 'typing');
    } catch {
      // typing indicator is cosmetic — ignore failures
    }
    // Per-part idempotency: if part 2 of a long reply hits flood control, the
    // queue retry resumes at the failed part instead of re-sending part 1.
    const parts = splitMessage(outcome.verdict.reply, TELEGRAM_MAX_MESSAGE);
    for (let i = 0; i < parts.length; i++) {
      const key = `tg_reply:${connection.id}:${update.update_id}:${i}`;
      if (!(await claimIdempotency(tenantId, key))) continue;
      let sent;
      try {
        sent = await client.sendMessage(message.chat.id, parts[i]!);
      } catch (err) {
        if (isRetryable(err)) {
          await releaseIdempotency(tenantId, key);
        }
        throw err;
      }
      const s = sent[0];
      await prisma.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          tenantId,
          direction: 'OUTBOUND',
          role: 'AGENT',
          content: s?.text ?? parts[i]!,
          externalMessageId: s ? String(s.message_id) : `tg:${update.update_id}:${i}`,
          metadata: { aiExecutionId: outcome.aiExecutionId ?? null },
        },
      });
    }
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date(), agentId: agent.id },
    });
  }

  await markEvent(event.id, 'PROCESSED');
  log.info({ outcome: outcome.status }, 'telegram event processed');
}

// ─────────────── Personal account (Telegram Business connection) ───────────────

/** The owner connected/edited/disconnected the bot on their PERSONAL account. */
async function handleBusinessConnection(
  event: WebhookEvent,
  connection: ChannelConnection,
  bc: TgBusinessConnection,
): Promise<void> {
  const prisma = getPrisma();
  const stored = toStoredBusinessConnection(bc);
  const log = childLogger({ module: 'telegram-business', webhookEventId: event.id });

  await prisma.channelConnection.update({
    where: { id: connection.id },
    data: {
      metadata: JSON.parse(
        JSON.stringify({ ...(connection.metadata as object), businessConnection: stored }),
      ),
    },
  });
  if (stored.isEnabled) {
    await resolveManualAction(connection.tenantId, 'telegram-business-connect');
  }
  log.info(
    {
      owner: stored.ownerUsername ?? stored.ownerName,
      isEnabled: stored.isEnabled,
      canReply: stored.canReply,
    },
    stored.isEnabled ? 'personal account connected' : 'personal account connection disabled',
  );
  await markEvent(event.id, 'PROCESSED');
}

/** A message in one of the owner's personal private chats (spec: Personal Agent). */
async function processPersonalMessage(
  event: WebhookEvent,
  connection: ChannelConnection,
  update: TgUpdate,
  requestId: string,
): Promise<void> {
  const prisma = getPrisma();
  const tenantId = connection.tenantId;
  const message = update.business_message!;
  const log = childLogger({ module: 'telegram-personal', requestId, webhookEventId: event.id });

  const biz = (connection.metadata as { businessConnection?: StoredBusinessConnection })
    .businessConnection;
  if (!biz || (message.business_connection_id && biz.id !== message.business_connection_id)) {
    await markEvent(event.id, 'SKIPPED', 'no stored business connection for this message — reconnect the personal account');
    return;
  }
  if (!message.text || !message.from || message.chat.type !== 'private') {
    await markEvent(event.id, 'SKIPPED', 'not a processable personal-chat text message');
    return;
  }
  // The owner's own outgoing messages also arrive as business messages —
  // never treat the owner as a customer or auto-reply to them.
  if (message.from.id === biz.ownerId || message.from.is_bot) {
    await markEvent(event.id, 'SKIPPED', 'message from the account owner (or a bot) — recorded only');
    return;
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    await markEvent(event.id, 'FAILED', 'tenant not found');
    return;
  }

  // Same TELEGRAM identity namespace as the bot flow: a person who messaged
  // both the bot and the owner's personal account resolves to ONE lead.
  const fullName = [message.from.first_name, message.from.last_name].filter(Boolean).join(' ');
  const lead = await findOrCreateLead(
    tenantId,
    { channel: 'TELEGRAM', externalId: String(message.from.id), username: message.from.username ?? null },
    { name: fullName || null, source: 'TELEGRAM' },
  );

  const conversation = await prisma.conversation.upsert({
    where: {
      tenantId_kind_externalThreadId: {
        tenantId,
        kind: 'TELEGRAM_PERSONAL_CHAT',
        externalThreadId: String(message.chat.id),
      },
    },
    create: {
      tenantId,
      kind: 'TELEGRAM_PERSONAL_CHAT',
      channel: 'TELEGRAM',
      externalThreadId: String(message.chat.id),
      leadId: lead.id,
      lastMessageAt: new Date(),
      metadata: { businessConnectionId: biz.id },
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
        content: message.text,
        externalMessageId: String(message.message_id),
        metadata: { updateId: update.update_id, personal: true },
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
    log.info('inbound personal message already recorded (retry) — continuing');
  }
  await prisma.lead.update({ where: { id: lead.id }, data: { lastInteractionAt: new Date() } });

  const agent = await prisma.agent.findUnique({
    where: { tenantId_type: { tenantId, type: 'TELEGRAM_PERSONAL' } },
  });
  if (!agent || !agent.enabled) {
    // Recorded, never answered autonomously while OFF (spec §5).
    await markEvent(event.id, 'SKIPPED', agent ? 'personal agent disabled' : 'no personal agent configured');
    return;
  }
  if (!biz.isEnabled) {
    await markEvent(event.id, 'SKIPPED', 'business connection disabled by the account owner');
    return;
  }
  if (!biz.canReply) {
    await markEvent(event.id, 'SKIPPED', 'owner did not grant the "reply to messages" permission');
    return;
  }
  // can_reply only covers chats with incoming messages in the last 24 hours —
  // stale/retried events must not attempt a send (message.date is unix seconds).
  if (message.date && Date.now() / 1000 - message.date > 23.5 * 3600) {
    await markEvent(event.id, 'SKIPPED', 'message older than the 24h business reply window');
    return;
  }

  const outcome = await runAgentPipeline({
    tenantId,
    tenantName: tenant.name,
    agent,
    conversationId: conversation.id,
    lead,
    channelKey: 'telegram_personal',
    inboundText: message.text,
    username: message.from.username ?? null,
    requestId,
  });

  if (outcome.status === 'failed') {
    throw new AppError(outcome.error ?? 'agent pipeline failed', { retryable: true });
  }

  if (outcome.status === 'replied' && outcome.verdict?.reply) {
    const client = getTelegramClient(connection);
    try {
      await client.sendChatAction(message.chat.id, 'typing', { businessConnectionId: biz.id });
    } catch {
      // cosmetic
    }
    const parts = splitMessage(outcome.verdict.reply, TELEGRAM_MAX_MESSAGE);
    for (let i = 0; i < parts.length; i++) {
      const key = `tg_personal_reply:${connection.id}:${update.update_id}:${i}`;
      if (!(await claimIdempotency(tenantId, key))) continue;
      let sent;
      try {
        sent = await client.sendMessage(message.chat.id, parts[i]!, { businessConnectionId: biz.id });
      } catch (err) {
        if (isRetryable(err)) {
          await releaseIdempotency(tenantId, key);
        }
        throw err;
      }
      const s = sent[0];
      await prisma.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          tenantId,
          direction: 'OUTBOUND',
          role: 'AGENT',
          content: s?.text ?? parts[i]!,
          externalMessageId: s ? String(s.message_id) : `tgp:${update.update_id}:${i}`,
          metadata: { aiExecutionId: outcome.aiExecutionId ?? null, personal: true },
        },
      });
    }
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date(), agentId: agent.id },
    });
  }

  await markEvent(event.id, 'PROCESSED');
  log.info({ outcome: outcome.status }, 'personal-account message processed');
}

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
    .catch((err) => {
      childLogger({ module: 'telegram-handler' }).error(
        { err: errorMessage(err) },
        'failed to update webhook event status',
      );
    });
}
