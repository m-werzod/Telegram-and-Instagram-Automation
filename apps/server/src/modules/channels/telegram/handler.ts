import type { WebhookEvent } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { getPrisma } from '../../../db/client.js';
import { AppError, errorMessage, isRetryable } from '../../../lib/errors.js';
import { childLogger } from '../../../lib/logger.js';
import { findOrCreateLead } from '../../crm/service.js';
import { runAgentPipeline } from '../../engine/pipeline.js';
import { claimIdempotency, releaseIdempotency } from '../shared/idempotency.js';
import { getTelegramClient } from './service.js';
import { splitMessage, TELEGRAM_MAX_MESSAGE, type TgUpdate } from './client.js';

/**
 * Telegram event processing (spec §14): update → lead → conversation →
 * persist inbound → agent pipeline → send reply → persist outbound.
 * The event row is already persisted & deduplicated by update_id.
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
