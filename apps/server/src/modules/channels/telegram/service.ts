import type { ChannelConnection, Prisma } from '@prisma/client';
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

/**
 * Self-probe: does APP_URL actually route back to THIS server from the
 * public internet? A syntactically valid https:// URL is not proof of
 * reachability — NAT, a shared-IP provider gateway (e.g. Traefik routing by
 * registered hostname), or a firewall can all accept the TCP connection and
 * return a plausible-looking response (even a 404) from something that is
 * NOT this application. Hitting our own /api/health and checking its exact,
 * distinctive JSON shape is a cheap, reliable way to tell "reached us" apart
 * from "reached someone else at that IP" — a generic 404 cannot fake it.
 */
async function isPubliclyReachable(appUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${appUrl.replace(/\/$/, '')}/api/health`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { status?: string; db?: string } | null;
    return typeof body?.status === 'string' && typeof body?.db === 'string';
  } catch {
    return false;
  }
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

  // 4. Apply the bot profile the dashboard owns (Uzbek-first defaults on a
  //    first connect). Per-field best effort — nothing here can fail connect.
  await applyTelegramProfile(connection, readTelegramProfile(connection));

  // The Bot API cannot set a bot's own avatar — only @BotFather can.
  const botHandleForAvatar = me.username ? `@${me.username}` : 'your bot';
  await upsertManualAction(tenantId, {
    dedupKey: 'telegram-bot-avatar',
    platform: 'Telegram',
    title: "Set the bot's profile photo (logo) in @BotFather",
    officialUrl: 'https://core.telegram.org/bots/features#botfather',
    steps: [
      'The Telegram Bot API has no method for a bot to change its own profile photo, so this one step cannot be automated.',
      'Open Telegram → @BotFather → /mybots → select ' + botHandleForAvatar + ' → Edit Bot → Edit Botpic.',
      'Send the Avtomaktab Turon logo as a PHOTO (square, at least 512×512 px). The dashboard serves the same artwork at /logo.png (1024×1024) if you need a copy.',
      'Everything else about the bot (name, descriptions, command menu) is controlled from the dashboard: Telegram → "Bot brendingi".',
    ],
    expectedResult: "The bot's avatar in Telegram shows the Avtomaktab Turon logo.",
    whatToReturn: 'Nothing — mark this task done once the photo is visible in Telegram.',
  });

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
  const syntacticallyUsable = appUrl && appUrl.startsWith('https://');
  const usableUrl = syntacticallyUsable && (await isPubliclyReachable(appUrl));
  if (syntacticallyUsable && !usableUrl) {
    log.warn(
      { appUrl },
      'APP_URL is syntactically valid but not actually reachable from the public internet (self-probe failed) — falling back to polling',
    );
  }

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
        syntacticallyUsable
          ? `APP_URL (${appUrl}) is set but did not answer a self-check — the request never reached this server. On a shared-IP VPS this usually means ports 80/443 are not yet routed to this machine at the hosting provider's network level (a provider panel setting, not something this app controls). Fix the routing, then press "Reconfigure webhook" here.`
          : 'Set APP_URL in the .env file to a public HTTPS base URL (e.g. APP_URL=https://your-domain.com), restart the server, then press "Reconfigure webhook" on the Connections page.',
      ],
      expectedResult: 'The Telegram connection health shows "mode: webhook" with no last_error_message.',
      whatToReturn: 'Nothing — this is optional. Polling already works.',
    });
    await startPolling(connection);
    await prisma.channelConnection.update({
      where: { id: connection.id },
      data: {
        healthStatus: 'CONNECTED',
        healthDetail: syntacticallyUsable
          ? `Using long-polling — ${appUrl} did not answer a public reachability self-check, so webhook push is unavailable for now. Fully functional either way.`
          : 'Using long-polling (no public HTTPS URL configured) — fully functional.',
        lastHealthCheckAt: new Date(),
        metadata: { ...(connection.metadata as object), channelMode: 'polling' },
      },
    });
    log.info({ syntacticallyUsable }, 'public URL unusable — started long-polling fallback');
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

/**
 * How the bot presents itself in Telegram — name, the two description texts
 * and the command menu. Stored on the connection so the dashboard owns it
 * instead of the values being frozen into the code at connect time.
 *
 * The profile *photo* is deliberately absent: the Bot API has no method for a
 * bot to set its own avatar, that is @BotFather → /setuserpic only. A manual
 * action carries those steps.
 */
// A type alias, not an interface: Prisma's Json input types require an
// implicit index signature, which only type aliases get.
export type TelegramBotProfile = {
  name: string;
  shortDescription: string;
  description: string;
  commands: Array<{ command: string; description: string }>;
};

export const DEFAULT_BOT_PROFILE: TelegramBotProfile = {
  name: 'Turon Avtomaktab',
  shortDescription: "Turon Avtomaktab — kurslar, narxlar va ro'yxatdan o'tish bo'yicha 24/7 yordam.",
  description:
    "Assalomu alaykum! Men Turon Avtomaktabning yordamchisiman 🚗\n" +
    "Kurslar, toifalar (A, B, BC, C), narxlar, filiallar va hujjatlar bo'yicha savollaringizga javob beraman. " +
    "Boshlash uchun /start tugmasini bosing.",
  commands: [
    { command: 'start', description: 'Suhbatni boshlash / Start' },
    { command: 'yordam', description: "Yordam va ma'lumot" },
  ],
};

export function readTelegramProfile(connection: ChannelConnection): TelegramBotProfile {
  const stored = (connection.metadata as { profile?: Partial<TelegramBotProfile> } | null)?.profile;
  return {
    name: stored?.name ?? DEFAULT_BOT_PROFILE.name,
    shortDescription: stored?.shortDescription ?? DEFAULT_BOT_PROFILE.shortDescription,
    description: stored?.description ?? DEFAULT_BOT_PROFILE.description,
    commands: stored?.commands?.length ? stored.commands : DEFAULT_BOT_PROFILE.commands,
  };
}

/**
 * Pushes the profile to Telegram and stores what was pushed. Each field is
 * applied independently: Telegram rejects a name change more than twice an
 * hour, and one rejected field must not block the others.
 */
export async function applyTelegramProfile(
  connection: ChannelConnection,
  profile: TelegramBotProfile,
): Promise<{ profile: TelegramBotProfile; results: Array<{ field: string; ok: boolean; error?: string }> }> {
  const client = getTelegramClient(connection);
  const log = childLogger({ module: 'telegram', tenantId: connection.tenantId });
  const results: Array<{ field: string; ok: boolean; error?: string }> = [];

  const apply = async (field: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      results.push({ field, ok: true });
    } catch (err) {
      results.push({ field, ok: false, error: errorMessage(err) });
      log.warn({ field, err: errorMessage(err) }, 'telegram profile field rejected');
    }
  };

  await apply('name', () => client.setMyName(profile.name));
  await apply('shortDescription', () => client.setMyShortDescription(profile.shortDescription));
  await apply('description', () => client.setMyDescription(profile.description));
  await apply('commands', () => client.setMyCommands(profile.commands));

  await getPrisma().channelConnection.update({
    where: { id: connection.id },
    data: { metadata: { ...(connection.metadata as object), profile } as Prisma.InputJsonObject },
  });

  return { profile, results };
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
