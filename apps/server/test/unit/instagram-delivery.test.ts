/**
 * Can an Instagram comment or DM actually REACH this server?
 *
 * This is the failure these tests exist for: Instagram has no polling mode, so
 * every customer message arrives by a Meta-initiated POST, and that only
 * happens while the account is subscribed via `POST /me/subscribed_apps`. That
 * subscription used to be attempted exactly once, at connect time, with a
 * failure recorded only as a log line and a health status that the NEXT health
 * check (token valid ⇒ CONNECTED) promptly overwrote. From then on the
 * dashboard was green, no banner fired, nothing retried, and not one comment
 * or message could ever arrive — which is indistinguishable, from the outside,
 * from the automation simply being broken.
 *
 * So the subscription is read back from Meta, repaired, and allowed to fail the
 * health check. These tests hold that in place.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { encryptSecret } from '../../src/lib/crypto.js';
import { initLogger } from '../../src/lib/logger.js';
import {
  checkInstagramHealth,
  ensureInstagramSubscription,
  resolveInstagramConnection,
} from '../../src/modules/channels/instagram/service.js';
import { makeTestEnv, TEST_ENCRYPTION_KEY } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function igConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-ig',
    tenantId: 'tenant-1',
    channel: 'INSTAGRAM' as const,
    status: 'connected',
    displayName: '@avtomaktab_turon',
    externalAccountId: '17841400000000000',
    credentialsEncrypted: encryptSecret(
      JSON.stringify({ accessToken: 'IGTOKEN00000000000000', obtainedAt: Date.now() }),
      TEST_ENCRYPTION_KEY,
    ),
    metadata: { username: 'avtomaktab_turon' },
    createdAt: new Date(Date.now() - 10 * 86_400_000),
    ...overrides,
  } as never;
}

/**
 * A fake graph.instagram.com. `subscribed` is the server-side subscription
 * state, so a POST actually changes what a later GET reports — the point being
 * that the code must believe Meta, not its own optimism.
 */
function stubGraph(opts: {
  subscribed?: string[];
  /** Field sets the POST refuses (e.g. live_comments needs Advanced Access). */
  rejectFields?: string[];
  /** Make every POST /me/subscribed_apps fail. */
  subscribeFails?: boolean;
  /** Make GET /me/subscribed_apps fail (write-only edge). */
  readFails?: boolean;
}) {
  let subscribed = [...(opts.subscribed ?? [])];
  const calls: Array<{ method: string; url: string }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/health')) return json({ status: 'ok', db: 'ok' });
    calls.push({ method, url });

    if (url.includes('/me/subscribed_apps')) {
      if (method === 'POST') {
        if (opts.subscribeFails) {
          return json({ error: { message: 'permission denied', code: 10 } }, 403);
        }
        const asked = new URL(url).searchParams.get('subscribed_fields')?.split(',') ?? [];
        const rejected = asked.filter((f) => (opts.rejectFields ?? []).includes(f));
        if (rejected.length > 0) {
          return json({ error: { message: `unsupported field ${rejected[0]}`, code: 100 } }, 400);
        }
        subscribed = asked;
        return json({ success: true });
      }
      if (opts.readFails) {
        return json({ error: { message: 'unsupported get request', code: 100 } }, 400);
      }
      return json({ data: [{ name: 'App', subscribed_fields: subscribed }] });
    }
    if (/\/me(\?|$)/.test(url)) {
      return json({ user_id: '17841400000000000', username: 'avtomaktab_turon', account_type: 'BUSINESS' });
    }
    if (url.includes('refresh_access_token')) {
      return json({ access_token: 'IGTOKENREFRESHED00000', expires_in: 5_184_000 });
    }
    return json({ success: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    get subscribed() {
      return subscribed;
    },
    posts: () => calls.filter((c) => c.method === 'POST' && c.url.includes('subscribed_apps')),
  };
}

describe('Instagram webhook subscription', () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('accepts an account Meta already reports as subscribed, without re-subscribing', async () => {
    const graph = stubGraph({ subscribed: ['comments', 'messages'] });
    const state = await ensureInstagramSubscription(igConnection());

    expect(state.ok).toBe(true);
    expect(state.missing).toEqual([]);
    expect(state.repaired).toBe(false);
    expect(graph.posts()).toHaveLength(0);
  });

  it('repairs an account that is subscribed to nothing', async () => {
    const graph = stubGraph({ subscribed: [] });
    const state = await ensureInstagramSubscription(igConnection());

    expect(state.repaired).toBe(true);
    expect(state.ok).toBe(true);
    expect(graph.subscribed).toContain('comments');
    expect(graph.subscribed).toContain('messages');
  });

  it('repairs an account subscribed to comments only — the state in which DMs never arrive', async () => {
    const graph = stubGraph({ subscribed: ['comments'] });
    const state = await ensureInstagramSubscription(igConnection());

    expect(state.ok).toBe(true);
    expect(graph.subscribed).toContain('messages');
  });

  /**
   * `POST /me/subscribed_apps` rejects the WHOLE call if one field is
   * unavailable to the app. Asking for live_comments in a single shot would
   * therefore leave an app without Advanced Access subscribed to nothing at
   * all — strictly worse than not asking.
   */
  it('falls back to the required fields when the wider set is rejected', async () => {
    const graph = stubGraph({ subscribed: [], rejectFields: ['live_comments'] });
    const state = await ensureInstagramSubscription(igConnection());

    expect(state.ok).toBe(true);
    expect(graph.posts()).toHaveLength(2); // preferred, then required
    expect(graph.subscribed.sort()).toEqual(['comments', 'messages']);
  });

  it('reports failure and raises a manual action when it cannot subscribe at all', async () => {
    stubGraph({ subscribed: [], subscribeFails: true });
    const state = await ensureInstagramSubscription(igConnection());

    expect(state.ok).toBe(false);
    expect(state.missing).toEqual(['comments', 'messages']);
    const action = prisma.manualAction.upsert.mock.calls
      .map((c) => (c[0] as { create: { dedupKey: string; steps: string[] } }).create)
      .find((a) => a.dedupKey === 'ig-subscription-missing');
    expect(action).toBeDefined();
    expect(action!.steps.join(' ')).toMatch(/not one comment and not one direct message/i);
  });

  /**
   * An unreadable edge must not be mistaken for a healthy one: being wrong
   * that way costs every customer message, while being wrong the other way
   * costs one idempotent API call.
   */
  it('subscribes anyway when the subscription cannot be read back', async () => {
    const graph = stubGraph({ subscribed: [], readFails: true });
    const state = await ensureInstagramSubscription(igConnection());

    expect(graph.posts().length).toBeGreaterThan(0);
    expect(state.ok).toBe(true);
    expect(state.repaired).toBe(true);
  });

  it('does not touch Meta when asked only to report (repair: false)', async () => {
    const graph = stubGraph({ subscribed: [] });
    const state = await ensureInstagramSubscription(igConnection(), { repair: false });

    expect(state.ok).toBe(false);
    expect(graph.posts()).toHaveLength(0);
  });
});

