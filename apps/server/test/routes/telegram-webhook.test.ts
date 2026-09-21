import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeTestEnv } from '../helpers/test-env.js';
import { mockPrisma, uniqueConstraintError } from '../helpers/mock-prisma.js';
import { setQueueForTesting, type JobQueue } from '../../src/queue/index.js';
import { initLogger } from '../../src/lib/logger.js';

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

const CONNECTION_ID = 'conn-tg-1';
const SECRET = 'right-secret';
const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

const connection = {
  id: CONNECTION_ID,
  tenantId: 'tenant-1',
  channel: 'TELEGRAM',
  webhookSecret: SECRET,
};

const update = {
  update_id: 987654321,
  message: {
    message_id: 42,
    date: 1700000000,
    chat: { id: 555, type: 'private' },
    from: { id: 555, is_bot: false, first_name: 'Buyer' },
    text: 'How much does this cost?',
  },
};

type MockFn = ReturnType<typeof vi.fn>;

describe('Telegram webhook routes', () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof mockPrisma>;
  let enqueued: Array<{ name: string; payload: unknown }>;
  // Non-null captures of the lazily-created mock delegates (noUncheckedIndexedAccess).
  let findConnection: MockFn;
  let createEvent: MockFn;
  let updateEvent: MockFn;

  beforeEach(async () => {
    initLogger('silent', false);
    prisma = mockPrisma();
    prisma.install();
    findConnection = prisma.channelConnection!.findUnique!;
    createEvent = prisma.webhookEvent!.create!;
    updateEvent = prisma.webhookEvent!.update!;
    const q = stubQueue();
    enqueued = q.enqueued;
    setQueueForTesting(q.queue);
    app = await buildApp(makeTestEnv());
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  const inject = (opts: { body?: unknown; secret?: string; connectionId?: string } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.secret !== undefined) headers[SECRET_HEADER] = opts.secret;
    return app.inject({
      method: 'POST',
      url: `/api/webhooks/telegram/${opts.connectionId ?? CONNECTION_ID}`,
      headers,
      payload: JSON.stringify(opts.body ?? update),
    });
  };

  describe('connection lookup', () => {
    it('returns 404 when the connection does not exist', async () => {
      findConnection.mockResolvedValue(null);
      const res = await inject({ secret: SECRET });
      expect(res.statusCode).toBe(404);
      expect(findConnection).toHaveBeenCalledWith({
        where: { id: CONNECTION_ID },
      });
      expect(createEvent).not.toHaveBeenCalled();
      expect(enqueued).toHaveLength(0);
    });

    it('returns 404 when the connection is for another channel', async () => {
      findConnection.mockResolvedValue({ ...connection, channel: 'INSTAGRAM' });
      const res = await inject({ secret: SECRET });
      expect(res.statusCode).toBe(404);
      expect(enqueued).toHaveLength(0);
    });

    it('returns 404 when the connection has no webhook secret configured', async () => {
      findConnection.mockResolvedValue({ ...connection, webhookSecret: null });
      const res = await inject({ secret: SECRET });
      expect(res.statusCode).toBe(404);
      expect(enqueued).toHaveLength(0);
    });
  });

  describe('secret token verification', () => {
    beforeEach(() => {
      findConnection.mockResolvedValue(connection);
    });

    it('returns 401 when the secret header is missing', async () => {
      const res = await inject();
      expect(res.statusCode).toBe(401);
      expect(createEvent).not.toHaveBeenCalled();
      expect(enqueued).toHaveLength(0);
    });

    it('returns 401 when the secret header is wrong', async () => {
      const res = await inject({ secret: 'wrong-secret' });
      expect(res.statusCode).toBe(401);
      expect(createEvent).not.toHaveBeenCalled();
      expect(enqueued).toHaveLength(0);
    });

    it('returns 401 for a same-length but different secret', async () => {
      const res = await inject({ secret: 'right-secreX' });
      expect(res.statusCode).toBe(401);
      expect(enqueued).toHaveLength(0);
    });
  });

  describe('valid updates', () => {
    beforeEach(() => {
      findConnection.mockResolvedValue(connection);
      createEvent.mockResolvedValue({ id: 'evt-1' });
      updateEvent.mockResolvedValue({ id: 'evt-1' });
    });

    it('ACKs 200, persists the event with eventKey <connectionId>:<update_id>, and enqueues a job', async () => {
      const res = await inject({ secret: SECRET });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      expect(createEvent).toHaveBeenCalledTimes(1);
      const createArg = createEvent.mock.calls[0]![0] as {
        data: {
          channel: string;
          eventKey: string;
          tenantId: string | null;
          status: string;
          payload: { connectionId: string; update: { update_id: number } };
        };
      };
      expect(createArg.data.channel).toBe('TELEGRAM');
      expect(createArg.data.eventKey).toBe(`${CONNECTION_ID}:${update.update_id}`);
      expect(createArg.data.tenantId).toBe('tenant-1');
      expect(createArg.data.status).toBe('RECEIVED');
      expect(createArg.data.payload.connectionId).toBe(CONNECTION_ID);
      expect(createArg.data.payload.update.update_id).toBe(update.update_id);

      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.name).toBe('webhook:process');
      expect(enqueued[0]!.payload).toEqual({ webhookEventId: 'evt-1' });
    });

    it('marks the persisted event ENQUEUED after enqueueing', async () => {
      await inject({ secret: SECRET });
      expect(updateEvent).toHaveBeenCalledWith({
        where: { id: 'evt-1' },
        data: { status: 'ENQUEUED' },
      });
    });

    it('deduplicates a retried update_id: still 200, only one job across two posts', async () => {
      createEvent
        .mockResolvedValueOnce({ id: 'evt-1' })
        .mockRejectedValueOnce(uniqueConstraintError());

      const first = await inject({ secret: SECRET });
      const second = await inject({ secret: SECRET });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200); // still ACKed so Telegram stops retrying
      expect(createEvent).toHaveBeenCalledTimes(2);
      expect(enqueued).toHaveLength(1); // but only one processing job
    });
  });

  describe('malformed bodies', () => {
    beforeEach(() => {
      findConnection.mockResolvedValue(connection);
    });

    it('ACKs 200 without persisting when the body has no update_id', async () => {
      const res = await inject({ secret: SECRET, body: { message: { text: 'no id here' } } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(createEvent).not.toHaveBeenCalled();
      expect(enqueued).toHaveLength(0);
    });

    it('ACKs 200 without persisting when update_id is not a number', async () => {
      const res = await inject({ secret: SECRET, body: { update_id: 'not-a-number' } });
      expect(res.statusCode).toBe(200);
      expect(createEvent).not.toHaveBeenCalled();
      expect(enqueued).toHaveLength(0);
    });
  });
});
