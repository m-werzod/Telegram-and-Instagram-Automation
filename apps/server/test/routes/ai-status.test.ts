/**
 * Reporting an outage, and recovering from one.
 *
 * Written after a real four-day failure: an OpenAI key expired, the platform
 * detected it within minutes and raised a task saying exactly that — on a page
 * nobody opens. The owner experienced it as "Instagram is broken". Both
 * channels were down; Instagram was simply the one being watched.
 *
 * So these pin two things. The status endpoint must call an outage an outage
 * and count the customers it left unanswered, and the replay must be able to
 * put those customers back in the queue once the cause is gone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { initLogger } from '../../src/lib/logger.js';
import { makeTestEnv } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';
import { setQueueForTesting, type JobQueue } from '../../src/queue/index.js';

const enqueued: unknown[] = [];
const recordingQueue: JobQueue = {
  enqueue: async (name, payload) => {
    enqueued.push({ name, payload });
  },
  registerHandler: () => undefined,
  start: async () => undefined,
  stop: async () => undefined,
};

const COOKIE = { sid: 'session-token' };

describe('AI status and dead-letter replay', () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof mockPrisma>;

  const signInAs = (role: 'ADMIN' | 'OPERATOR') => {
    prisma.authSession.findUnique.mockResolvedValue({
      id: 'sess-1',
      expiresAt: new Date(Date.now() + 3_600_000),
      user: { id: 'u-1', tenantId: 'tenant-1', username: 'Admin', role, name: 'Admin' },
    });
  };

  beforeEach(async () => {
    initLogger('silent', false);
    enqueued.length = 0;
    prisma = mockPrisma();
    prisma.install();
    setQueueForTesting(recordingQueue);
    app = await buildApp(makeTestEnv());
  });
  afterEach(async () => app.close());

  const status = async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ai-status', cookies: COOKIE });
    return { code: res.statusCode, body: res.json() };
  };

  it('reports healthy when nothing is failing', async () => {
    signInAs('ADMIN');
    prisma.manualAction.findFirst.mockResolvedValue(null);
    prisma.aIExecution.count.mockResolvedValue(0);
    prisma.webhookEvent.count.mockResolvedValue(0);

    const { body } = await status();
    expect(body.ok).toBe(true);
    expect(body.keyRejected).toBe(false);
  });

  // The exact shape of the outage that went unnoticed.
  it('reports the outage when the key is being rejected', async () => {
    signInAs('ADMIN');
    prisma.manualAction.findFirst.mockResolvedValue({
      title: 'Replace the OpenAI (ChatGPT) API key — it is being rejected',
      createdAt: new Date('2026-11-04T17:05:00Z'),
    });
    prisma.aIExecution.count.mockResolvedValue(82);
    prisma.aIExecution.findFirst.mockResolvedValue({
      error: '[openai] 401 Your API key has expired. Create a new API key to continue.',
      createdAt: new Date(),
    });
    prisma.webhookEvent.count.mockResolvedValue(82);

    const { body } = await status();
    expect(body.ok).toBe(false);
    expect(body.keyRejected).toBe(true);
    // The number that actually matters to the owner.
    expect(body.strandedMessages).toBe(82);
    expect(body.lastError).toMatch(/API key has expired/);
  });

  // Everything failing is an outage from the customer's side whatever the
  // cause, so it must raise the banner even with no key verdict.
  it('reports an outage when every call fails and none succeed', async () => {
    signInAs('ADMIN');
    prisma.manualAction.findFirst.mockResolvedValue(null);
    prisma.aIExecution.count.mockImplementation(async (args: unknown) => {
      const where = (args as { where: { status: string } }).where;
      return where.status === 'FAILED' ? 40 : 0;
    });
    prisma.webhookEvent.count.mockResolvedValue(0);

    const { body } = await status();
    expect(body.ok).toBe(false);
    expect(body.keyRejected).toBe(false);
  });

  it('stays healthy while some calls still succeed', async () => {
    signInAs('ADMIN');
    prisma.manualAction.findFirst.mockResolvedValue(null);
    prisma.aIExecution.count.mockImplementation(async (args: unknown) => {
      const where = (args as { where: { status: string } }).where;
      return where.status === 'FAILED' ? 3 : 100;
    });
    prisma.webhookEvent.count.mockResolvedValue(0);

    expect((await status()).body.ok).toBe(true);
  });

  // An operator sees the banner too — they are the ones being asked why the
  // customer never got an answer.
  it('is readable by an operator', async () => {
    signInAs('OPERATOR');
    prisma.manualAction.findFirst.mockResolvedValue(null);
    prisma.aIExecution.count.mockResolvedValue(0);
    prisma.webhookEvent.count.mockResolvedValue(0);

    expect((await status()).code).toBe(200);
  });

  it('is not readable without a session', async () => {
    prisma.authSession.findUnique.mockResolvedValue(null);
    expect((await status()).code).toBe(401);
  });
});

describe('dead-letter replay', () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(async () => {
    initLogger('silent', false);
    enqueued.length = 0;
    prisma = mockPrisma();
    prisma.install();
    setQueueForTesting(recordingQueue);
    app = await buildApp(makeTestEnv());
    prisma.authSession.findUnique.mockResolvedValue({
      id: 'sess-1',
      expiresAt: new Date(Date.now() + 3_600_000),
      user: { id: 'u-1', tenantId: 'tenant-1', username: 'Admin', role: 'ADMIN', name: 'Admin' },
    });
  });
  afterEach(async () => app.close());

  it('requeues the stranded events', async () => {
    prisma.webhookEvent.findMany.mockResolvedValue([{ id: 'e-1' }, { id: 'e-2' }]);
    prisma.webhookEvent.count.mockResolvedValue(0);

    const res = await app.inject({
      method: 'POST',
      url: '/api/dead-letters/replay',
      cookies: COOKIE,
      payload: { withinHours: 72 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().replayed).toBe(2);
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]).toMatchObject({ name: 'webhook:process' });
  });

  // A replay inheriting the exhausted attempt count would dead-letter again
  // on its first hiccup, which would look exactly like the fix not working.
  it('resets the attempt counter so a retry gets a real chance', async () => {
    prisma.webhookEvent.findMany.mockResolvedValue([{ id: 'e-1' }]);
    prisma.webhookEvent.count.mockResolvedValue(0);

    await app.inject({
      method: 'POST',
      url: '/api/dead-letters/replay',
      cookies: COOKIE,
      payload: {},
    });

    const data = (prisma.webhookEvent.updateMany.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    }).data;
    expect(data).toMatchObject({ status: 'ENQUEUED', attempts: 0, error: null });
  });

  it('only replays this tenant’s events, and only recent ones', async () => {
    prisma.webhookEvent.findMany.mockResolvedValue([]);
    prisma.webhookEvent.count.mockResolvedValue(5);

    const res = await app.inject({
      method: 'POST',
      url: '/api/dead-letters/replay',
      cookies: COOKIE,
      payload: { withinHours: 24 },
    });

    const where = (prisma.webhookEvent.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    }).where;
    expect(where).toMatchObject({ tenantId: 'tenant-1', status: 'DEAD_LETTER' });
    expect(where.receivedAt).toBeDefined();
    // Anything older is reported, not silently resurrected.
    expect(res.json().skippedTooOld).toBe(5);
    expect(enqueued).toHaveLength(0);
  });

  it('is refused to an operator', async () => {
    prisma.authSession.findUnique.mockResolvedValue({
      id: 'sess-2',
      expiresAt: new Date(Date.now() + 3_600_000),
      user: { id: 'u-2', tenantId: 'tenant-1', username: 'op', role: 'OPERATOR', name: 'Op' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/dead-letters/replay',
      cookies: COOKIE,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(enqueued).toHaveLength(0);
  });
});
