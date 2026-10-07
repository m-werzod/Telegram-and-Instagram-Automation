/**
 * Moving the platform onto a DIFFERENT Telegram bot or Instagram account.
 *
 * The thing worth testing is not that the new account starts working — that is
 * the ordinary connect path — but that the OLD one genuinely stops. Overwriting
 * the stored token alone leaves the previous owner's account wired to this
 * server: Telegram keeps pushing its updates at a webhook nobody deletes, Meta
 * keeps delivering the previous account's comments and DMs, and the stale
 * business connections of the old bot keep showing up on the new owner's
 * dashboard. None of that surfaces as an error anywhere, which is exactly why
 * it needs a test rather than an inspection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../../src/lib/crypto.js';
import { initLogger } from '../../src/lib/logger.js';
import {
  connectTelegram,
  disconnectTelegram,
} from '../../src/modules/channels/telegram/service.js';
import {
  connectInstagram,
  disconnectInstagram,
} from '../../src/modules/channels/instagram/service.js';
import { makeTestEnv, TEST_ENCRYPTION_KEY } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';

const OLD_BOT_TOKEN = '111111:OLDoldOLDoldOLDoldOLDold';
const NEW_BOT_TOKEN = '222222:NEWnewNEWnewNEWnewNEWnew';

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** The Telegram connection as it exists before the swap. */
function telegramConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-tg',
    tenantId: 'tenant-1',
    channel: 'TELEGRAM',
    status: 'connected',
    displayName: '@old_bot',
    externalAccountId: '111111',
    credentialsEncrypted: encryptSecret(
      JSON.stringify({ botToken: OLD_BOT_TOKEN }),
      TEST_ENCRYPTION_KEY,
    ),
    webhookSecret: 'old-secret',
    metadata: { botUsername: 'old_bot', channelMode: 'webhook', webhookUrl: 'https://old' },
    ...overrides,
  };
}

function instagramConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-ig',
    tenantId: 'tenant-1',
    channel: 'INSTAGRAM',
    status: 'connected',
    displayName: '@old_account',
    externalAccountId: '900900',
    credentialsEncrypted: encryptSecret(
      JSON.stringify({ accessToken: 'IGOLDTOKEN0000000000', obtainedAt: Date.now() }),
      TEST_ENCRYPTION_KEY,
    ),
    metadata: { username: 'old_account' },
    ...overrides,
  };
}

