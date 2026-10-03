import type { ChannelConnection } from '@prisma/client';
import { getPrisma } from '../../../db/client.js';
import { getEnv } from '../../../config/env.js';
import { decryptSecret, encryptSecret, generateToken } from '../../../lib/crypto.js';
import { ValidationError, errorMessage } from '../../../lib/errors.js';
import { childLogger } from '../../../lib/logger.js';
import { upsertManualAction, resolveManualAction } from '../../manual-actions/service.js';
import { TelegramClient } from './client.js';
import { isPolling, startPolling, stopPolling } from './polling.js';

/**
 * Telegram connection lifecycle (spec §14–15): validate token → store encrypted
 * → configure webhook automatically → verify → surface a structured manual
 * action for anything that cannot be automated.
 */

interface TelegramCredentials {
  botToken: string;
}

export function telegramWebhookPath(connectionId: string): string {
  return `/api/webhooks/telegram/${connectionId}`;
}

export function getTelegramClient(connection: ChannelConnection): TelegramClient {
  const env = getEnv();
  const creds = JSON.parse(decryptSecret(connection.credentialsEncrypted, env.ENCRYPTION_KEY)) as TelegramCredentials;
  return new TelegramClient(creds.botToken);
}

export async function connectTelegram(tenantId: string, botToken: string): Promise<ChannelConnection> {
  const env = getEnv();
  const prisma = getPrisma();
  const log = childLogger({ module: 'telegram', tenantId });

  const token = botToken.trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new ValidationError('That does not look like a Telegram bot token (expected "<id>:<secret>" from @BotFather)');
  }

  // 1. Validate the token against the live API.
  const client = new TelegramClient(token);
  const me = await client.getMe();
  if (!me.is_bot) throw new ValidationError('Token does not belong to a bot');

  // 2. Persist (encrypted at rest). A reconnect must not wipe the stored
  //    business-connection state of the personal account.
  const credentialsEncrypted = encryptSecret(JSON.stringify({ botToken: token }), env.ENCRYPTION_KEY);
  const webhookSecret = generateToken(32).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128) || generateToken(24);

  const existing = await prisma.channelConnection.findUnique({
    where: { tenantId_channel: { tenantId, channel: 'TELEGRAM' } },
  });
  const metadata = {
    ...((existing?.metadata as object) ?? {}),
    botUsername: me.username ?? null,
    botName: me.first_name,
  };

  const connection = await prisma.channelConnection.upsert({
    where: { tenantId_channel: { tenantId, channel: 'TELEGRAM' } },
    create: {
      tenantId,
      channel: 'TELEGRAM',
      status: 'connected',
      displayName: me.username ? `@${me.username}` : me.first_name,
      externalAccountId: String(me.id),
      credentialsEncrypted,
      webhookSecret,
      metadata,
    },
    update: {
      status: 'connected',
      displayName: me.username ? `@${me.username}` : me.first_name,
      externalAccountId: String(me.id),
      credentialsEncrypted,
      webhookSecret,
      metadata,
    },
  });

  // 3. Automatic webhook configuration when a public HTTPS URL is available.
  await configureTelegramWebhook(connection.id);

  // 4. Register commands and bot profile texts (best effort, Uzbek-first).
  try {
    await client.setMyCommands([
      { command: 'start', description: "Suhbatni boshlash / Start" },
      { command: 'yordam', description: "Yordam va ma'lumot" },
    ]);
  } catch (err) {
    log.warn({ err: errorMessage(err) }, 'setMyCommands failed (non-fatal)');
  }

  // 5. Personal-account automation (Telegram Business connection): the owner
  //    performs the in-app connection themselves; the platform detects it
  //    automatically and resolves this action.
  const botHandle = me.username ? `@${me.username}` : 'your bot';
  await upsertManualAction(tenantId, {
    dedupKey: 'telegram-business-connect',
    platform: 'Telegram',
    title: 'Connect the bot to your PERSONAL Telegram account (Chat Automation)',
    officialUrl: 'https://core.telegram.org/bots/features#business-bots',
    steps: [
      `Enable business mode on the bot: in Telegram open @BotFather → send /mybots → select ${botHandle} → Bot Settings → Business Mode (a.k.a. Secretary Mode) → Turn on.`,
      'On the phone with YOUR PERSONAL account: open Telegram → Settings → "Chat Automation" (on accounts with Telegram Business/Premium the same screen is under Settings → Telegram Business → Chatbots).',
      `Select ${botHandle} as the connected bot.`,
      'Choose which chats the bot may access (e.g. exclude contacts, or only new chats) — the agent will only ever see the chats you include here.',
      'Grant the "Reply to messages" permission (can_reply). Do NOT grant profile/gifts/Stars permissions — the platform does not use them.',
      'Consent note (Telegram Bot Developer Terms §5.4): by connecting and enabling the Telegram Personal Account Agent you authorize this platform to process messages from the selected chats with its AI provider (Anthropic) solely to generate replies on your behalf. Message contents are stored in your own CRM database and are never used for AI training.',
    ],
    expectedResult:
      'The platform detects the connection automatically (this task resolves itself) and the Connections page shows "Personal account: connected". Incoming messages in the selected chats then flow to the Telegram Personal Account Agent — it stays OFF until you enable it under Agents.',
    whatToReturn: 'Nothing — the dashboard updates by itself. If it does not within a minute, check that Business Mode was enabled in @BotFather first.',
  });

  return (await prisma.channelConnection.findUnique({ where: { id: connection.id } }))!;
}

