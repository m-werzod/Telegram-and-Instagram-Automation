import type { ChannelConnection } from '@prisma/client';
import { getPrisma } from '../../../db/client.js';
import { errorMessage } from '../../../lib/errors.js';
import { childLogger } from '../../../lib/logger.js';
import { recordAndEnqueueEvent } from '../../webhooks/service.js';
import { getTelegramClient } from './service.js';
import type { TgUpdate } from './client.js';

/**
 * Long-polling fallback for Telegram (Bot API getUpdates) — a fully
 * Telegram-supported alternative to webhooks for deployments that have no
 * reachable public HTTPS URL (shared-IP VPS plans, NAT, local development).
 *
 * Each update is persisted through the SAME recordAndEnqueueEvent() call and
 * eventKey shape the webhook route uses, so the queue worker and every
 * downstream handler (processTelegramEvent, the agent pipeline, CRM, …) run
 * completely unchanged regardless of which transport delivered the update.
 * This also transparently covers Telegram Personal Account automation
 * (business_connection / business_message arrive on the same getUpdates
 * stream as regular bot updates — no separate mechanism needed).
 */

interface PollerHandle {
  stop: () => void;
  done: Promise<void>;
}

const activePollers = new Map<string, PollerHandle>();

export function isPolling(connectionId: string): boolean {
  return activePollers.has(connectionId);
}

/**
 * Record one batch of polled updates through the same path a webhook POST
 * uses, then return the next offset to acknowledge (undefined when the batch
 * was empty — the caller should not advance or persist anything). Exported
 * separately from the loop so the per-batch contract (eventKey shape, offset
 * arithmetic, one bad update not blocking the rest) is unit-testable without
 * driving the real long-poll/backoff loop.
 */
export async function processUpdatesBatch(
  connection: Pick<ChannelConnection, 'id' | 'tenantId' | 'externalAccountId'>,
  updates: TgUpdate[],
  log: ReturnType<typeof childLogger>,
): Promise<number | undefined> {
  if (updates.length === 0) return undefined;
  for (const update of updates) {
    try {
      await recordAndEnqueueEvent({
        channel: 'TELEGRAM',
        eventKey: `${connection.id}:${connection.externalAccountId}:${update.update_id}`,
        tenantId: connection.tenantId,
        payload: { connectionId: connection.id, update },
      });
    } catch (err) {
      // A persist failure here must not stop the offset from advancing past
      // this update (it would loop forever) — log and move on; the event is
      // simply lost, the same risk profile as a webhook POST that fails
      // after Telegram's own retry budget is exhausted.
      log.error({ err: errorMessage(err), updateId: update.update_id }, 'failed to record polled update');
    }
  }
  return Math.max(...updates.map((u) => u.update_id)) + 1;
}

/** Idempotent: a second call for the same connection is a no-op. */
export async function startPolling(connection: ChannelConnection): Promise<void> {
  if (activePollers.has(connection.id)) return;
  const log = childLogger({ module: 'telegram-polling', connectionId: connection.id });

  const client = getTelegramClient(connection);
  // getUpdates fails with 409 while a webhook is registered — clear it first.
  try {
    await client.deleteWebhook();
  } catch (err) {
    log.warn({ err: errorMessage(err) }, 'deleteWebhook before polling failed (continuing)');
  }

  let stopped = false;
  const stop = () => {
    stopped = true;
  };

  const loop = async (): Promise<void> => {
    const meta = connection.metadata as { pollingOffset?: number };
    let offset = meta.pollingOffset;
    let consecutiveErrors = 0;

    log.info({ offset }, 'telegram polling started');
    while (!stopped) {
      let updates;
      try {
        updates = await client.getUpdates({ offset, timeout: 25 });
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors++;
        log.warn({ err: errorMessage(err), consecutiveErrors }, 'getUpdates failed — retrying');
        // Exponential-ish backoff capped at 30s so a persistent outage doesn't
        // tight-loop against Telegram's API.
        await sleep(Math.min(30_000, 1000 * 2 ** Math.min(consecutiveErrors, 5)));
        continue;
      }

      if (stopped) break;

      const nextOffset = await processUpdatesBatch(connection, updates, log);
      if (nextOffset === undefined) continue; // long-poll timed out with nothing new

      offset = nextOffset;
      await getPrisma()
        .channelConnection.update({
          where: { id: connection.id },
          data: { metadata: { ...meta, pollingOffset: offset, channelMode: 'polling' } },
        })
        .catch((err) => log.warn({ err: errorMessage(err) }, 'failed to persist polling offset'));
    }
    log.info('telegram polling stopped');
  };

  activePollers.set(connection.id, { stop, done: loop() });
}

export async function stopPolling(connectionId: string): Promise<void> {
  const handle = activePollers.get(connectionId);
  if (!handle) return;
  handle.stop();
  await handle.done;
  activePollers.delete(connectionId);
}

export async function stopAllPolling(): Promise<void> {
  await Promise.all([...activePollers.keys()].map((id) => stopPolling(id)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