describe('switching the automated Telegram bot', () => {
  const fetchMock = vi.fn();
  let prisma: ReturnType<typeof mockPrisma>;
  /** Telegram calls made with the OLD bot's token, by method name. */
  let oldBotCalls: string[];
  /** The ChannelConnection row as the mocked database currently holds it. */
  let stored: Record<string, unknown> | null;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
    oldBotCalls = [];
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      // APP_URL reachability self-probe — answer as this server so the connect
      // path takes the webhook branch and never starts a polling loop.
      if (url.endsWith('/api/health')) return json({ status: 'ok', db: 'ok' });

      const method = url.split('/').pop() ?? '';
      if (url.includes(OLD_BOT_TOKEN)) oldBotCalls.push(method);

      if (method === 'getMe') {
        return url.includes(NEW_BOT_TOKEN)
          ? json({ ok: true, result: { id: 222222, is_bot: true, first_name: 'New', username: 'new_bot' } })
          : json({ ok: true, result: { id: 111111, is_bot: true, first_name: 'Old', username: 'old_bot' } });
      }
      if (method === 'getWebhookInfo') {
        return json({
          ok: true,
          result: { url: 'https://test.example.com/api/webhooks/telegram/conn-tg', pending_update_count: 0 },
        });
      }
      return json({ ok: true, result: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    // The row has to actually change when it is written: connectTelegram reads
    // it back to configure the webhook, and a mock that keeps handing out the
    // OLD token would have the new bot's setup run against the old bot.
    stored = telegramConnection();
    prisma.channelConnection.findUnique.mockImplementation(async () => stored);
    prisma.channelConnection.upsert.mockImplementation(async (args: unknown) => {
      const { update } = args as { update: Record<string, unknown> };
      stored = { ...telegramConnection(), ...update };
      return stored;
    });
    prisma.telegramPersonalAccount.deleteMany.mockResolvedValue({ count: 2 });
    prisma.telegramPersonalAccount.findMany.mockResolvedValue([]);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('deletes the OLD bot’s webhook, using the old token', async () => {
    await connectTelegram('tenant-1', NEW_BOT_TOKEN);

    expect(oldBotCalls).toContain('deleteWebhook');
    // Proof it was the old bot being released, not the new one being reset.
    const deleteCalls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.endsWith('/deleteWebhook'));
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toContain(OLD_BOT_TOKEN);
  });

  it('drops the personal accounts connected to the old bot', async () => {
    // Business connection ids are issued per bot. Kept, they would show the
    // previous owner's personal Telegram on the new owner's dashboard.
    await connectTelegram('tenant-1', NEW_BOT_TOKEN);

    expect(prisma.telegramPersonalAccount.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1' },
    });
  });

  it('starts the new bot from clean metadata instead of inheriting the old one’s', async () => {
    await connectTelegram('tenant-1', NEW_BOT_TOKEN);

    const upsert = prisma.channelConnection.upsert.mock.calls[0]![0] as {
      update: { metadata: Record<string, unknown> };
    };
    expect(upsert.update.metadata.botUsername).toBe('new_bot');
    // The old bot's webhook URL and transport mode describe an account that is
    // no longer automated.
    expect(upsert.update.metadata.webhookUrl).toBeUndefined();
    expect(upsert.update.metadata.channelMode).toBeUndefined();
    expect(upsert.update.metadata.previousAccount).toMatchObject({
      displayName: '@old_bot',
      externalAccountId: '111111',
      released: true,
    });
  });

  it('records the swap in the audit log', async () => {
    await connectTelegram('tenant-1', NEW_BOT_TOKEN);

    const audit = prisma.auditLog.create.mock.calls
      .map((c) => (c[0] as { data: { action: string; detail?: Record<string, unknown> } }).data)
      .find((d) => d.action === 'connection.telegram.switched');
    expect(audit).toBeDefined();
    expect(audit!.detail).toMatchObject({ droppedPersonalAccounts: 2, previousBotReleased: true });
  });

  it('completes the swap even when the old bot can no longer be reached', async () => {
    // A token revoked in @BotFather answers 401. The handover must still happen
    // — and must say the old webhook was not deleted rather than imply it was.
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/api/health')) return json({ status: 'ok', db: 'ok' });
      const method = url.split('/').pop() ?? '';
      if (url.includes(OLD_BOT_TOKEN)) {
        oldBotCalls.push(method);
        return json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
      }
      if (method === 'getMe') {
        return json({ ok: true, result: { id: 222222, is_bot: true, first_name: 'New', username: 'new_bot' } });
      }
      if (method === 'getWebhookInfo') {
        return json({
          ok: true,
          result: { url: 'https://test.example.com/api/webhooks/telegram/conn-tg', pending_update_count: 0 },
        });
      }
      return json({ ok: true, result: true });
    });

    await expect(connectTelegram('tenant-1', NEW_BOT_TOKEN)).resolves.toBeDefined();

    const upsert = prisma.channelConnection.upsert.mock.calls[0]![0] as {
      update: { metadata: { previousAccount: { released: boolean; error: string | null } } };
    };
    expect(upsert.update.metadata.previousAccount.released).toBe(false);
    expect(upsert.update.metadata.previousAccount.error).toMatch(/Unauthorized|401/);
  });

  it('leaves everything in place when the SAME bot reconnects', async () => {
    // Re-pasting the same token is how an operator refreshes a connection.
    // Treating that as a swap would wipe the owner's personal-account setup.
    await connectTelegram('tenant-1', OLD_BOT_TOKEN);

    expect(prisma.telegramPersonalAccount.deleteMany).not.toHaveBeenCalled();
    expect(oldBotCalls).not.toContain('deleteWebhook');
    const upsert = prisma.channelConnection.upsert.mock.calls[0]![0] as {
      update: { metadata: Record<string, unknown> };
    };
    expect(upsert.update.metadata.previousAccount).toBeUndefined();
    expect(upsert.update.metadata.profile).toBeUndefined();
  });

  it('does not treat a first-ever connect as a swap', async () => {
    stored = null; // nothing connected yet

    await connectTelegram('tenant-1', NEW_BOT_TOKEN);

    expect(prisma.telegramPersonalAccount.deleteMany).not.toHaveBeenCalled();
    expect(oldBotCalls).toHaveLength(0);
  });

  // Deleting the row forgets the connection; it does not end it. The bot keeps
  // reply permission on the previous owner's chats until they remove it.
  it('tells the previous owner to disconnect the old bot in Chat Automation', async () => {
    prisma.telegramPersonalAccount.findMany.mockResolvedValue([
      { ownerUsername: 'WerzodUsmanov', ownerName: 'Sherzod' },
    ]);

    await connectTelegram('tenant-1', NEW_BOT_TOKEN);

    const action = prisma.manualAction.upsert.mock.calls
      .map((c) => (c[0] as { create: { dedupKey: string; steps: string[]; title: string } }).create)
      .find((a) => a.dedupKey.startsWith('telegram-business-disconnect'));
    expect(action).toBeDefined();
    expect(action!.title).toContain('@WerzodUsmanov');
    expect(action!.steps.join(' ')).toMatch(/Chat Automation/);
  });

  it('raises no disconnect task when no personal account was connected', async () => {
    prisma.telegramPersonalAccount.findMany.mockResolvedValue([]);
    await connectTelegram('tenant-1', NEW_BOT_TOKEN);

    const keys = prisma.manualAction.upsert.mock.calls.map(
      (c) => (c[0] as { create: { dedupKey: string } }).create.dedupKey,
    );
    expect(keys.some((k) => k.startsWith('telegram-business-disconnect'))).toBe(false);
  });

  it('deletes the webhook when an administrator disconnects', async () => {
    await disconnectTelegram('tenant-1');

    expect(oldBotCalls).toContain('deleteWebhook');
    const update = prisma.channelConnection.update.mock.calls[0]![0] as {
      data: { credentialsEncrypted: string; status: string };
    };
    expect(update.data.status).toBe('disconnected');
    expect(update.data.credentialsEncrypted).toBe('');
  });
});

