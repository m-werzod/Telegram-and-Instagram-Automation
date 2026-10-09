import type { Agent, ChannelConnection, WebhookEvent } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { getPrisma } from '../../../db/client.js';
import { AppError, errorMessage, isRetryable } from '../../../lib/errors.js';
import { childLogger } from '../../../lib/logger.js';
import { findOrCreateLead } from '../../crm/service.js';
import { parseAgentSettings } from '../../engine/business-rules.js';
import { runAgentPipeline } from '../../engine/pipeline.js';
import { resolveManualAction } from '../../manual-actions/service.js';
import { getMediaAssetWithData } from '../../media/service.js';
import { claimIdempotency, releaseIdempotency } from '../shared/idempotency.js';
import {
  detectLanguage,
  reminderIsDue,
  UZBEK_ONLY_REPLY,
  VOICE_NOT_SUPPORTED_REPLY,
} from '../../engine/language.js';
import {
  isExcluded,
  markLanguageReminderSent,
  parseOwnerCommand,
  readConversationMetadata,
  sendStillAllowed,
  setConversationExcluded,
} from './exclusions.js';
import { getTelegramClient } from './service.js';
import {
  splitMessage,
  TELEGRAM_MAX_MESSAGE,
  type TelegramClient,
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
 * Keep "typing…" visible for as long as the agent is thinking.
 *
 * Telegram clears the indicator after ~5 s, and generation measured 12–32 s on
 * production traffic — so a single chatAction before a slow call shows nothing
 * by the time the reply lands. Worse, the handler used to send it AFTER
 * awaiting the pipeline, meaning the customer watched an idle chat for the
 * whole generation and read it as "nobody is there". This refreshes every 4 s
 * until stopped, so the chat behaves exactly like a person replying.
 *
 * Cosmetic by contract: every failure is swallowed — a missing typing bubble
 * must never cost a reply.
 */
function startTyping(
  client: TelegramClient,
  chatId: number | string,
  opts: { businessConnectionId?: string } = {},
): () => void {
  let stopped = false;
  const ping = (): void => {
    if (stopped) return;
    void client.sendChatAction(chatId, 'typing', opts).catch(() => undefined);
  };
  ping();
  const timer = setInterval(ping, 4_000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
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

  // Welcome image on /start (configured per agent in the dashboard).
  if (/^\/start\b/.test(message.text)) {
    const welcomeImageId = parseAgentSettings(agent).welcomeImageMediaId;
    if (welcomeImageId) {
      await sendAgentImage({
        client: getTelegramClient(connection),
        tenantId,
        conversationId: conversation.id,
        chatId: message.chat.id,
        imageAssetId: welcomeImageId,
        idemKey: `tg_welcome:${connection.id}:${update.update_id}`,
        log,
      });
    }
  }

  // Typing starts BEFORE generation, not after it — see startTyping().
  const stopTyping = startTyping(getTelegramClient(connection), message.chat.id);
  let outcome;
  try {
    outcome = await runAgentPipeline({
      tenantId,
      tenantName: tenant.name,
      agent,
      conversationId: conversation.id,
      lead,
      channelKey: 'telegram',
      inboundText: message.text!,
      username: message.from.username ?? null,
      requestId,
      sourceAccount: connection.displayName,
    });
  } finally {
    stopTyping();
  }

  if (outcome.status === 'failed') {
    // Retryable: the queue re-runs this event; sends below are idempotency-guarded.
    throw new AppError(outcome.error ?? 'agent pipeline failed', { retryable: true });
  }

  if (outcome.status === 'replied' && outcome.verdict?.reply) {
    const client = getTelegramClient(connection);
    if (outcome.verdict.stickerId) {
      await sendStickerSafely({
        client,
        chatId: message.chat.id,
        stickerId: outcome.verdict.stickerId,
        log,
      });
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
    // One optional image per reply, validated against the media library.
    if (outcome.verdict.imageId) {
      await sendAgentImage({
        client,
        tenantId,
        conversationId: conversation.id,
        chatId: message.chat.id,
        imageAssetId: outcome.verdict.imageId,
        idemKey: `tg_photo:${connection.id}:${update.update_id}`,
        aiExecutionId: outcome.aiExecutionId ?? null,
        log,
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

/**
 * Send one media-library image into a chat, idempotently. Non-retryable
 * failures are logged and swallowed (the text reply already went out);
 * retryable failures release the claim and propagate to the queue retry.
 */
async function sendAgentImage(params: {
  client: TelegramClient;
  tenantId: string;
  conversationId: string;
  chatId: number | string;
  imageAssetId: string;
  idemKey: string;
  businessConnectionId?: string;
  aiExecutionId?: string | null;
  log: ReturnType<typeof childLogger>;
}): Promise<void> {
  const prisma = getPrisma();
  if (!(await claimIdempotency(params.tenantId, params.idemKey))) return;

  const asset = await getMediaAssetWithData(params.tenantId, params.imageAssetId);
  if (!asset) {
    params.log.warn({ imageAssetId: params.imageAssetId }, 'image asset not found — skipping photo');
    return;
  }

  let sent;
  try {
    sent = await params.client.sendPhoto(
      params.chatId,
      {
        data: Buffer.from(asset.data),
        filename: `${asset.id}.${asset.mimeType.split('/')[1] ?? 'jpg'}`,
        contentType: asset.mimeType,
      },
      params.businessConnectionId ? { businessConnectionId: params.businessConnectionId } : {},
    );
  } catch (err) {
    if (isRetryable(err)) {
      await releaseIdempotency(params.tenantId, params.idemKey);
      throw err;
    }
    params.log.warn({ err: errorMessage(err) }, 'sendPhoto failed permanently — text reply already sent');
    return;
  }

  await prisma.conversationMessage.create({
    data: {
      conversationId: params.conversationId,
      tenantId: params.tenantId,
      direction: 'OUTBOUND',
      role: 'AGENT',
      content: `[rasm: ${asset.name}]`,
      externalMessageId: sent ? String(sent.message_id) : params.idemKey,
      metadata: {
        type: 'image',
        imageAssetId: asset.id,
        aiExecutionId: params.aiExecutionId ?? null,
      },
    },
  });
}

// ─────────────── Personal account (Telegram Business connection) ───────────────

/**
 * A person connected/edited/disconnected the bot on their PERSONAL account.
 * Each connection gets its own TelegramPersonalAccount row — multiple people
 * can hand their personal chats to this bot, each managed independently from
 * the dashboard (enable toggle, instructions, knowledge base).
 */
async function handleBusinessConnection(
  event: WebhookEvent,
  connection: ChannelConnection,
  bc: TgBusinessConnection,
): Promise<void> {
  const prisma = getPrisma();
  const stored = toStoredBusinessConnection(bc);
  const log = childLogger({ module: 'telegram-business', webhookEventId: event.id });

  await prisma.telegramPersonalAccount.upsert({
    where: { businessConnectionId: stored.id },
    create: {
      tenantId: connection.tenantId,
      businessConnectionId: stored.id,
      ownerUserId: String(stored.ownerId),
      ownerName: stored.ownerName,
      ownerUsername: stored.ownerUsername,
      userChatId: String(stored.userChatId),
      isEnabled: stored.isEnabled,
      canReply: stored.canReply,
      canReadMessages: stored.canReadMessages,
      connectedAt: new Date(stored.connectedAt * 1000),
      displayName: stored.ownerUsername ? `@${stored.ownerUsername}` : stored.ownerName,
      // enabled stays false: the admin must explicitly turn automation ON.
    },
    update: {
      ownerUserId: String(stored.ownerId),
      ownerName: stored.ownerName,
      ownerUsername: stored.ownerUsername,
      userChatId: String(stored.userChatId),
      isEnabled: stored.isEnabled,
      canReply: stored.canReply,
      canReadMessages: stored.canReadMessages,
    },
  });

  // Legacy single-connection mirror kept for the Connections health display.
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
      businessConnectionId: stored.id,
      isEnabled: stored.isEnabled,
      canReply: stored.canReply,
    },
    stored.isEnabled ? 'personal account connected' : 'personal account connection disabled',
  );
  await markEvent(event.id, 'PROCESSED');
}

/** A message in a private chat of one of the connected personal accounts. */
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

  if (!message.business_connection_id) {
    await markEvent(event.id, 'SKIPPED', 'business message without business_connection_id');
    return;
  }
  // Route to the connected personal account this message belongs to.
  let account = await prisma.telegramPersonalAccount.findUnique({
    where: { businessConnectionId: message.business_connection_id },
  });
  if (!account || account.tenantId !== tenantId) {
    // Connection predates the account table or state was lost — re-sync from
    // the live API so the account appears in the dashboard, still disabled.
    try {
      const bc = await getTelegramClient(connection).getBusinessConnection(
        message.business_connection_id,
      );
      const stored = toStoredBusinessConnection(bc);
      account = await prisma.telegramPersonalAccount.upsert({
        where: { businessConnectionId: stored.id },
        create: {
          tenantId,
          businessConnectionId: stored.id,
          ownerUserId: String(stored.ownerId),
          ownerName: stored.ownerName,
          ownerUsername: stored.ownerUsername,
          userChatId: String(stored.userChatId),
          isEnabled: stored.isEnabled,
          canReply: stored.canReply,
          canReadMessages: stored.canReadMessages,
          connectedAt: new Date(stored.connectedAt * 1000),
          displayName: stored.ownerUsername ? `@${stored.ownerUsername}` : stored.ownerName,
        },
        update: {},
      });
    } catch (err) {
      await markEvent(
        event.id,
        'SKIPPED',
        `unknown business connection (${errorMessage(err)}) — reconnect the personal account`,
      );
      return;
    }
  }

  if (!message.from || message.chat.type !== 'private') {
    await markEvent(event.id, 'SKIPPED', 'not a processable personal chat');
    return;
  }
  // Audio we do not transcribe. Silence here reads as a broken account, so
  // the customer is asked for text instead — never pretending the audio was
  // understood.
  const isUnsupportedAudio = Boolean(message.voice || message.audio || message.video_note);
  const inboundText = message.text ?? message.caption ?? '';
  if (!inboundText && !isUnsupportedAudio) {
    await markEvent(event.id, 'SKIPPED', 'message carries no text the agent can act on');
    return;
  }
  // The owner's own outgoing messages also arrive as business messages —
  // never treat the owner as a customer or auto-reply to them. But a command
  // the owner types in a chat IS addressed to us: /stop and /start are how
  // they exclude a conversation from automation, which is the supported
  // stand-in for "the chat is pinned" (see exclusions.ts for why the Bot API
  // cannot read pinned dialogs).
  if (String(message.from.id) === account.ownerUserId || message.from.is_bot) {
    const command = parseOwnerCommand(message.text);
    if (command && String(message.from.id) === account.ownerUserId) {
      const existing = await prisma.conversation.findUnique({
        where: {
          tenantId_kind_externalThreadId: {
            tenantId,
            kind: 'TELEGRAM_PERSONAL_CHAT',
            externalThreadId: `${account.businessConnectionId}:${message.chat.id}`,
          },
        },
      });
      if (existing) {
        await setConversationExcluded({
          tenantId,
          conversationId: existing.id,
          excluded: command === 'exclude',
          by: 'owner_command',
        });
      }
      await markEvent(
        event.id,
        'PROCESSED',
        command === 'exclude'
          ? 'owner excluded this chat from automation'
          : 'owner resumed automation for this chat',
      );
      return;
    }
    await markEvent(event.id, 'SKIPPED', 'message from the account owner (or a bot) — recorded only');
    return;
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    await markEvent(event.id, 'FAILED', 'tenant not found');
    return;
  }

  // Same TELEGRAM identity namespace as the bot flow: a person who messaged
  // both the bot and a connected personal account resolves to ONE lead.
  const fullName = [message.from.first_name, message.from.last_name].filter(Boolean).join(' ');
  const lead = await findOrCreateLead(
    tenantId,
    { channel: 'TELEGRAM', externalId: String(message.from.id), username: message.from.username ?? null },
    { name: fullName || null, source: 'TELEGRAM' },
  );

  // Thread id is scoped by the business connection: two connected accounts
  // chatting with the same customer must stay two separate conversations.
  const conversation = await prisma.conversation.upsert({
    where: {
      tenantId_kind_externalThreadId: {
        tenantId,
        kind: 'TELEGRAM_PERSONAL_CHAT',
        externalThreadId: `${account.businessConnectionId}:${message.chat.id}`,
      },
    },
    create: {
      tenantId,
      kind: 'TELEGRAM_PERSONAL_CHAT',
      channel: 'TELEGRAM',
      externalThreadId: `${account.businessConnectionId}:${message.chat.id}`,
      leadId: lead.id,
      lastMessageAt: new Date(),
      metadata: {
        businessConnectionId: account.businessConnectionId,
        personalAccount: account.displayName || account.ownerName,
      },
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
        content: inboundText || '[ovozli xabar]',
        externalMessageId: String(message.message_id),
        metadata: { updateId: update.update_id, personal: true, voice: isUnsupportedAudio },
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
  if (!account.enabled) {
    await markEvent(
      event.id,
      'SKIPPED',
      `automation for ${account.displayName || account.ownerName} is OFF — enable it on the Telegram page`,
    );
    return;
  }
  if (!account.isEnabled) {
    await markEvent(event.id, 'SKIPPED', 'business connection disabled by the account owner');
    return;
  }
  if (!account.canReply) {
    await markEvent(event.id, 'SKIPPED', 'owner did not grant the "reply to messages" permission');
    return;
  }
  // can_reply only covers chats with incoming messages in the last 24 hours —
  // stale/retried events must not attempt a send (message.date is unix seconds).
  if (message.date && Date.now() / 1000 - message.date > 23.5 * 3600) {
    await markEvent(event.id, 'SKIPPED', 'message older than the 24h business reply window');
    return;
  }

  // ── Gate 1: is this chat excluded from automation? ──────────────────────
  // The owner's /stop marks a chat; this is the supported stand-in for "the
  // owner pinned it", which the Bot API cannot report. Checked here so the
  // model is never even called, and again just before the send.
  if (isExcluded(conversation.metadata)) {
    await markEvent(event.id, 'SKIPPED', 'chat excluded from automation by the owner (/stop)');
    return;
  }

  // ── Gate 2: can the agent act on this message at all? ───────────────────
  // Audio first — an unsupported attachment is not a language question.
  const client = getTelegramClient(connection);
  if (isUnsupportedAudio && !inboundText) {
    if (await sendStillAllowed(conversation.id)) {
      await client.sendMessage(message.chat.id, VOICE_NOT_SUPPORTED_REPLY, {
        businessConnectionId: account.businessConnectionId,
      });
      await recordOutbound(tenantId, conversation.id, VOICE_NOT_SUPPORTED_REPLY, 'voice_unsupported');
    }
    await markEvent(event.id, 'PROCESSED', 'voice message — asked the customer to write in Uzbek');
    return;
  }

  // Uzbek-only policy. Only a CONFIDENT non-Uzbek verdict interrupts;
  // anything short of that is answered normally, because nagging someone who
  // did write Uzbek is worse than answering a stray English word.
  const language = detectLanguage(inboundText);
  if (language.verdict === 'other') {
    const meta = readConversationMetadata(conversation.metadata);
    if (reminderIsDue(meta.languageReminderAt)) {
      if (await sendStillAllowed(conversation.id)) {
        await client.sendMessage(message.chat.id, UZBEK_ONLY_REPLY, {
          businessConnectionId: account.businessConnectionId,
        });
        await recordOutbound(tenantId, conversation.id, UZBEK_ONLY_REPLY, 'language_reminder');
        await markLanguageReminderSent(conversation.id);
      }
      await markEvent(event.id, 'PROCESSED', `non-Uzbek message (${language.reason}) — reminder sent`);
    } else {
      await markEvent(event.id, 'SKIPPED', 'non-Uzbek message — reminder already sent recently');
    }
    return;
  }

  // Per-account overrides: instructions and knowledge base fall back to the
  // TELEGRAM_PERSONAL agent defaults when not set for this account.
  const effectiveAgent: Agent = {
    ...agent,
    systemInstructions: account.instructions?.trim() ? account.instructions : agent.systemInstructions,
    knowledgeBaseId: account.knowledgeBaseId ?? agent.knowledgeBaseId,
  };

  // The owner's account must look like the owner is typing — from the moment
  // the message arrives, not once the model is done.
  const stopTyping = startTyping(getTelegramClient(connection), message.chat.id, {
    businessConnectionId: account.businessConnectionId,
  });
  let outcome;
  try {
    outcome = await runAgentPipeline({
      tenantId,
      tenantName: tenant.name,
      agent: effectiveAgent,
      conversationId: conversation.id,
      lead,
      channelKey: 'telegram_personal',
      inboundText,
      username: message.from.username ?? null,
      requestId,
      sourceAccount: account.displayName || account.ownerName,
    });
  } finally {
    stopTyping();
  }

  if (outcome.status === 'failed') {
    throw new AppError(outcome.error ?? 'agent pipeline failed', { retryable: true });
  }

  if (outcome.status === 'replied' && outcome.verdict?.reply) {
    // ── Gate 3: the chat may have been excluded WHILE the model was running.
    // This is the window the requirement exists to close: generation takes
    // seconds, and a reply that lands after the owner said /stop is exactly
    // the message that must never be sent. Re-read, and stay silent if the
    // state cannot be confirmed.
    if (!(await sendStillAllowed(conversation.id))) {
      await markEvent(event.id, 'SKIPPED', 'chat excluded while the reply was being generated');
      log.info('reply withheld — chat excluded during generation');
      return;
    }
    const bcId = account.businessConnectionId;
    if (outcome.verdict.stickerId) {
      await sendStickerSafely({
        client,
        chatId: message.chat.id,
        stickerId: outcome.verdict.stickerId,
        businessConnectionId: bcId,
        log,
      });
    }
    const parts = splitMessage(outcome.verdict.reply, TELEGRAM_MAX_MESSAGE);
    for (let i = 0; i < parts.length; i++) {
      const key = `tg_personal_reply:${connection.id}:${update.update_id}:${i}`;
      if (!(await claimIdempotency(tenantId, key))) continue;
      let sent;
      try {
        sent = await client.sendMessage(message.chat.id, parts[i]!, { businessConnectionId: bcId });
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
    if (outcome.verdict.imageId) {
      await sendAgentImage({
        client,
        tenantId,
        conversationId: conversation.id,
        chatId: message.chat.id,
        imageAssetId: outcome.verdict.imageId,
        idemKey: `tg_personal_photo:${connection.id}:${update.update_id}`,
        businessConnectionId: bcId,
        aiExecutionId: outcome.aiExecutionId ?? null,
        log,
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

/**
 * Record a reply the platform sent WITHOUT the agent — a language reminder or
 * a voice fallback. These are outbound messages like any other and belong in
 * the conversation, or the transcript shows the customer talking to nobody.
 */
/**
 * Send the configured sticker for this turn, before the text so it reads as a
 * reaction rather than an afterthought.
 *
 * Entirely best effort. A sticker file id can be revoked, belong to a pack
 * the account cannot access, or simply be wrong — none of which is worth
 * losing the answer over, so every failure is swallowed and logged. Price
 * facts always live in the text, never in the sticker.
 */
async function sendStickerSafely(params: {
  client: TelegramClient;
  chatId: number;
  stickerId: string;
  businessConnectionId?: string;
  log: ReturnType<typeof childLogger>;
}): Promise<void> {
  try {
    await params.client.sendSticker(params.chatId, params.stickerId, {
      ...(params.businessConnectionId ? { businessConnectionId: params.businessConnectionId } : {}),
    });
  } catch (err) {
    params.log.warn(
      { err: errorMessage(err), stickerId: params.stickerId },
      'sticker rejected by Telegram — sending the text only',
    );
  }
}

async function recordOutbound(
  tenantId: string,
  conversationId: string,
  content: string,
  kind: 'language_reminder' | 'voice_unsupported',
): Promise<void> {
  await getPrisma()
    .conversationMessage.create({
      data: {
        conversationId,
        tenantId,
        direction: 'OUTBOUND',
        role: 'SYSTEM',
        content,
        metadata: { policy: kind },
      },
    })
    .catch(() => undefined);
  await getPrisma()
    .conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } })
    .catch(() => undefined);
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