describe('Instagram health check', () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
  });
  afterEach(() => vi.unstubAllGlobals());

  /**
   * The regression that made this whole class of outage invisible: a valid
   * token was reported as CONNECTED, overwriting the PERMISSION_REQUIRED that
   * the failed subscription had set at connect time.
   */
  it('does NOT report CONNECTED when Meta is not subscribed to deliver events', async () => {
    stubGraph({ subscribed: [], subscribeFails: true });
    const result = await checkInstagramHealth(igConnection());

    expect(result.status).toBe('PERMISSION_REQUIRED');
    expect(result.detail).toMatch(/NOT RECEIVING EVENTS/);
  });

  it('reports CONNECTED once the subscription and deliveries are both present', async () => {
    stubGraph({ subscribed: ['comments', 'messages'] });
    prisma.webhookEvent.count.mockResolvedValue(12);
    const result = await checkInstagramHealth(igConnection());

    expect(result.status).toBe('CONNECTED');
    expect(result.detail).toMatch(/webhook subscription/);
  });

  /**
   * Subscribed correctly and still nothing arriving means the app is in
   * Development mode or its app-level webhook is unverified — neither readable
   * from here, so it is reported rather than guessed.
   */
  it('reports DEGRADED when a day has passed and Meta has delivered nothing', async () => {
    stubGraph({ subscribed: ['comments', 'messages'] });
    prisma.webhookEvent.count.mockResolvedValue(0);
    const result = await checkInstagramHealth(igConnection());

    expect(result.status).toBe('DEGRADED');
    expect(result.detail).toMatch(/NO EVENTS EVER RECEIVED/);
    const keys = prisma.manualAction.upsert.mock.calls.map(
      (c) => (c[0] as { create: { dedupKey: string } }).create.dedupKey,
    );
    expect(keys).toContain('ig-nothing-ever-delivered');
  });

  it('stays quiet about an empty but freshly connected account', async () => {
    stubGraph({ subscribed: ['comments', 'messages'] });
    prisma.webhookEvent.count.mockResolvedValue(0);
    const result = await checkInstagramHealth(
      igConnection({ createdAt: new Date(Date.now() - 60_000) }),
    );

    expect(result.status).toBe('CONNECTED');
    expect(result.detail).toMatch(/no events received yet/);
  });

  /**
   * A transient refresh failure on a young token used to light up the
   * "automation is down" banner for days while every message was in fact being
   * answered. The token is only an outage when it is actually running out.
   */
  it('does not call a young token an outage when its refresh fails', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/api/health')) return json({ status: 'ok', db: 'ok' });
      if (url.includes('refresh_access_token')) {
        return json({ error: { message: 'temporarily unavailable', code: 2 } }, 500);
      }
      if (url.includes('/me/subscribed_apps')) {
        return json({ data: [{ subscribed_fields: ['comments', 'messages'] }] });
      }
      return json({ user_id: '17841400000000000', username: 'avtomaktab_turon' });
    });
    vi.stubGlobal('fetch', fetchMock);
    prisma.webhookEvent.count.mockResolvedValue(5);

    const young = igConnection({
      credentialsEncrypted: encryptSecret(
        JSON.stringify({ accessToken: 'IGTOKEN', obtainedAt: Date.now() - 10 * 86_400_000 }),
        TEST_ENCRYPTION_KEY,
      ),
    });
    const result = await checkInstagramHealth(young);
    expect(result.status).toBe('CONNECTED');
    expect(result.detail).toMatch(/token refresh failed, will retry/);
  });

  it('does call an old token an outage when its refresh fails', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/api/health')) return json({ status: 'ok', db: 'ok' });
      if (url.includes('refresh_access_token')) {
        return json({ error: { message: 'token expired', code: 190 } }, 401);
      }
      if (url.includes('/me/subscribed_apps')) {
        return json({ data: [{ subscribed_fields: ['comments', 'messages'] }] });
      }
      return json({ user_id: '17841400000000000', username: 'avtomaktab_turon' });
    });
    vi.stubGlobal('fetch', fetchMock);
    prisma.webhookEvent.count.mockResolvedValue(5);

    const old = igConnection({
      credentialsEncrypted: encryptSecret(
        JSON.stringify({ accessToken: 'IGTOKEN', obtainedAt: Date.now() - 52 * 86_400_000 }),
        TEST_ENCRYPTION_KEY,
      ),
    });
    const result = await checkInstagramHealth(old);
    expect(result.status).toBe('DEGRADED');
    expect(result.detail).toMatch(/expires at 60 days/);
  });
});

