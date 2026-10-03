/**
 * Telegram long-polling fallback (Bot API getUpdates) — the no-public-URL
 * alternative to webhooks. Covers the per-batch contract directly
 * (processUpdatesBatch) and the start/stop lifecycle end-to-end against a
 * stubbed Telegram API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../../src/lib/crypto.js';
import { initLogger, childLogger } from '../../src/lib/logger.js';
import { makeTestEnv, TEST_ENCRYPTION_KEY } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';
import { setQueueForTesting, type JobQueue } from '../../src/queue/index.js';
import {
  isPolling,
  processUpdatesBatch,
  startPolling,
  stopAllPolling,
  stopPolling,
} from '../../src/modules/channels/telegram/polling.js';
import type { TgUpdate } from '../../src/modules/channels/telegram/client.js';

function stubQueue() {
  const enqueued: Array<{ name: string; payload: unknown }> = [];
  const queue: JobQueue = {
    enqueue: async (name, payload) => {
      enqueued.push({ name, payload });
    },
    registerHandler: () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
  };
  return { queue, enqueued };
}

const connectionRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'conn-tg-poll',
  tenantId: 'tenant-1',
  channel: 'TELEGRAM',
  status: 'connected',
  externalAccountId: '555000111',
  credentialsEncrypted: encryptSecret(
    JSON.stringify({ botToken: '555000111:poll-test-token-abcdefg' }),
    TEST_ENCRYPTION_KEY,
  ),
  webhookSecret: 'secret',
  metadata: {},
  ...over,
});

const log = () => childLogger({ module: 'test' });

function makeUpdate(id: number, text = 'salom'): TgUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1_700_000_000,
      chat: { id: 999, type: 'private' },
      from: { id: 999, is_bot: false, first_name: 'Test' },
      text,
    },
  };
}

describe('processUpdatesBatch', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let enqueued: Array<{ name: string; payload: unknown }>;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
    prisma.webhookEvent.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      id: 'evt-1',
      ...args.data,
    }));
    prisma.webhookEvent.update.mockResolvedValue({});
    const q = stubQueue();
    enqueued = q.enqueued;
    setQueueForTesting(q.queue);
  });

  it('empty batch returns undefined and records nothing', async () => {
    const result = await processUpdatesBatch(connectionRow() as never, [], log());
    expect(result).toBeUndefined();
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it('records each update with the exact eventKey shape the webhook route uses', async () => {
    const conn = connectionRow();
    await processUpdatesBatch(conn as never, [makeUpdate(100), makeUpdate(101)], log());

    const keys = prisma.webhookEvent.create.mock.calls.map(
      (c: any) => c[0].data.eventKey,
    );
    expect(keys).toEqual([
      `${conn.id}:${conn.externalAccountId}:100`,
      `${conn.id}:${conn.externalAccountId}:101`,
    ]);
    expect(enqueued).toHaveLength(2);
  });

  it('returns offset = max(update_id) + 1 across the batch, regardless of input order', async () => {
    const conn = connectionRow();
    const result = await processUpdatesBatch(
      conn as never,
      [makeUpdate(50), makeUpdate(203), makeUpdate(101)],
      log(),
    );
    expect(result).toBe(204);
  });

  it('a failure recording one update does not block the others or the offset', async () => {
    const conn = connectionRow();
    prisma.webhookEvent.create
      .mockImplementationOnce(async () => ({ id: 'evt-1' }))
      .mockImplementationOnce(async () => {
        throw new Error('db down');
      })
      .mockImplementationOnce(async () => ({ id: 'evt-3' }));

    const result = await processUpdatesBatch(
      conn as never,
      [makeUpdate(1), makeUpdate(2), makeUpdate(3)],
      log(),
    );
    expect(result).toBe(4); // still advances past the failed update
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(3);
  });

  it('the payload shape matches what the webhook route and processTelegramEvent expect', async () => {
    const conn = connectionRow();
    const update = makeUpdate(7);
    await processUpdatesBatch(conn as never, [update], log());
    const payload = prisma.webhookEvent.create.mock.calls[0]![0].data.payload;
    expect(payload).toEqual({ connectionId: conn.id, update });
  });
});

describe('polling lifecycle', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let fetchCalls: Array<{ method: string; url: string }>;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
    prisma.webhookEvent.create.mockResolvedValue({ id: 'evt-1' });
    prisma.webhookEvent.update.mockResolvedValue({});
    prisma.channelConnection.update.mockResolvedValue({});
    setQueueForTesting(stubQueue().queue);
    fetchCalls = [];
  });

  afterEach(async () => {
    await stopAllPolling();
    vi.unstubAllGlobals();
  });

  it('isPolling is false before start and true immediately after', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        const url = String(input);
        fetchCalls.push({ method: 'POST', url });
        if (url.endsWith('/deleteWebhook')) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        // getUpdates: hang briefly then return empty — keeps the loop alive
        // long enough to observe isPolling() without racing stop().
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }),
    );
    const conn = connectionRow({ id: 'conn-lifecycle-1' });
    expect(isPolling(conn.id)).toBe(false);
    await startPolling(conn as never);
    expect(isPolling(conn.id)).toBe(true);
    await stopPolling(conn.id);
    expect(isPolling(conn.id)).toBe(false);
  });

  it('calls deleteWebhook before the first getUpdates (clears any existing webhook)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        fetchCalls.push({ method: 'POST', url: String(input) });
        await new Promise((r) => setTimeout(r, 10));
        return new Response(JSON.stringify({ ok: true, result: String(input).endsWith('/getUpdates') ? [] : true }), {
          status: 200,
        });
      }),
    );
    const conn = connectionRow({ id: 'conn-lifecycle-2' });
    await startPolling(conn as never);
    await new Promise((r) => setTimeout(r, 30));
    await stopPolling(conn.id);

    expect(fetchCalls[0]!.url.endsWith('/deleteWebhook')).toBe(true);
    expect(fetchCalls.some((c) => c.url.endsWith('/getUpdates'))).toBe(true);
  });

  it('a second startPolling call for the same connection is a no-op (idempotent)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        fetchCalls.push({ method: 'POST', url: String(input) });
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }),
    );
    const conn = connectionRow({ id: 'conn-lifecycle-3' });
    await startPolling(conn as never);
    const callsAfterFirst = fetchCalls.length;
    await startPolling(conn as never); // should not start a second loop
    // No new deleteWebhook/getUpdates call fired synchronously from the
    // second call — only one poller is tracked for this connection id.
    expect(fetchCalls.length).toBe(callsAfterFirst);
    await stopPolling(conn.id);
  });

  it('persists real updates through the queue while polling end-to-end', async () => {
    let getUpdatesCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        const url = String(input);
        fetchCalls.push({ method: 'POST', url });
        if (url.endsWith('/deleteWebhook')) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        getUpdatesCalls++;
        if (getUpdatesCalls === 1) {
          return new Response(
            JSON.stringify({ ok: true, result: [makeUpdate(900)] }),
            { status: 200 },
          );
        }
        await new Promise((r) => setTimeout(r, 15));
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }),
    );
    const conn = connectionRow({ id: 'conn-lifecycle-4' });
    await startPolling(conn as never);
    await new Promise((r) => setTimeout(r, 30));
    await stopPolling(conn.id);

    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventKey: `${conn.id}:${conn.externalAccountId}:900` }),
      }),
    );
    // Offset persisted into connection metadata after a non-empty batch.
    expect(prisma.channelConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: conn.id },
        data: expect.objectContaining({
          metadata: expect.objectContaining({ pollingOffset: 901, channelMode: 'polling' }),
        }),
      }),
    );
  });
});