/** (Re)configure the webhook and update health. Safe to call repeatedly. */
export async function configureTelegramWebhook(connectionId: string): Promise<void> {
  const env = getEnv();
  const prisma = getPrisma();
  const connection = await prisma.channelConnection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.channel !== 'TELEGRAM') throw new ValidationError('Telegram connection not found');
  const log = childLogger({ module: 'telegram', tenantId: connection.tenantId, connectionId });

  const appUrl = env.APP_URL;
  const usableUrl = appUrl && appUrl.startsWith('https://');

  if (!usableUrl) {
    // No reachable public HTTPS URL — fall back to long-polling (Bot API
    // getUpdates), a fully supported Telegram transport that needs no
    // inbound ports at all. The platform stays fully functional; webhook
    // push (lower latency) remains available the moment APP_URL is fixed.
    await upsertManualAction(connection.tenantId, {
      dedupKey: 'telegram-webhook-https',
      platform: 'Infrastructure',
      title: 'Optional: expose the platform on a public HTTPS URL for Telegram webhook push',
      officialUrl: 'https://core.telegram.org/bots/api#setwebhook',
      steps: [
        'Not required — the bot is already working via long-polling (no public URL needed).',
        'Webhook push gives slightly lower latency and less server load at high volume. To switch to it: deploy with a public HTTPS URL (valid TLS certificate; Telegram supports ports 443, 80, 88, 8443) or a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`).',
        'Set APP_URL in the .env file to that HTTPS base URL (e.g. APP_URL=https://your-domain.com), restart the server, then press "Reconfigure webhook" on the Connections page.',
      ],
      expectedResult: 'The Telegram connection health shows "webhook" mode with no last_error_message.',
      whatToReturn: 'Nothing — this is optional. Polling already works.',
    });
    await startPolling(connection);
    await prisma.channelConnection.update({
      where: { id: connection.id },
      data: {
        healthStatus: 'CONNECTED',
        healthDetail: 'Using long-polling (no public HTTPS URL configured) — fully functional.',
        lastHealthCheckAt: new Date(),
        metadata: { ...(connection.metadata as object), channelMode: 'polling' },
      },
    });
    log.info('APP_URL not public HTTPS — started long-polling fallback');
    return;
  }

  // A usable public URL exists — prefer webhook push; stop any polling loop
  // first so the same update is never processed through both transports.
  await stopPolling(connection.id);

  const client = getTelegramClient(connection);
  const webhookUrl = `${appUrl.replace(/\/$/, '')}${telegramWebhookPath(connection.id)}`;
  await client.setWebhook({ url: webhookUrl, secretToken: connection.webhookSecret });

  const info = await client.getWebhookInfo();
  const healthy = info.url === webhookUrl;
  await prisma.channelConnection.update({
    where: { id: connection.id },
    data: {
      healthStatus: healthy ? 'CONNECTED' : 'WEBHOOK_ERROR',
      healthDetail: healthy
        ? ''
        : `getWebhookInfo returned url="${info.url}" (expected ${webhookUrl})`,
      lastHealthCheckAt: new Date(),
      metadata: { ...(connection.metadata as object), webhookUrl, channelMode: 'webhook' },
    },
  });
  if (healthy) {
    await resolveManualAction(connection.tenantId, 'telegram-webhook-https');
  }
  log.info({ webhookUrl, healthy }, 'telegram webhook configured');
}