/**
 * `entry.id` on an incoming webhook against the account id stored at connect
 * time. Meta publishes two ids for the same professional account and which one
 * lands in `entry.id` has moved between apps and API versions; matching only
 * one of them drops EVERY event with no error at either end.
 */
describe('matching a webhook to its Instagram connection', () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
  });

  it('matches on the stored account id', async () => {
    prisma.channelConnection.findFirst.mockResolvedValue({ id: 'conn-ig', tenantId: 'tenant-1' });
    const match = await resolveInstagramConnection('17841400000000000');
    expect(match).toEqual({ id: 'conn-ig', tenantId: 'tenant-1' });
  });

  it('matches the account’s other id and remembers it for next time', async () => {
    prisma.channelConnection.findFirst.mockResolvedValue(null);
    prisma.channelConnection.findMany.mockResolvedValue([
      {
        id: 'conn-ig',
        tenantId: 'tenant-1',
        externalAccountId: '9999',
        displayName: '@a',
        metadata: { accountIds: ['9999', '17841400000000000'] },
      },
    ]);
    prisma.channelConnection.findUnique.mockResolvedValue({ metadata: { accountIds: ['9999'] } });

    const match = await resolveInstagramConnection('17841400000000000');
    expect(match).toEqual({ id: 'conn-ig', tenantId: 'tenant-1' });
    const learned = prisma.channelConnection.update.mock.calls[0]?.[0] as
      | { data: { metadata: { accountIds: string[] } } }
      | undefined;
    expect(learned?.data.metadata.accountIds).toContain('17841400000000000');
  });

  it('attributes an unknown id to the only connected account, and learns it', async () => {
    prisma.channelConnection.findFirst.mockResolvedValue(null);
    prisma.channelConnection.findMany.mockResolvedValue([
      { id: 'conn-ig', tenantId: 'tenant-1', externalAccountId: 'stale', displayName: '@a', metadata: {} },
    ]);
    prisma.channelConnection.findUnique.mockResolvedValue({ metadata: {} });

    const match = await resolveInstagramConnection('17841400000000000');
    expect(match).toEqual({ id: 'conn-ig', tenantId: 'tenant-1' });
  });

  /** With two candidates the guess would risk the wrong tenant, so it is not made. */
  it('refuses to guess when more than one Instagram account is connected', async () => {
    prisma.channelConnection.findFirst.mockResolvedValue(null);
    prisma.channelConnection.findMany.mockResolvedValue([
      { id: 'a', tenantId: 't1', externalAccountId: '1', displayName: '@a', metadata: {} },
      { id: 'b', tenantId: 't2', externalAccountId: '2', displayName: '@b', metadata: {} },
    ]);

    expect(await resolveInstagramConnection('17841400000000000')).toBeNull();
    expect(prisma.channelConnection.update).not.toHaveBeenCalled();
  });
});
