/**
 * Instagram is push-only: Meta delivers comments and DMs by POST and offers no
 * pull mode. So an APP_URL that does not actually route to this server is not a
 * degraded mode the way it is for Telegram (which falls back to long-polling) —
 * it is total silence, with no error raised anywhere. The operator task that
 * tells someone to paste that URL into Meta has to say so.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { initLogger } from '../../src/lib/logger.js';
import { makeTestEnv } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';
import { createMetaManualActions } from '../../src/modules/channels/instagram/service.js';

const APP_URL = 'https://example.sslip.io';

/** The webhook-config task's steps, in order. */
function webhookSteps(prisma: ReturnType<typeof mockPrisma>): string[] {
  const call = prisma.manualAction.upsert.mock.calls.find(
    (c) => (c[0] as { where: { tenantId_dedupKey: { dedupKey: string } } }).where.tenantId_dedupKey.dedupKey === 'meta-webhook-config',
  );
  return (call![0] as { create: { steps: string[] } }).create.steps;
}

describe('Instagram webhook manual action — callback reachability', () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    initLogger('silent', false);
    prisma = mockPrisma();
    prisma.install();
    prisma.manualAction.upsert.mockResolvedValue({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('leads with a blocker when the callback URL is answered by something else', async () => {
    makeTestEnv({ APP_URL });
    // A provider edge gateway answering 404 for an address that is not us.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('404 page not found\n', { status: 404 })));

    await createMetaManualActions('tenant-1');

    const steps = webhookSteps(prisma);
    expect(steps[0]).toContain('BLOCKER');
    expect(steps[0]).toContain(APP_URL);
    expect(steps[0]).toContain('443');
  });

  it('says nothing about reachability when the callback URL really is this server', async () => {
    makeTestEnv({ APP_URL });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'ok', db: 'ok' }), { status: 200 })),
    );

    await createMetaManualActions('tenant-1');

    expect(webhookSteps(prisma).join(' ')).not.toContain('BLOCKER');
  });

  it('calls out a missing APP_URL rather than printing a placeholder and moving on', async () => {
    makeTestEnv({ APP_URL: undefined });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await createMetaManualActions('tenant-1');

    expect(webhookSteps(prisma)[0]).toContain('APP_URL is not set');
    // Nothing to probe — and probing a placeholder would be nonsense.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
