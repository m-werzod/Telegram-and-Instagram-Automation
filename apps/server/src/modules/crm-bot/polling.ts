import { getPrisma } from '../../db/client.js';
import { getEnv } from '../../config/env.js';
import { childLogger } from '../../lib/logger.js';
import { TelegramClient } from '../channels/telegram/client.js';
import { handleCrmBotUpdate } from './handler.js';

/**
 * The CRM bot's own long-polling loop.
 *
 * Separate from the automation bot's transport on purpose: it is a different
 * bot with a different token, and a staff tool going quiet must never be able
 * to interfere with the customer-facing one. Polling rather than a webhook
 * because it needs no public URL and no registration — the same reason the
 * automation bot runs on it today.
 *
 * Updates are processed one at a time, in order. Volume here is a handful of
 * button presses from a few staff, so there is nothing to gain from
 * concurrency and an ordered menu is easier to reason about.
 */

const POLL_TIMEOUT_SECONDS = 30;
const RESTART_DELAY_MS = 5_000;

let running = false;
let stopping = false;
let client: TelegramClient | null = null;

export function getCrmBotClient(): TelegramClient | null {
  return client;
}

export function isCrmBotRunning(): boolean {
  return running;
}

/** Token from the environment; the dashboard setting can override later. */
export function crmBotToken(): string | null {
  return getEnv().TELEGRAM_CRM_BOT_TOKEN ?? null;
}

export async function startCrmBot(): Promise<void> {
  const log = childLogger({ module: 'crm-bot' });
  const token = crmBotToken();
  if (!token) {
    log.info('TELEGRAM_CRM_BOT_TOKEN not set — CRM bot disabled');
    return;
  }
  if (running) return;

  client = new TelegramClient(token);
  let me;
  try {
    me = await client.getMe();
  } catch (err) {
    log.error({ err: String(err) }, 'CRM bot token rejected — not starting');
    client = null;
    return;
  }

  // The CRM bot must never run both transports. A webhook left over from an
  // earlier setup would swallow the updates this loop is waiting for.
  await client.deleteWebhook().catch(() => undefined);
  await client
    .setMyCommands([
      { command: 'start', description: 'Kirish / menyu' },
      { command: 'logout', description: 'Chiqish' },
    ])
    .catch(() => undefined);

  const tenant = await getPrisma().tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) {
    log.error('no tenant — CRM bot not started');
    client = null;
    return;
  }

  running = true;
  stopping = false;
  log.info({ bot: me.username, tenant: tenant.name }, 'CRM bot started (long-polling)');
  void loop(tenant.id, token);
}

async function loop(tenantId: string, token: string): Promise<void> {
  const log = childLogger({ module: 'crm-bot', tenantId });
  let offset: number | undefined;

  while (!stopping) {
    try {
      const updates = await client!.getUpdates({
        offset,
        timeout: POLL_TIMEOUT_SECONDS,
        allowedUpdates: ['message', 'callback_query'],
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleCrmBotUpdate({ tenantId, client: client!, update });
        } catch (err) {
          // One bad update must not end the loop: the next person pressing a
          // button would find a dead bot with nothing in the logs to explain it.
          log.warn({ err: String(err), updateId: update.update_id }, 'crm bot update failed');
        }
      }
    } catch (err) {
      if (stopping) break;
      log.warn({ err: String(err) }, 'crm bot poll failed — retrying');
      await new Promise((r) => setTimeout(r, RESTART_DELAY_MS));
      // Recreate the client in case the failure was a dead socket.
      client = new TelegramClient(token);
    }
  }
  running = false;
  log.info('CRM bot polling stopped');
}

export async function stopCrmBot(): Promise<void> {
  stopping = true;
  running = false;
  client = null;
}