describe('switching the automated Instagram account', () => {
  const fetchMock = vi.fn();
  let prisma: ReturnType<typeof mockPrisma>;
  /** [method, url] of every Instagram Graph call. */
  let calls: Array<[string, string]>;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
    calls = [];
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      if (url.endsWith('/api/health')) return json({ status: 'ok', db: 'ok' });
      calls.push([init?.method ?? 'GET', url]);
      if (url.includes('/me?') || url.includes('/me/?') || /\/me($|\?)/.test(url)) {
        return json({ user_id: '800800', username: 'new_account', account_type: 'BUSINESS' });
      }
      return json({ success: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    prisma.channelConnection.findUnique.mockResolvedValue(instagramConnection());
    prisma.channelConnection.upsert.mockResolvedValue(instagramConnection({ id: 'conn-ig' }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('unsubscribes the OLD account’s webhooks, using the old token', async () => {
    await connectInstagram('tenant-1', 'IGNEWTOKEN0000000000');

    const unsubscribe = calls.filter(
      ([method, url]) => method === 'DELETE' && url.includes('/me/subscribed_apps'),
    );
    expect(unsubscribe).toHaveLength(1);
    // Only the old token can tell Meta to stop sending the old account's events.
    expect(unsubscribe[0]![1]).toContain('subscribed_apps');
    const authHeaders = fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('subscribed_apps') && (c[1] as { method?: string })?.method === 'DELETE')
      .map((c) => (c[1] as { headers: Record<string, string> }).headers.authorization);
    expect(authHeaders).toEqual(['Bearer IGOLDTOKEN0000000000']);
  });

  it('subscribes the NEW account after releasing the old one', async () => {
    await connectInstagram('tenant-1', 'IGNEWTOKEN0000000000');

    const subscribe = fetchMock.mock.calls.find(
      (c) => String(c[0]).includes('subscribed_apps') && (c[1] as { method?: string })?.method === 'POST',
    );
    expect(subscribe).toBeDefined();
    expect((subscribe![1] as { headers: Record<string, string> }).headers.authorization).toBe(
      'Bearer IGNEWTOKEN0000000000',
    );
  });

  it('records which account was released on the connection', async () => {
    await connectInstagram('tenant-1', 'IGNEWTOKEN0000000000');

    const upsert = prisma.channelConnection.upsert.mock.calls[0]![0] as {
      update: { metadata: Record<string, unknown> };
    };
    expect(upsert.update.metadata.previousAccount).toMatchObject({
      displayName: '@old_account',
      externalAccountId: '900900',
      released: true,
    });
  });

  it('leaves the subscription alone when the SAME account reconnects', async () => {
    // Pasting a refreshed 60-day token for the same account must not
    // unsubscribe it — that would silence the automation it is renewing.
    prisma.channelConnection.findUnique.mockResolvedValue(
      instagramConnection({ externalAccountId: '800800' }),
    );

    await connectInstagram('tenant-1', 'IGNEWTOKEN0000000000');

    expect(calls.filter(([m]) => m === 'DELETE')).toHaveLength(0);
  });

  it('completes the swap even when the old token is already revoked', async () => {
    fetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      if (url.endsWith('/api/health')) return json({ status: 'ok', db: 'ok' });
      const auth = (init as { headers?: Record<string, string> })?.headers?.authorization;
      if (auth === 'Bearer IGOLDTOKEN0000000000') {
        return json({ error: { message: 'Invalid OAuth access token', code: 190 } }, 401);
      }
      calls.push([init?.method ?? 'GET', url]);
      if (/\/me($|\?)/.test(url)) {
        return json({ user_id: '800800', username: 'new_account', account_type: 'BUSINESS' });
      }
      return json({ success: true });
    });

    await expect(connectInstagram('tenant-1', 'IGNEWTOKEN0000000000')).resolves.toBeDefined();

    const upsert = prisma.channelConnection.upsert.mock.calls[0]![0] as {
      update: { metadata: { previousAccount: { released: boolean; error: string | null } } };
    };
    expect(upsert.update.metadata.previousAccount.released).toBe(false);
    expect(upsert.update.metadata.previousAccount.error).toMatch(/OAuth|190|401/);
  });

  // Unsubscribing stops DELIVERY; it does not revoke the token this platform
  // holds. Only the account's owner can do that, and no API can do it for them
  // — so the step is raised whether or not the unsubscribe itself worked.
  it('tells the previous owner to revoke app access, even on a clean release', async () => {
    await connectInstagram('tenant-1', 'IGNEWTOKEN0000000000');

    const action = prisma.manualAction.upsert.mock.calls
      .map((c) => (c[0] as { create: { dedupKey: string; steps: string[]; title: string } }).create)
      .find((a) => a.dedupKey === 'ig-revoke-900900');
    expect(action).toBeDefined();
    expect(action!.title).toContain('@old_account');
    expect(action!.steps.join(' ')).toMatch(/Apps and websites/);
  });

  it('says the subscription is still live when the unsubscribe failed', async () => {
    fetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      if (url.endsWith('/api/health')) return json({ status: 'ok', db: 'ok' });
      const auth = (init as { headers?: Record<string, string> })?.headers?.authorization;
      if (auth === 'Bearer IGOLDTOKEN0000000000') {
        return json({ error: { message: 'Unsupported delete request', code: 100 } }, 400);
      }
      if (/\/me($|\?)/.test(url)) {
        return json({ user_id: '800800', username: 'new_account', account_type: 'BUSINESS' });
      }
      return json({ success: true });
    });

    await connectInstagram('tenant-1', 'IGNEWTOKEN0000000000');

    const action = prisma.manualAction.upsert.mock.calls
      .map((c) => (c[0] as { create: { dedupKey: string; steps: string[] } }).create)
      .find((a) => a.dedupKey === 'ig-revoke-900900');
    expect(action!.steps[0]).toMatch(/could NOT be switched off/);
    expect(action!.steps[0]).toMatch(/Unsupported delete request|100/);
  });

  it('unsubscribes before discarding the token on disconnect', async () => {
    await disconnectInstagram('tenant-1');

    expect(calls.some(([m, u]) => m === 'DELETE' && u.includes('subscribed_apps'))).toBe(true);
    const update = prisma.channelConnection.update.mock.calls[0]![0] as {
      data: { credentialsEncrypted: string };
    };
    expect(update.data.credentialsEncrypted).toBe('');
  });

  it('says so in the health detail when Meta could not be told to stop', async () => {
    fetchMock.mockImplementation(async () => json({ error: { message: 'oops', code: 1 } }, 500));

    await disconnectInstagram('tenant-1');

    const update = prisma.channelConnection.update.mock.calls[0]![0] as {
      data: { healthDetail: string };
    };
    expect(update.data.healthDetail).toMatch(/Apps and websites/);
  });
});
