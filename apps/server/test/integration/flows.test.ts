/**
 * End-to-end flow tests (spec §30) against a REAL PostgreSQL database.
 *
 * Requires TEST_DATABASE_URL pointing at a pgvector-enabled Postgres, e.g.:
 *   docker compose up -d db
 *   $env:TEST_DATABASE_URL="postgresql://platform:platform@localhost:5432/platform_test"
 *   pnpm test:integration
 *
 * Migrations are applied automatically. External APIs (Telegram/Meta/AI) are
 * stubbed — mocks are test-only (spec §41).
 */
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;

if (!TEST_DB) {
  console.error('[integration] TEST_DATABASE_URL not set — skipping end-to-end flow tests');
}

d('end-to-end flows', () => {
  let app: FastifyInstance;
  let prisma: import('@prisma/client').PrismaClient;
  let queue: import('../../src/queue/inline-queue.js').InlineQueue;
  let ai: import('../helpers/stub-ai.js').StubAIProvider;
  let fetchCalls: Array<{ url: string; body: any }>;
  let tenantId: string;

  const IG_ACCOUNT = '17841400000000001';
  const TG_SECRET = 'tg-webhook-secret-token';
  const APP_SECRET = 'test-app-secret';

  const sign = (body: string) =>
    `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB!;
    execSync('pnpm exec prisma migrate deploy', {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: TEST_DB! },
      stdio: 'pipe',
    });

    const { makeTestEnv } = await import('../helpers/test-env.js');
    const { initLogger } = await import('../../src/lib/logger.js');
    const { buildApp } = await import('../../src/app.js');
    const { getPrisma } = await import('../../src/db/client.js');
    const { InlineQueue } = await import('../../src/queue/inline-queue.js');
    const { setQueueForTesting } = await import('../../src/queue/index.js');
    const { registerWorkers } = await import('../../src/workers/webhook-processor.js');
    const { installStubAI } = await import('../helpers/stub-ai.js');

    initLogger('silent', false);
    const env = makeTestEnv({
      DATABASE_URL: TEST_DB!,
      META_APP_SECRET: APP_SECRET,
      META_VERIFY_TOKEN: 'test-verify-token',
    });
    prisma = getPrisma();
    queue = new InlineQueue(2);
    setQueueForTesting(queue);
    registerWorkers(queue);
    await queue.start();
    ai = installStubAI();
    app = await buildApp(env);
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await queue?.stop();
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    // Clean slate per test (FK-safe order via cascade truncate).
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "AuditLog","IdempotencyKey","ManualAction","HumanHandoff","CrmNote",
        "ToolExecution","AIExecution","WebhookEvent","ConversationMessage","Conversation",
        "LeadIdentity","Lead","KnowledgeChunk","KnowledgeDocument","KnowledgeBase",
        "ChannelConnection","Agent","AuthSession","User","Tenant" CASCADE
    `);

    const { encryptSecret } = await import('../../src/lib/crypto.js');
    const { TEST_ENCRYPTION_KEY } = await import('../helpers/test-env.js');

    const tenant = await prisma.tenant.create({
      data: { name: 'Test Business', slug: `t-${Date.now()}-${Math.floor(Math.random() * 1e6)}` },
    });
    tenantId = tenant.id;

    await prisma.channelConnection.create({
      data: {
        tenantId,
        channel: 'TELEGRAM',
        status: 'connected',
        displayName: '@testbot',
        externalAccountId: '999999',
        credentialsEncrypted: encryptSecret(
          JSON.stringify({ botToken: '999999:test-bot-token-abcdefghijk' }),
          TEST_ENCRYPTION_KEY,
        ),
        webhookSecret: TG_SECRET,
      },
    });
    await prisma.channelConnection.create({
      data: {
        tenantId,
        channel: 'INSTAGRAM',
        status: 'connected',
        displayName: '@testshop',
        externalAccountId: IG_ACCOUNT,
        credentialsEncrypted: encryptSecret(
          JSON.stringify({ accessToken: 'IGQVJtest-token-value', obtainedAt: Date.now() }),
          TEST_ENCRYPTION_KEY,
        ),
      },
    });
    for (const type of ['INSTAGRAM_COMMENT', 'INSTAGRAM_DM', 'TELEGRAM'] as const) {
      await prisma.agent.create({
        data: {
          tenantId,
          type,
          name: `${type} agent`,
          enabled: true,
          systemInstructions: 'Be helpful.',
          businessObjective: 'Qualify leads',
          provider: 'anthropic',
          model: 'claude-opus-5',
        },
      });
    }

    // Stub all outbound HTTP (Telegram Bot API + Instagram Graph API).
    fetchCalls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        const body = init?.body ? safeParse(init.body) : undefined;
        fetchCalls.push({ url, body });
        if (url.includes('api.telegram.org')) {
          if (url.endsWith('/sendMessage')) {
            return jsonResponse({
              ok: true,
              result: { message_id: 5000 + fetchCalls.length, chat: { id: body?.chat_id }, date: 0, text: body?.text },
            });
          }
          return jsonResponse({ ok: true, result: true });
        }
        if (url.includes('graph.instagram.com')) {
          if (url.includes('/replies')) return jsonResponse({ id: `reply-${fetchCalls.length}` });
          if (url.includes('/messages')) return jsonResponse({ recipient_id: 'r', message_id: `m-${fetchCalls.length}` });
          return jsonResponse({ user_id: IG_ACCOUNT, username: 'testshop' });
        }
        return jsonResponse({});
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(data: unknown): Response {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  function safeParse(body: unknown): any {
    try {
      return JSON.parse(String(body));
    } catch {
      return undefined;
    }
  }

  async function postTelegramUpdate(updateId: number, text: string, userId = 777) {
    const connection = await prisma.channelConnection.findUniqueOrThrow({
      where: { tenantId_channel: { tenantId, channel: 'TELEGRAM' } },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/telegram/${connection.id}`,
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': TG_SECRET,
      },
      payload: {
        update_id: updateId,
        message: {
          message_id: updateId * 10,
          from: { id: userId, is_bot: false, first_name: 'Alisher', username: 'alisher_u' },
          chat: { id: userId, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          text,
        },
      },
    });
    await queue.drain();
    return res;
  }

  async function postInstagram(payload: unknown) {
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });
    await queue.drain();
    return res;
  }

  const commentPayload = (commentId: string, text: string, userId = 'ig-user-1') => ({
    object: 'instagram',
    entry: [
      {
        id: IG_ACCOUNT,
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: 'comments',
            value: {
              id: commentId,
              text,
              from: { id: userId, username: 'curious_buyer' },
              media: { id: 'media-77', media_product_type: 'FEED' },
            },
          },
        ],
      },
    ],
  });

  const dmPayload = (mid: string, text: string, igsid = 'igsid-42', extra: object = {}) => ({
    object: 'instagram',
    entry: [
      {
        id: IG_ACCOUNT,
        messaging: [
          {
            sender: { id: igsid },
            recipient: { id: IG_ACCOUNT },
            timestamp: Date.now(),
            message: { mid, text, ...extra },
          },
        ],
      },
    ],
  });

  // ────────────────────────────── Telegram ──────────────────────────────

  it('Telegram message → agent replies → lead + conversation + logs in CRM', async () => {
    ai.respondWith({
      reply: 'Salom! Yetkazib berish 30 000 so‘m.',
      detectedLanguage: 'uz',
      intent: 'price_inquiry',
      leadScore: 55,
      tags: ['delivery'],
    });

    const res = await postTelegramUpdate(1001, 'Yetkazib berish qancha turadi?');
    expect(res.statusCode).toBe(200);

    const lead = await prisma.lead.findFirstOrThrow({ where: { tenantId }, include: { identities: true } });
    expect(lead.source).toBe('TELEGRAM');
    expect(lead.name).toBe('Alisher');
    expect(lead.identities[0]).toMatchObject({ channel: 'TELEGRAM', externalId: '777' });
    expect(lead.language).toBe('uz');
    expect(lead.score).toBe(55);
    expect(lead.tags).toContain('delivery');

    const messages = await prisma.conversationMessage.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ direction: 'INBOUND', role: 'USER' });
    expect(messages[1]).toMatchObject({ direction: 'OUTBOUND', role: 'AGENT' });
    expect(messages[1]!.content).toContain('Yetkazib berish');

    const sendCall = fetchCalls.find((c) => c.url.includes('/sendMessage'));
    expect(sendCall?.body?.chat_id).toBe(777);

    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { tenantId } });
    expect(event.status).toBe('PROCESSED');

    const exec = await prisma.aIExecution.findFirstOrThrow({ where: { tenantId } });
    expect(exec.status).toBe('SUCCEEDED');
    expect(exec.decision).toBeTruthy();
  });

  it('agent OFF → event recorded, message persisted, NO autonomous response', async () => {
    await prisma.agent.updateMany({
      where: { tenantId, type: 'TELEGRAM' },
      data: { enabled: false },
    });

    await postTelegramUpdate(1002, 'Hello?');

    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { tenantId } });
    expect(event.status).toBe('SKIPPED');
    expect(event.error).toContain('disabled');

    const messages = await prisma.conversationMessage.findMany({ where: { tenantId } });
    expect(messages).toHaveLength(1); // inbound persisted (no data loss)
    expect(messages[0]!.direction).toBe('INBOUND');
    expect(ai.calls).toHaveLength(0);
    expect(fetchCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
  });

  it('duplicate Telegram webhook (same update_id) → exactly one response', async () => {
    ai.respondWith({ reply: 'Once only.' });
    ai.respondWith({ reply: 'Should never be used.' });

    await postTelegramUpdate(1003, 'ping');
    await postTelegramUpdate(1003, 'ping'); // Telegram retry

    const events = await prisma.webhookEvent.findMany({ where: { tenantId } });
    expect(events).toHaveLength(1);
    const outbound = await prisma.conversationMessage.findMany({
      where: { tenantId, direction: 'OUTBOUND' },
    });
    expect(outbound).toHaveLength(1);
    expect(fetchCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(1);
  });

  it('escalation → handoff created, conversation paused, follow-ups stay silent', async () => {
    ai.respondWith({
      reply: 'I will get a human to help you.',
      shouldEscalate: true,
      escalationReason: 'user asked for a human',
    });

    await postTelegramUpdate(1004, 'I want to talk to a real person');

    const handoff = await prisma.humanHandoff.findFirstOrThrow({ where: { tenantId } });
    expect(handoff.status).toBe('OPEN');
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { tenantId } });
    expect(conversation.status).toBe('HANDED_OFF');

    // Follow-up message: recorded but no AI generation, no send.
    const aiCallsBefore = ai.calls.length;
    const sendsBefore = fetchCalls.filter((c) => c.url.includes('/sendMessage')).length;
    await postTelegramUpdate(1005, 'hello??');
    expect(ai.calls.length).toBe(aiCallsBefore);
    expect(fetchCalls.filter((c) => c.url.includes('/sendMessage')).length).toBe(sendsBefore);
    const inbound = await prisma.conversationMessage.findMany({
      where: { tenantId, direction: 'INBOUND' },
    });
    expect(inbound).toHaveLength(2); // both user messages preserved
  });

  // ────────────────────────────── Instagram comments ──────────────────────────────

  it('comment → public reply + single private reply + CRM lead (spec §11, §48)', async () => {
    ai.respondWith({
      reply: 'Thanks for asking! We sent you a DM with details 💬',
      intent: 'price_inquiry',
      sendPrivateReply: true,
      privateReplyText: 'Hi! The price is $49 including delivery. What size do you need?',
      leadScore: 60,
    });

    await postInstagram(commentPayload('c-100', 'How much does this cost?'));

    // Public reply to the comment endpoint.
    const publicReply = fetchCalls.find((c) => c.url.includes('/c-100/replies'));
    expect(publicReply).toBeTruthy();
    // Private reply via /me/messages with recipient.comment_id.
    const privateReply = fetchCalls.find(
      (c) => c.url.includes('/me/messages') && c.body?.recipient?.comment_id === 'c-100',
    );
    expect(privateReply).toBeTruthy();
    expect(privateReply!.body.message.text).toContain('$49');

    const lead = await prisma.lead.findFirstOrThrow({ where: { tenantId }, include: { identities: true } });
    expect(lead.source).toBe('INSTAGRAM');
    expect(lead.identities[0]).toMatchObject({ channel: 'INSTAGRAM', externalId: 'ig-user-1' });

    const outbound = await prisma.conversationMessage.findMany({
      where: { tenantId, direction: 'OUTBOUND' },
    });
    expect(outbound).toHaveLength(2); // public + private

    // Re-delivery of the same comment id → dedup, no extra sends.
    const sendsBefore = fetchCalls.length;
    await postInstagram(commentPayload('c-100', 'How much does this cost?'));
    expect(fetchCalls.length).toBe(sendsBefore);
  });

  it('own comment (echo of our reply) is ignored — no loops', async () => {
    await postInstagram(commentPayload('c-200', 'Thanks!', IG_ACCOUNT));
    expect(ai.calls).toHaveLength(0);
    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { tenantId } });
    expect(event.status).toBe('SKIPPED');
  });

  // ────────────────────────────── Instagram DMs ──────────────────────────────

  it('DM → agent replies within window → CRM updated (spec §12)', async () => {
    ai.respondWith({
      reply: 'We have it in stock! Would you like home delivery?',
      intent: 'product_interest',
      leadUpdate: { name: null, phone: null, email: null, requestedService: 'sneakers', category: null, purpose: null, budget: null, location: null, timeline: null },
    });

    await postInstagram(dmPayload('mid-500', 'Do you have these sneakers in 42?'));

    const dmSend = fetchCalls.find(
      (c) => c.url.includes('/me/messages') && c.body?.recipient?.id === 'igsid-42',
    );
    expect(dmSend).toBeTruthy();

    const lead = await prisma.lead.findFirstOrThrow({ where: { tenantId } });
    expect((lead.qualification as any).requestedService).toBe('sneakers');

    const conversation = await prisma.conversation.findFirstOrThrow({
      where: { tenantId, kind: 'INSTAGRAM_DM' },
    });
    expect(conversation.externalThreadId).toBe('igsid-42');
  });

  it('DM echo events are never processed', async () => {
    await postInstagram(dmPayload('mid-echo', 'our own message', IG_ACCOUNT, { is_echo: true }));
    // The route filters echoes before persisting anything.
    const events = await prisma.webhookEvent.findMany({ where: { tenantId } });
    expect(events).toHaveLength(0);
    expect(ai.calls).toHaveLength(0);
  });

  it('same person: second DM reuses the lead (identity resolution, spec §9)', async () => {
    ai.respondWith({ reply: 'Reply one' });
    ai.respondWith({ reply: 'Reply two' });
    await postInstagram(dmPayload('mid-601', 'First message'));
    await postInstagram(dmPayload('mid-602', 'Second message'));

    const leads = await prisma.lead.findMany({ where: { tenantId } });
    expect(leads).toHaveLength(1);
    const messages = await prisma.conversationMessage.findMany({
      where: { tenantId, direction: 'INBOUND' },
    });
    expect(messages).toHaveLength(2);
  });
});