export async function disconnectTelegram(tenantId: string): Promise<void> {
  const prisma = getPrisma();
  const connection = await prisma.channelConnection.findUnique({
    where: { tenantId_channel: { tenantId, channel: 'TELEGRAM' } },
  });
  if (!connection) return;
  await stopPolling(connection.id);
  try {
    await getTelegramClient(connection).deleteWebhook();
  } catch (err) {
    childLogger({ module: 'telegram', tenantId }).warn(
      { err: errorMessage(err) },
      'deleteWebhook failed during disconnect (continuing)',
    );
  }
  await prisma.channelConnection.update({
    where: { id: connection.id },
    data: {
      status: 'disconnected',
      healthStatus: 'DISCONNECTED',
      healthDetail: '',
      credentialsEncrypted: '',
      webhookSecret: '',
    },
  });
}

/** Live health check (spec §27): actually calls the API, no fake "connected". */
export async function checkTelegramHealth(connection: ChannelConnection): Promise<{
  status: 'CONNECTED' | 'DEGRADED' | 'AUTH_REQUIRED' | 'WEBHOOK_ERROR' | 'DISCONNECTED';
  detail: string;
}> {
  if (connection.status !== 'connected' || !connection.credentialsEncrypted) {
    return { status: 'DISCONNECTED', detail: 'Not connected' };
  }
  const client = getTelegramClient(connection);
  try {
    await client.getMe();
  } catch (err) {
    return { status: 'AUTH_REQUIRED', detail: `Token invalid: ${errorMessage(err)}` };
  }
  try {
    const info = await client.getWebhookInfo();
    const meta = connection.metadata as {
      webhookUrl?: string;
      channelMode?: 'polling' | 'webhook';
      businessConnection?: { id: string; ownerUsername?: string | null; ownerName?: string };
    };
    const polling = meta.channelMode === 'polling' || isPolling(connection.id);
    if (!info.url && !polling) {
      return { status: 'WEBHOOK_ERROR', detail: 'No webhook is configured and polling is not running' };
    }
    if (!polling) {
      if (meta.webhookUrl && info.url !== meta.webhookUrl) {
        return { status: 'WEBHOOK_ERROR', detail: `Webhook points elsewhere: ${info.url}` };
      }
      if (info.last_error_date && Date.now() / 1000 - info.last_error_date < 3600) {
        return {
          status: 'DEGRADED',
          detail: `Recent delivery error: ${info.last_error_message ?? 'unknown'} (pending: ${info.pending_update_count})`,
        };
      }
    }

    // Personal accounts (Telegram Business connections): live-verify and refresh.
    let personalDetail = 'personal accounts: none connected';
    const accounts = await getPrisma().telegramPersonalAccount.findMany({
      where: { tenantId: connection.tenantId },
      orderBy: { createdAt: 'asc' },
    });
    if (accounts.length > 0) {
      const summaries: string[] = [];
      for (const account of accounts) {
        try {
          const bc = await client.getBusinessConnection(account.businessConnectionId);
          const { toStoredBusinessConnection } = await import('./handler.js');
          const stored = toStoredBusinessConnection(bc);
          await getPrisma().telegramPersonalAccount.update({
            where: { id: account.id },
            data: {
              isEnabled: stored.isEnabled,
              canReply: stored.canReply,
              canReadMessages: stored.canReadMessages,
              ownerName: stored.ownerName,
              ownerUsername: stored.ownerUsername,
            },
          });
          const owner = stored.ownerUsername ? `@${stored.ownerUsername}` : stored.ownerName;
          summaries.push(
            !stored.isEnabled
              ? `${owner}: disconnected by owner`
              : !stored.canReply
                ? `${owner}: READ-ONLY (grant "reply to messages")`
                : `${owner}: ${account.enabled ? 'automation ON' : 'automation OFF'}`,
          );
        } catch (err) {
          summaries.push(`${account.displayName || account.ownerName}: check failed (${errorMessage(err)})`);
        }
      }
      personalDetail = `personal accounts (${accounts.length}): ${summaries.join('; ')}`;
    } else if (meta.businessConnection?.id) {
      personalDetail = 'personal account: legacy connection — reconnect it in Telegram to manage it here';
    }

    return {
      status: 'CONNECTED',
      detail: polling
        ? `mode: long-polling (no public URL needed); ${personalDetail}`
        : `mode: webhook; pending updates: ${info.pending_update_count}; ${personalDetail}`,
    };
  } catch (err) {
    return { status: 'DEGRADED', detail: `getWebhookInfo failed: ${errorMessage(err)}` };
  }
}
