import type { ChannelConnection } from '@prisma/client';
import { getPrisma } from '../../../db/client.js';
import { getEnv } from '../../../config/env.js';
import { decryptSecret, encryptSecret, generateToken } from '../../../lib/crypto.js';
import { ValidationError, errorMessage } from '../../../lib/errors.js';
import { childLogger } from '../../../lib/logger.js';
import { upsertManualAction, resolveManualAction } from '../../manual-actions/service.js';
import { TelegramClient } from './client.js';

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

  // 2. Persist (encrypted at rest).
  const credentialsEncrypted = encryptSecret(JSON.stringify({ botToken: token }), env.ENCRYPTION_KEY);
  const webhookSecret = generateToken(32).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128) || generateToken(24);

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
      metadata: { botUsername: me.username ?? null, botName: me.first_name },
    },
    update: {
      status: 'connected',
      displayName: me.username ? `@${me.username}` : me.first_name,
      externalAccountId: String(me.id),
      credentialsEncrypted,
      webhookSecret,
      metadata: { botUsername: me.username ?? null, botName: me.first_name },
    },
  });

  // 3. Automatic webhook configuration when a public HTTPS URL is available.
  await configureTelegramWebhook(connection.id);

  // 4. Register the /start command description (best effort).
  try {
    await client.setMyCommands([{ command: 'start', description: 'Start a conversation' }]);
  } catch (err) {
    log.warn({ err: errorMessage(err) }, 'setMyCommands failed (non-fatal)');
  }

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
    await upsertManualAction(connection.tenantId, {
      dedupKey: 'telegram-webhook-https',
      platform: 'Infrastructure',
      title: 'Expose the platform on a public HTTPS URL so Telegram can deliver webhooks',
      officialUrl: 'https://core.telegram.org/bots/api#setwebhook',
      steps: [
        'Deploy this application to a server with a public HTTPS URL (valid TLS certificate; Telegram supports ports 443, 80, 88, 8443), or start a tunnel during development (e.g. `ngrok http 3000` / `cloudflared tunnel --url http://localhost:3000`).',
        'Set APP_URL in the .env file to that HTTPS base URL (e.g. APP_URL=https://your-domain.com).',
        'Restart the server.',
        'In the dashboard, open Connections → Telegram and press "Reconfigure webhook" (or reconnect the bot).',
      ],
      expectedResult:
        'The Telegram connection health becomes CONNECTED and getWebhookInfo shows your URL with no last_error_message.',
      whatToReturn: 'The HTTPS URL you deployed to, and the health status shown in the dashboard.',
    });
    await prisma.channelConnection.update({
      where: { id: connection.id },
      data: {
        healthStatus: 'WEBHOOK_ERROR',
        healthDetail: 'APP_URL is not a public HTTPS URL — webhook not configured. See Manual Actions.',
        lastHealthCheckAt: new Date(),
      },
    });
    log.warn('APP_URL missing or not https — created manual action for webhook exposure');
    return;
  }

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
      metadata: { ...(connection.metadata as object), webhookUrl },
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
    const expected = (connection.metadata as { webhookUrl?: string }).webhookUrl;
    if (!info.url) return { status: 'WEBHOOK_ERROR', detail: 'No webhook is configured on this bot' };
    if (expected && info.url !== expected) {
      return { status: 'WEBHOOK_ERROR', detail: `Webhook points elsewhere: ${info.url}` };
    }
    if (info.last_error_date && Date.now() / 1000 - info.last_error_date < 3600) {
      return {
        status: 'DEGRADED',
        detail: `Recent delivery error: ${info.last_error_message ?? 'unknown'} (pending: ${info.pending_update_count})`,
      };
    }
    return { status: 'CONNECTED', detail: `pending updates: ${info.pending_update_count}` };
  } catch (err) {
    return { status: 'DEGRADED', detail: `getWebhookInfo failed: ${errorMessage(err)}` };
  }
}
