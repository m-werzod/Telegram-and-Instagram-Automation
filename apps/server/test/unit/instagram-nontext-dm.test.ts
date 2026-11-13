/**
 * A customer who sends a photo, a voice note or a shared post.
 *
 * This used to be dropped at the door: the handler returned before storing
 * anything, logging "non-text message — recorded only" while recording
 * nothing. The customer got total silence, and the operator saw no trace of
 * them having written at all — so on a channel where people routinely send a
 * photo of a document or a voice note instead of typing, a real enquiry simply
 * disappeared. The Telegram channel had already settled on the right answer:
 * store it, and ask for it in writing.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { encryptSecret } from '../../src/lib/crypto.js';
import { initLogger } from '../../src/lib/logger.js';
import { processInstagramEvent } from '../../src/modules/channels/instagram/handler.js';
import { VOICE_NOT_SUPPORTED_REPLY } from '../../src/modules/engine/language.js';
import { makeTestEnv, TEST_ENCRYPTION_KEY } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';

const ACCOUNT_ID = '17841400000000000';
const IGSID = 'igsid-customer-1';

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function dmEvent(message: Record<string, unknown>) {
  return {
    id: 'evt-1',
    channel: 'INSTAGRAM',
    tenantId: 'tenant-1',
    attempts: 1,
    payload: {
      kind: 'dm',
      accountId: ACCOUNT_ID,
      messaging: { sender: { id: IGSID }, timestamp: Date.now(), message },
    },
  } as never;
}

describe('a non-text Instagram DM', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let sent: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
    sent = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
        const url = String(input);
        if (init?.method === 'POST' && url.includes('/me/messages')) {
          sent.push({ url, body: JSON.parse(init.body ?? '{}') });
          return json({ message_id: 'mid-out-1', recipient_id: IGSID });
        }
        if (url.includes('/me/subscribed_apps')) {
          return json({ data: [{ subscribed_fields: ['comments', 'messages'] }] });
        }
        return json({ username: 'customer', name: 'Customer' });
      }),
    );

    const connection = {
      id: 'conn-ig',
      tenantId: 'tenant-1',
      channel: 'INSTAGRAM',
      status: 'connected',
      displayName: '@avtomaktab_turon',
      externalAccountId: ACCOUNT_ID,
      credentialsEncrypted: encryptSecret(
        JSON.stringify({ accessToken: 'IGTOKEN00000000000000', obtainedAt: Date.now() }),
        TEST_ENCRYPTION_KEY,
      ),
      metadata: {},
      createdAt: new Date(),
    };
    prisma.channelConnection.findFirst.mockResolvedValue({ id: 'conn-ig', tenantId: 'tenant-1' });
    prisma.channelConnection.findUnique.mockResolvedValue(connection);
    prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', name: 'Turon Avtomaktab' });
    prisma.lead.create.mockResolvedValue({ id: 'lead-1', username: 'customer', name: 'Customer' });
    prisma.lead.findUnique.mockResolvedValue({ id: 'lead-1', username: 'customer', name: 'Customer' });
    prisma.conversation.upsert.mockResolvedValue({ id: 'conv-1' });
    prisma.conversationMessage.create.mockResolvedValue({ id: 'msg-1' });
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-dm',
      tenantId: 'tenant-1',
      type: 'INSTAGRAM_DM',
      enabled: true,
      settings: {},
      escalationRules: {},
    });
    prisma.idempotencyKey.create.mockResolvedValue({ id: 'idem-1' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is stored as an inbound message instead of being thrown away', async () => {
    await processInstagramEvent(dmEvent({ mid: 'mid-photo', attachments: [{ type: 'image' }] }));

    const inbound = prisma.conversationMessage.create.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.direction === 'INBOUND');
    expect(inbound).toBeDefined();
    expect(inbound!.content).toBe('(image)');
    expect(inbound!.externalMessageId).toBe('mid-photo');
    expect((inbound!.metadata as { nonText?: boolean }).nonText).toBe(true);
  });

  it('answers the customer asking for it in writing', async () => {
    await processInstagramEvent(dmEvent({ mid: 'mid-voice', attachments: [{ type: 'audio' }] }));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({
      recipient: { id: IGSID },
      message: { text: VOICE_NOT_SUPPORTED_REPLY },
    });
  });

  it('counts as processed, not skipped — the customer was answered', async () => {
    await processInstagramEvent(dmEvent({ mid: 'mid-sticker', attachments: [{ type: 'image' }] }));

    const update = prisma.webhookEvent.update.mock.calls[0]![0] as {
      data: { status: string; error?: string };
    };
    expect(update.data.status).toBe('PROCESSED');
    expect(update.data.error).toMatch(/asked the customer to write in Uzbek/);
  });

  it('does not answer twice when the queue retries the same message', async () => {
    // Second claim on the same mid is refused by the idempotency table.
    prisma.idempotencyKey.create
      .mockResolvedValueOnce({ id: 'idem-1' })
      .mockRejectedValueOnce(
        Object.assign(
          new (await import('@prisma/client')).Prisma.PrismaClientKnownRequestError(
            'Unique constraint failed',
            { code: 'P2002', clientVersion: 'test' },
          ),
        ),
      );

    const event = dmEvent({ mid: 'mid-retry', attachments: [{ type: 'image' }] });
    await processInstagramEvent(event);
    await processInstagramEvent(event);

    expect(sent).toHaveLength(1);
  });

  it('records but does not answer when the DM agent is switched off', async () => {
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-dm',
      type: 'INSTAGRAM_DM',
      enabled: false,
      settings: {},
      escalationRules: {},
    });

    await processInstagramEvent(dmEvent({ mid: 'mid-off', attachments: [{ type: 'image' }] }));

    const inbound = prisma.conversationMessage.create.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.direction === 'INBOUND');
    expect(inbound).toBeDefined();
    expect(sent).toHaveLength(0);
  });
});
