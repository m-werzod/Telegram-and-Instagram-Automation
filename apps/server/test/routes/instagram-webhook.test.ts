import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
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

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('Instagram webhook routes', () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof mockPrisma>;
  let enqueued: Array<{ name: string; payload: unknown }>;
  const env = { appSecret: 'test-app-secret', verifyToken: 'test-verify-token' };

  beforeEach(async () => {
    initLogger('silent', false);
    makeTestEnv({ META_APP_SECRET: env.appSecret, META_VERIFY_TOKEN: env.verifyToken });
    prisma = mockPrisma();
    prisma.install();
    const q = stubQueue();
    enqueued = q.enqueued;
    setQueueForTesting(q.queue);
    app = await buildApp(makeTestEnv({ META_APP_SECRET: env.appSecret, META_VERIFY_TOKEN: env.verifyToken }));
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  describe('GET verification handshake', () => {
    it('echoes hub.challenge when the verify token matches', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=1158201444',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('1158201444');
    });

    it('rejects a wrong verify token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=42',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST event notifications', () => {
    const commentPayload = {
      object: 'instagram',
      entry: [
        {
          id: '17841400000000000',
          time: 1700000000,
          changes: [
            {
              field: 'comments',
              value: {
                id: 'comment-123',
                text: 'How much does this cost?',
                from: { id: 'user-1', username: 'buyer' },
                media: { id: 'media-9', media_product_type: 'FEED' },
              },
            },
          ],
        },
      ],
    };

    it('rejects an invalid signature', async () => {
      const body = JSON.stringify(commentPayload);
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/instagram',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
      expect(enqueued).toHaveLength(0);
    });

    it('rejects a missing signature', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/instagram',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(commentPayload),
      });
      expect(res.statusCode).toBe(401);
    });

    it('accepts a valid signature, persists the event, enqueues processing, ACKs 200', async () => {
      prisma.channelConnection.findFirst.mockResolvedValue({ id: 'conn-1', tenantId: 'tenant-1' });
      prisma.webhookEvent.create.mockResolvedValue({ id: 'evt-1' });
      prisma.webhookEvent.update.mockResolvedValue({ id: 'evt-1' });

      const body = JSON.stringify(commentPayload);
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/instagram',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sign(env.appSecret, body),
        },
        payload: body,
      });

      expect(res.statusCode).toBe(200);
      expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
      const createArg = prisma.webhookEvent.create.mock.calls[0]![0] as {
        data: { eventKey: string; channel: string };
      };
      expect(createArg.data.eventKey).toBe('comment:comment-123');
      expect(createArg.data.channel).toBe('INSTAGRAM');
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.name).toBe('webhook:process');
    });

    it('deduplicates a retried webhook (same comment id → one stored event)', async () => {
      prisma.channelConnection.findFirst.mockResolvedValue({ id: 'conn-1', tenantId: 'tenant-1' });
      prisma.webhookEvent.create
        .mockResolvedValueOnce({ id: 'evt-1' })
        .mockRejectedValueOnce(uniqueConstraintError());
      prisma.webhookEvent.update.mockResolvedValue({ id: 'evt-1' });

      const body = JSON.stringify(commentPayload);
      const inject = () =>
        app.inject({
          method: 'POST',
          url: '/api/webhooks/instagram',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': sign(env.appSecret, body),
          },
          payload: body,
        });

      const first = await inject();
      const second = await inject();
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200); // still ACKed so Meta stops retrying
      expect(enqueued).toHaveLength(1); // but only one processing job
    });

    it('skips echo messages and enqueues only real inbound DMs', async () => {
      prisma.channelConnection.findFirst.mockResolvedValue({ id: 'conn-1', tenantId: 'tenant-1' });
      prisma.webhookEvent.create.mockResolvedValue({ id: 'evt-dm' });
      prisma.webhookEvent.update.mockResolvedValue({ id: 'evt-dm' });

      const payload = {
        object: 'instagram',
        entry: [
          {
            id: '17841400000000000',
            messaging: [
              {
                sender: { id: 'igsid-user' },
                recipient: { id: '17841400000000000' },
                timestamp: Date.now(),
                message: { mid: 'mid-real', text: 'hello' },
              },
              {
                sender: { id: '17841400000000000' },
                recipient: { id: 'igsid-user' },
                timestamp: Date.now(),
                message: { mid: 'mid-echo', text: 'our own reply', is_echo: true },
              },
            ],
          },
        ],
      };
      const body = JSON.stringify(payload);
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/instagram',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sign(env.appSecret, body),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(enqueued).toHaveLength(1);
      const createArg = prisma.webhookEvent.create.mock.calls[0]![0] as { data: { eventKey: string } };
      expect(createArg.data.eventKey).toBe('message:mid-real');
    });
  });
});

/**
 * An app configured with Instagram Login carries two secrets — the Facebook App
 * Secret and a separate "Instagram app secret" — and Meta's documentation does
 * not say which one signs the webhook. Guessing wrong rejects every event with a
 * 401, which from the outside is indistinguishable from Meta never sending
 * anything at all. So a signature from either is accepted.
 */
describe('Instagram webhook — dual app secret', () => {
  const FB = 'facebook-app-secret';
  const IG = 'instagram-app-secret';
  const payload = JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: '17841400000000000',
        messaging: [
          { sender: { id: 'igsid-1' }, recipient: { id: '17841400000000000' }, message: { mid: 'mid-dual-1', text: 'Salom' } },
        ],
      },
    ],
  });

  let app: FastifyInstance;
  let prisma: ReturnType<typeof mockPrisma>;
  let enqueued: Array<{ name: string; payload: unknown }>;

  beforeEach(async () => {
    initLogger('silent', false);
    prisma = mockPrisma();
    prisma.install();
    prisma.channelConnection.findFirst.mockResolvedValue({ id: 'conn-1', tenantId: 'tenant-1' });
    prisma.webhookEvent.create.mockResolvedValue({ id: 'evt-1' });
    prisma.webhookEvent.update.mockResolvedValue({ id: 'evt-1' });
    const q = stubQueue();
    enqueued = q.enqueued;
    setQueueForTesting(q.queue);
    app = await buildApp(
      makeTestEnv({ META_APP_SECRET: FB, META_IG_APP_SECRET: IG, META_VERIFY_TOKEN: 'tok' }),
    );
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  const post = (secret: string) =>
    app.inject({
      method: 'POST',
      url: '/api/webhooks/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(secret, payload) },
      payload,
    });

  it('accepts a payload signed with the Instagram app secret', async () => {
    expect((await post(IG)).statusCode).toBe(200);
    expect(enqueued).toHaveLength(1);
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
  });

  it('still accepts a payload signed with the Facebook app secret', async () => {
    expect((await post(FB)).statusCode).toBe(200);
    expect(enqueued).toHaveLength(1);
  });

  it('still rejects a payload signed with neither', async () => {
    expect((await post('some-other-secret')).statusCode).toBe(401);
    expect(enqueued).toHaveLength(0);
  });
});
