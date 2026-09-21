/**
 * Telegram PERSONAL account automation (Telegram Business connection):
 * connection lifecycle + the personal-chat agent flow, spec §5/§6 of the
 * personal-account requirements. External APIs stubbed (mocks are test-only).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookEvent } from '@prisma/client';
import { processTelegramEvent } from '../../src/modules/channels/telegram/handler.js';
import { TelegramClient } from '../../src/modules/channels/telegram/client.js';
import { encryptSecret } from '../../src/lib/crypto.js';
import { initLogger } from '../../src/lib/logger.js';
import { makeTestEnv, TEST_ENCRYPTION_KEY } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';
import { installStubAI, type StubAIProvider } from '../helpers/stub-ai.js';

const OWNER_ID = 111_222;
const CUSTOMER_ID = 555_777;
const BIZ_ID = 'bizconn-1';

const storedBiz = (over: Partial<Record<string, unknown>> = {}) => ({
  id: BIZ_ID,
  ownerId: OWNER_ID,
  ownerName: 'Sherzod',
  ownerUsername: 'sherzod',
  userChatId: OWNER_ID,
  isEnabled: true,
  canReply: true,
  canReadMessages: true,
  connectedAt: 1_700_000_000,
  ...over,
});

const connectionRow = (bizOver: Partial<Record<string, unknown>> | null = {}) => ({
  id: 'conn-tg',
  tenantId: 'tenant-1',
  channel: 'TELEGRAM',
  status: 'connected',
  externalAccountId: '999999',
  credentialsEncrypted: encryptSecret(
    JSON.stringify({ botToken: '999999:test-bot-token-abcdefghijk' }),
    TEST_ENCRYPTION_KEY,
  ),
  metadata: bizOver === null ? {} : { businessConnection: storedBiz(bizOver) },
});

const personalAgent = (enabled = true) => ({
  id: 'agent-personal',
  tenantId: 'tenant-1',
  type: 'TELEGRAM_PERSONAL',
  name: 'Personal Agent',
  enabled,
  systemInstructions: 'Be helpful.',
  businessObjective: 'Help customers',
  tone: 'friendly',
  language: 'auto',
  provider: 'anthropic',
  model: 'claude-opus-5',
  knowledgeBaseId: null,
  escalationRules: {},
  settings: {},
  createdAt: new Date(),
  updatedAt: new Date(),
});

const businessMessageUpdate = (over: Partial<Record<string, unknown>> = {}) => ({
  update_id: 424_242,
  business_message: {
    message_id: 9001,
    business_connection_id: BIZ_ID,
    from: { id: CUSTOMER_ID, is_bot: false, first_name: 'Aziz', username: 'aziz_client' },
    chat: { id: CUSTOMER_ID, type: 'private' },
    date: Math.floor(Date.now() / 1000),
    text: 'Salom! Narxlarni bilsam bo‘ladimi?',
    ...over,
  },
});

const eventRow = (update: unknown): WebhookEvent =>
  ({
    id: 'evt-1',
    tenantId: 'tenant-1',
    channel: 'TELEGRAM',
    eventKey: 'k',
    payload: { connectionId: 'conn-tg', update },
    status: 'PROCESSING',
    error: null,
    attempts: 1,
    receivedAt: new Date(),
    claimedAt: new Date(),
    processedAt: null,
  }) as WebhookEvent;

describe('Telegram personal account (Business connection)', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let ai: StubAIProvider;
  let fetchCalls: Array<{ url: string; body: any }>;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
    ai = installStubAI();

    prisma.webhookEvent.update.mockResolvedValue({});
    prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', name: 'Test Business' });
    prisma.leadIdentity.findUnique.mockResolvedValue(null);
    prisma.lead.create.mockResolvedValue({ id: 'lead-1', tenantId: 'tenant-1', status: 'NEW', tags: [], qualification: {} });
    prisma.lead.update.mockResolvedValue({});
    prisma.conversation.upsert.mockResolvedValue({ id: 'conv-1', tenantId: 'tenant-1', status: 'ACTIVE' });
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-1', tenantId: 'tenant-1', status: 'ACTIVE' });
    prisma.conversation.update.mockResolvedValue({});
    prisma.conversationMessage.create.mockResolvedValue({ id: 'msg-1' });
    prisma.conversationMessage.findMany.mockResolvedValue([]);
    prisma.conversationMessage.count.mockResolvedValue(0);
    prisma.conversationMessage.findFirst.mockResolvedValue(null);
    prisma.aIExecution.create.mockResolvedValue({ id: 'exec-1' });
    prisma.aIExecution.update.mockResolvedValue({});
    prisma.toolExecution.create.mockResolvedValue({ id: 'tool-1' });
    prisma.toolExecution.update.mockResolvedValue({});
    prisma.idempotencyKey.create.mockResolvedValue({ id: 'idem-1' });
    prisma.channelConnection.update.mockResolvedValue({});
    prisma.manualAction.updateMany.mockResolvedValue({ count: 1 });

    fetchCalls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        fetchCalls.push({ url, body });
        if (url.endsWith('/sendMessage')) {
          return new Response(
            JSON.stringify({ ok: true, result: { message_id: 7001, chat: { id: body?.chat_id }, date: 0, text: body?.text } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('business_connection update stores owner + rights and resolves the manual action', async () => {
    prisma.channelConnection.findUnique.mockResolvedValue(connectionRow(null));
    const update = {
      update_id: 1,
      business_connection: {
        id: BIZ_ID,
        user: { id: OWNER_ID, is_bot: false, first_name: 'Sherzod', username: 'sherzod' },
        user_chat_id: OWNER_ID,
        date: 1_700_000_000,
        rights: { can_reply: true, can_read_messages: true },
        is_enabled: true,
      },
    };
    await processTelegramEvent(eventRow(update));

    const metaArg = prisma.channelConnection.update.mock.calls[0]![0] as {
      data: { metadata: { businessConnection: { ownerId: number; canReply: boolean } } };
    };
    expect(metaArg.data.metadata.businessConnection).toMatchObject({
      id: BIZ_ID,
      ownerId: OWNER_ID,
      canReply: true,
      isEnabled: true,
    });
    // Manual action auto-resolved on successful connection.
    expect(prisma.manualAction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ dedupKey: 'telegram-business-connect' }),
      }),
    );
    expect(prisma.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PROCESSED' }) }),
    );
  });

  it('customer message in a personal chat → AI reply sent AS the personal account', async () => {
    prisma.channelConnection.findUnique.mockResolvedValue(connectionRow());
    prisma.agent.findUnique.mockResolvedValue(personalAgent(true));
    ai.respondWith({ reply: 'Salom! Albatta — narxlar 100 000 so‘mdan boshlanadi.' });

    await processTelegramEvent(eventRow(businessMessageUpdate()));

    const send = fetchCalls.find((c) => c.url.endsWith('/sendMessage'));
    expect(send).toBeTruthy();
    expect(send!.body.business_connection_id).toBe(BIZ_ID); // sent on the account's behalf
    expect(send!.body.chat_id).toBe(CUSTOMER_ID);

    // Inbound + outbound persisted; CRM lead created in the shared TELEGRAM namespace.
    expect(prisma.lead.create).toHaveBeenCalled();
    const outbound = prisma.conversationMessage.create.mock.calls.find(
      (c: any) => c[0].data.direction === 'OUTBOUND',
    );
    expect(outbound).toBeTruthy();
    expect(prisma.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PROCESSED' }) }),
    );
  });

  it("the OWNER's own messages are never answered", async () => {
    prisma.channelConnection.findUnique.mockResolvedValue(connectionRow());
    prisma.agent.findUnique.mockResolvedValue(personalAgent(true));

    await processTelegramEvent(
      eventRow(
        businessMessageUpdate({
          from: { id: OWNER_ID, is_bot: false, first_name: 'Sherzod' },
        }),
      ),
    );

    expect(ai.calls).toHaveLength(0);
    expect(fetchCalls.filter((c) => c.url.endsWith('/sendMessage'))).toHaveLength(0);
    expect(prisma.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SKIPPED' }) }),
    );
  });

  it('agent OFF → message recorded, no AI call, no reply (backend-enforced)', async () => {
    prisma.channelConnection.findUnique.mockResolvedValue(connectionRow());
    prisma.agent.findUnique.mockResolvedValue(personalAgent(false));

    await processTelegramEvent(eventRow(businessMessageUpdate()));

    // Inbound persisted (no data loss)…
    const inbound = prisma.conversationMessage.create.mock.calls.find(
      (c: any) => c[0].data.direction === 'INBOUND',
    );
    expect(inbound).toBeTruthy();
    // …but no autonomous behavior.
    expect(ai.calls).toHaveLength(0);
    expect(fetchCalls.filter((c) => c.url.endsWith('/sendMessage'))).toHaveLength(0);
  });

  it('missing can_reply right → no send attempted', async () => {
    prisma.channelConnection.findUnique.mockResolvedValue(connectionRow({ canReply: false }));
    prisma.agent.findUnique.mockResolvedValue(personalAgent(true));

    await processTelegramEvent(eventRow(businessMessageUpdate()));
    expect(ai.calls).toHaveLength(0);
    expect(fetchCalls.filter((c) => c.url.endsWith('/sendMessage'))).toHaveLength(0);
  });

  it('connection disabled by the owner → no send attempted', async () => {
    prisma.channelConnection.findUnique.mockResolvedValue(connectionRow({ isEnabled: false }));
    prisma.agent.findUnique.mockResolvedValue(personalAgent(true));

    await processTelegramEvent(eventRow(businessMessageUpdate()));
    expect(ai.calls).toHaveLength(0);
    expect(fetchCalls.filter((c) => c.url.endsWith('/sendMessage'))).toHaveLength(0);
  });

  it('message older than the 24h business window → skipped before any send', async () => {
    prisma.channelConnection.findUnique.mockResolvedValue(connectionRow());
    prisma.agent.findUnique.mockResolvedValue(personalAgent(true));

    await processTelegramEvent(
      eventRow(businessMessageUpdate({ date: Math.floor(Date.now() / 1000) - 24 * 3600 })),
    );
    expect(ai.calls).toHaveLength(0);
    expect(fetchCalls.filter((c) => c.url.endsWith('/sendMessage'))).toHaveLength(0);
  });
});

describe('TelegramClient business methods', () => {
  beforeEach(() => {
    initLogger('silent', false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sendMessage forwards business_connection_id; setWebhook subscribes to business updates', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any, init?: any) => {
        calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 5 }, date: 0 } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const client = new TelegramClient('123:token');
    await client.sendMessage(5, 'hello', { businessConnectionId: 'biz-9' });
    expect(calls[0]!.body.business_connection_id).toBe('biz-9');

    await client.setWebhook({ url: 'https://x.example/api', secretToken: 's' });
    const allowed = calls[1]!.body.allowed_updates as string[];
    for (const t of ['business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages']) {
      expect(allowed).toContain(t);
    }
  });
});
