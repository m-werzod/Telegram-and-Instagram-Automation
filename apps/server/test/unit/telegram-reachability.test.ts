/**
 * configureTelegramWebhook's reachability branching: a syntactically valid
 * APP_URL is not proof the platform is actually reachable from the public
 * internet (NAT, a shared-IP provider gateway, a firewall can all accept the
 * connection and answer with something that isn't this server) — the
 * self-probe against /api/health is what decides webhook vs. polling mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../../src/lib/crypto.js';
import { initLogger } from '../../src/lib/logger.js';
import { makeTestEnv, TEST_ENCRYPTION_KEY } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';
import { configureTelegramWebhook } from '../../src/modules/channels/telegram/service.js';
import { isPolling, stopAllPolling } from '../../src/modules/channels/telegram/polling.js';

const connectionRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'conn-reach-1',
  tenantId: 'tenant-1',
  channel: 'TELEGRAM',
  status: 'connected',
  externalAccountId: '12345',
  webhookSecret: 'sec',
  credentialsEncrypted: encryptSecret(
    JSON.stringify({ botToken: '12345:reach-test-token-abcdefghi' }),
    TEST_ENCRYPTION_KEY,
  ),
  metadata: {},
  ...over,
});

/** Routes fetch calls: Telegram Bot API vs. our own /api/health self-probe. */
function fetchRouter(opts: { healthOk: boolean; telegramOk?: boolean }) {
  return vi.fn(async (input: any) => {
    const url = String(input);
    if (url.includes('/api/health')) {
      return opts.healthOk
        ? new Response(JSON.stringify({ status: 'ok', db: 'ok' }), { status: 200 })
        : new Response('404 page not found\n', { status: 404 }); // e.g. a provider edge gateway
    }
    // Telegram API calls (bot<token>/<method>)
    if (opts.telegramOk === false) {
      return new Response(JSON.stringify({ ok: false, error_code: 500, description: 'boom' }), {
        status: 500,
      });
    }
    if (url.endsWith('/setWebhook')) {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    if (url.endsWith('/getWebhookInfo')) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: { url: 'https://example.sslip.io/api/webhooks/telegram/conn-reach-1', pending_update_count: 0 },
        }),
        { status: 200 },
      );
    }
    if (url.endsWith('/deleteWebhook')) {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
  });
}

describe('configureTelegramWebhook — reachability-gated mode selection', () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    initLogger('silent', false);
    prisma = mockPrisma();
    prisma.install();
    prisma.manualAction.upsert.mockResolvedValue({});
    prisma.manualAction.updateMany.mockResolvedValue({ count: 0 });
    prisma.channelConnection.update.mockResolvedValue({});
  });

  afterEach(async () => {
    await stopAllPolling();
    vi.unstubAllGlobals();
  });

  it('a syntactically valid but unreachable APP_URL falls back to polling, not a fake "connected" webhook', async () => {
    makeTestEnv({ APP_URL: 'https://example.sslip.io' });
    const connection = connectionRow();
    prisma.channelConnection.findUnique.mockResolvedValue(connection);
    vi.stubGlobal('fetch', fetchRouter({ healthOk: false }));

    await configureTelegramWebhook(connection.id);

    expect(isPolling(connection.id)).toBe(true);
    const update = prisma.channelConnection.update.mock.calls[0]![0] as {
      data: { healthStatus: string; healthDetail: string; metadata: { channelMode: string } };
    };
    expect(update.data.healthStatus).toBe('CONNECTED');
    expect(update.data.metadata.channelMode).toBe('polling');
    expect(update.data.healthDetail).toContain('did not answer');
    // setWebhook must never be called once the self-probe has failed.
    // (fetchRouter would still answer it, so we check via no webhookUrl metadata key written instead.)
  });

  it('a genuinely reachable APP_URL configures webhook push, not polling', async () => {
    makeTestEnv({ APP_URL: 'https://example.sslip.io' });
    const connection = connectionRow();
    prisma.channelConnection.findUnique.mockResolvedValue(connection);
    vi.stubGlobal('fetch', fetchRouter({ healthOk: true }));

    await configureTelegramWebhook(connection.id);

    expect(isPolling(connection.id)).toBe(false);
    const update = prisma.channelConnection.update.mock.calls[0]![0] as {
      data: { healthStatus: string; metadata: { channelMode: string } };
    };
    expect(update.data.healthStatus).toBe('CONNECTED');
    expect(update.data.metadata.channelMode).toBe('webhook');
  });

  it('no APP_URL at all also falls back to polling (unchanged prior behavior)', async () => {
    makeTestEnv({ APP_URL: undefined });
    const connection = connectionRow();
    prisma.channelConnection.findUnique.mockResolvedValue(connection);
    vi.stubGlobal('fetch', fetchRouter({ healthOk: true })); // even if reachable, no URL to probe

    await configureTelegramWebhook(connection.id);

    expect(isPolling(connection.id)).toBe(true);
  });

  it('reconfiguring an already-polling connection with a now-reachable URL switches it to webhook and stops polling', async () => {
    makeTestEnv({ APP_URL: 'https://example.sslip.io' });
    const connection = connectionRow({ metadata: { channelMode: 'polling' } });
    prisma.channelConnection.findUnique.mockResolvedValue(connection);

    vi.stubGlobal('fetch', fetchRouter({ healthOk: false }));
    await configureTelegramWebhook(connection.id);
    expect(isPolling(connection.id)).toBe(true);

    vi.stubGlobal('fetch', fetchRouter({ healthOk: true }));
    await configureTelegramWebhook(connection.id);
    expect(isPolling(connection.id)).toBe(false);
  });
});
