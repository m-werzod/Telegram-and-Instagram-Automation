/**
 * The CRM bot.
 *
 * This bot hands out customer names and phone numbers over Telegram, so the
 * tests that matter are the ones about who gets in and what leaks:
 *
 *   a wrong login and a wrong password must be indistinguishable, or the
 *   error message turns a password guess into a username oracle;
 *   guesses must lock out;
 *   a button pressed after a session is revoked must be refused, because the
 *   payload carries a registration id and would otherwise read it out;
 *   the password message must be deleted from the chat once checked;
 *   and the bot must show REGISTRATIONS, never the message firehose.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initLogger } from '../../src/lib/logger.js';
import { makeTestEnv } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';
import { hashPassword } from '../../src/lib/crypto.js';
import {
  attemptLogin,
  isAuthenticated,
  renderList,
  statusKeyboard,
  formatRegistration,
} from '../../src/modules/crm-bot/service.js';
import { handleCrmBotUpdate } from '../../src/modules/crm-bot/handler.js';
import type { TelegramClient } from '../../src/modules/channels/telegram/client.js';

const TENANT = 'tenant-1';

function fakeClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue([{ message_id: 1 }]),
    editMessageText: vi.fn().mockResolvedValue(true),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
  } as unknown as TelegramClient & {
    sendMessage: ReturnType<typeof vi.fn>;
    answerCallbackQuery: ReturnType<typeof vi.fn>;
    deleteMessage: ReturnType<typeof vi.fn>;
    editMessageText: ReturnType<typeof vi.fn>;
  };
}

function registration(over: Record<string, unknown> = {}) {
  return {
    id: 'reg-1',
    fullName: 'Akobir Rahimov',
    phone: '+998901234567',
    course: 'B toifa',
    preferredTime: null,
    sourceChannel: 'TELEGRAM',
    sourceAccount: '@turon',
    status: 'NEW',
    createdAt: new Date('2026-10-17T09:00:00Z'),
    ...over,
  };
}

describe('login', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let hash: string;

  beforeEach(async () => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
    hash = await hashPassword('Admin3737');
    prisma.crmBotSession.upsert.mockResolvedValue({
      id: 's-1',
      telegramUserId: '42',
      failedAttempts: 0,
      lockedUntil: null,
    });
  });

  const login = (text: string) =>
    attemptLogin({
      tenantId: TENANT,
      telegramUserId: '42',
      telegramChatId: '42',
      telegramName: 'Sherzod',
      text,
    });

  it('accepts the dashboard login and password', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      username: 'Admin',
      name: 'Administrator',
      tenantId: TENANT,
      passwordHash: hash,
      role: 'ADMIN',
    });

    const res = await login('Admin Admin3737');
    expect(res.ok).toBe(true);
    // The session is what grants access; it must actually be written.
    const data = (prisma.crmBotSession.update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.userId).toBe('u-1');
    expect(data.failedAttempts).toBe(0);
  });

  it('accepts login:password on one line too', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1', username: 'Admin', name: 'A', tenantId: TENANT, passwordHash: hash, role: 'ADMIN',
    });
    expect((await login('Admin:Admin3737')).ok).toBe(true);
  });

  // Telling someone WHICH half was wrong turns a password guess into a
  // username check.
  it('gives the same answer for an unknown user and a wrong password', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const unknownUser = await login('Nobody whatever');

    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1', username: 'Admin', name: 'A', tenantId: TENANT, passwordHash: hash, role: 'ADMIN',
    });
    const wrongPassword = await login('Admin wrong-password');

    expect(unknownUser.ok).toBe(false);
    expect(wrongPassword.ok).toBe(false);
    expect(unknownUser.message).toBe(wrongPassword.message);
  });

  it('refuses a correct password from another tenant', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-9', username: 'Admin', name: 'A', tenantId: 'other-tenant', passwordHash: hash, role: 'ADMIN',
    });
    expect((await login('Admin Admin3737')).ok).toBe(false);
  });

  it('locks the Telegram account out after repeated guesses', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.crmBotSession.upsert.mockResolvedValue({
      id: 's-1', telegramUserId: '42', failedAttempts: 4, lockedUntil: null,
    });

    const res = await login('Admin guess');
    expect(res.ok).toBe(false);
    const data = (prisma.crmBotSession.update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.failedAttempts).toBe(5);
    expect(data.lockedUntil).toBeInstanceOf(Date);
  });

  it('refuses while locked, without even checking the password', async () => {
    prisma.crmBotSession.upsert.mockResolvedValue({
      id: 's-1',
      telegramUserId: '42',
      failedAttempts: 5,
      lockedUntil: new Date(Date.now() + 10 * 60_000),
    });

    const res = await login('Admin Admin3737');
    expect(res.ok).toBe(false);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('asks for both halves when only one is given', async () => {
    const res = await login('Admin');
    expect(res.ok).toBe(false);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('session gate', () => {
  it('treats only a non-revoked session with a user as signed in', () => {
    expect(isAuthenticated(null)).toBe(false);
    expect(isAuthenticated({ userId: null, revokedAt: null } as never)).toBe(false);
    expect(isAuthenticated({ userId: 'u-1', revokedAt: new Date() } as never)).toBe(false);
    expect(isAuthenticated({ userId: 'u-1', revokedAt: null } as never)).toBe(true);
  });
});

describe('handling updates', () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
  });

  const privateMessage = (text: string) => ({
    update_id: 1,
    message: {
      message_id: 99,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: 'private' as const },
      from: { id: 42, is_bot: false, first_name: 'Sherzod' },
      text,
    },
  });

  // A password in a chat is a password in a chat log.
  it('deletes the message carrying the password once it has been checked', async () => {
    prisma.crmBotSession.findUnique.mockResolvedValue(null);
    prisma.crmBotSession.upsert.mockResolvedValue({
      id: 's-1', telegramUserId: '42', failedAttempts: 0, lockedUntil: null,
    });
    prisma.user.findUnique.mockResolvedValue(null);
    const client = fakeClient();

    await handleCrmBotUpdate({ tenantId: TENANT, client, update: privateMessage('Admin wrong') as never });

    expect(client.deleteMessage).toHaveBeenCalledWith('42', 99);
  });

  it('does not reveal anything before sign-in', async () => {
    prisma.crmBotSession.findUnique.mockResolvedValue(null);
    prisma.crmBotSession.upsert.mockResolvedValue({
      id: 's-1', telegramUserId: '42', failedAttempts: 0, lockedUntil: null,
    });
    prisma.user.findUnique.mockResolvedValue(null);
    const client = fakeClient();

    await handleCrmBotUpdate({ tenantId: TENANT, client, update: privateMessage('/start') as never });

    const sent = client.sendMessage.mock.calls.map((c) => String(c[1])).join(' ');
    expect(sent).toMatch(/login/i);
    expect(prisma.courseRegistration.findMany).not.toHaveBeenCalled();
  });

  // A button lives in the chat forever and carries a registration id.
  it('refuses a button pressed after the session was revoked', async () => {
    prisma.crmBotSession.findUnique.mockResolvedValue({
      telegramUserId: '42', userId: 'u-1', revokedAt: new Date(),
    });
    const client = fakeClient();

    await handleCrmBotUpdate({
      tenantId: TENANT,
      client,
      update: {
        update_id: 2,
        callback_query: {
          id: 'cb-1',
          from: { id: 42, is_bot: false, first_name: 'S' },
          data: 'open:reg-1',
          message: { message_id: 5, date: 0, chat: { id: 42, type: 'private' } },
        },
      } as never,
    });

    expect(prisma.courseRegistration.findFirst).not.toHaveBeenCalled();
    expect(client.answerCallbackQuery).toHaveBeenCalledWith(
      'cb-1',
      expect.objectContaining({ showAlert: true }),
    );
  });

  it('scopes an opened registration to the caller’s tenant', async () => {
    prisma.crmBotSession.findUnique.mockResolvedValue({
      telegramUserId: '42', userId: 'u-1', revokedAt: null, telegramName: 'S',
    });
    prisma.courseRegistration.findFirst.mockResolvedValue(registration());
    const client = fakeClient();

    await handleCrmBotUpdate({
      tenantId: TENANT,
      client,
      update: {
        update_id: 3,
        callback_query: {
          id: 'cb-2',
          from: { id: 42, is_bot: false, first_name: 'S' },
          data: 'open:reg-1',
          message: { message_id: 5, date: 0, chat: { id: 42, type: 'private' } },
        },
      } as never,
    });

    const where = (prisma.courseRegistration.findFirst.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ id: 'reg-1', tenantId: TENANT });
  });

  it('rejects an unknown status rather than writing it', async () => {
    prisma.crmBotSession.findUnique.mockResolvedValue({
      telegramUserId: '42', userId: 'u-1', revokedAt: null,
    });
    const client = fakeClient();

    await handleCrmBotUpdate({
      tenantId: TENANT,
      client,
      update: {
        update_id: 4,
        callback_query: {
          id: 'cb-3',
          from: { id: 42, is_bot: false, first_name: 'S' },
          data: 'set:reg-1:DROP_TABLE',
          message: { message_id: 5, date: 0, chat: { id: 42, type: 'private' } },
        },
      } as never,
    });

    expect(prisma.courseRegistration.update).not.toHaveBeenCalled();
  });
});

describe('what the bot shows', () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
  });

  // The whole point: registrations, not every message ever received.
  it('reads course registrations, never leads or conversations', async () => {
    prisma.courseRegistration.findMany.mockResolvedValue([registration()]);
    prisma.courseRegistration.count.mockResolvedValue(1);

    const page = await renderList(TENANT, 'NEW', 0);

    expect(prisma.courseRegistration.findMany).toHaveBeenCalled();
    expect(prisma.lead.findMany).not.toHaveBeenCalled();
    expect(prisma.conversation.findMany).not.toHaveBeenCalled();
    expect(page.text).toContain('Akobir Rahimov');
    expect(page.text).toContain('+998901234567');
  });

  it('filters by status, scoped to the tenant', async () => {
    prisma.courseRegistration.findMany.mockResolvedValue([]);
    prisma.courseRegistration.count.mockResolvedValue(0);

    await renderList(TENANT, 'ENROLLED', 0);
    const where = (prisma.courseRegistration.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ tenantId: TENANT, status: 'ENROLLED' });
  });

  it('explains an empty list instead of showing a blank screen', async () => {
    prisma.courseRegistration.findMany.mockResolvedValue([]);
    prisma.courseRegistration.count.mockResolvedValue(0);

    const page = await renderList(TENANT, 'NEW', 0);
    expect(page.text).toMatch(/ariza yo‘q/);
    expect(page.text).toMatch(/ism, telefon va kurs/);
  });

  it('offers every status except the one it already has', () => {
    const kb = statusKeyboard(registration({ status: 'NEW' }) as never);
    const labels = kb.inline_keyboard.flat().map((b) => b.callback_data ?? '');
    expect(labels.some((d) => d.endsWith(':NEW'))).toBe(false);
    expect(labels.some((d) => d.endsWith(':ENROLLED'))).toBe(true);
  });

  it('shows the phone, because calling them is the point', () => {
    const text = formatRegistration(registration() as never);
    expect(text).toContain('+998901234567');
    expect(text).toContain('B toifa');
    expect(text).toContain('Telegram');
  });
});
