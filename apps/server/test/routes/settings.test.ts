import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { encryptSecret } from '../../src/lib/crypto.js';
import { initLogger } from '../../src/lib/logger.js';
import { invalidateSettingsCache } from '../../src/modules/settings/service.js';
import { makeTestEnv, TEST_ENCRYPTION_KEY } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';
import { setQueueForTesting, type JobQueue } from '../../src/queue/index.js';

const noopQueue: JobQueue = {
  enqueue: async () => undefined,
  registerHandler: () => undefined,
  start: async () => undefined,
  stop: async () => undefined,
};

const SESSION = 'session-token';
const COOKIE = { sid: SESSION };

const MODELS_OK = { data: [{ id: 'claude-sonnet-5', type: 'model' }], has_more: false };
const AUTH_ERROR = {
  type: 'error',
  error: { type: 'authentication_error', message: 'invalid x-api-key' },
};

function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

/**
 * The AI key is the one credential every agent depends on, and a wrong value
 * fails invisibly — the save succeeds, the agents stay "enabled", and every
 * inbound message then dies at a 401 buried in the AI execution log. These
 * tests pin the guard that turns that into an immediate, visible refusal.
 */
describe('settings routes — Anthropic key verification', () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(async () => {
    initLogger('silent', false);
    prisma = mockPrisma();
    prisma.install();
    invalidateSettingsCache();
    prisma.appSetting.findMany.mockResolvedValue([]);
    prisma.agent.findMany.mockResolvedValue([{ model: 'claude-sonnet-5' }]);
    prisma.authSession.findUnique.mockResolvedValue({
      id: 'sess-1',
      expiresAt: new Date(Date.now() + 3_600_000),
      user: {
        id: 'user-1',
        tenantId: 'tenant-1',
        username: 'Admin',
        role: 'ADMIN',
        name: 'Administrator',
      },
    });
    setQueueForTesting(noopQueue);
    app = await buildApp(makeTestEnv());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it('refuses to store a key Anthropic rejects, and says why', async () => {
    stubFetch(401, AUTH_ERROR);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/ANTHROPIC_API_KEY',
      cookies: COOKIE,
      payload: { value: 'apikey-from-some-other-service' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('sk-ant-');
    // The whole point: nothing was written.
    expect(prisma.appSetting.upsert).not.toHaveBeenCalled();
  });

  it('stores a key Anthropic accepts', async () => {
    stubFetch(200, MODELS_OK);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/ANTHROPIC_API_KEY',
      cookies: COOKIE,
      payload: { value: 'sk-ant-good-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().warning).toBeUndefined();
    expect(prisma.appSetting.upsert).toHaveBeenCalledTimes(1);
  });

  // A check that cannot complete must not block a legitimate key.
  it('stores the key with a warning when the check could not be completed', async () => {
    stubFetch(503, { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/ANTHROPIC_API_KEY',
      cookies: COOKIE,
      payload: { value: 'sk-ant-good-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().warning).toBeTruthy();
    expect(prisma.appSetting.upsert).toHaveBeenCalledTimes(1);
  });

  it('does not verify non-AI settings against Anthropic', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/META_VERIFY_TOKEN',
      cookies: COOKIE,
      payload: { value: 'some-verify-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prisma.appSetting.upsert).toHaveBeenCalledTimes(1);
  });

  it('reports the stored key as rejected on demand', async () => {
    prisma.appSetting.findMany.mockResolvedValue([
      {
        key: 'ANTHROPIC_API_KEY',
        valueEncrypted: encryptSecret('apikey-wrong', TEST_ENCRYPTION_KEY),
      },
    ]);
    invalidateSettingsCache();
    stubFetch(401, AUTH_ERROR);

    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/ANTHROPIC_API_KEY/verify',
      cookies: COOKIE,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().verification).toMatchObject({
      status: 'rejected',
      provider: 'anthropic',
      source: 'platform',
    });
  });

  it('reports a missing key on demand', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/ANTHROPIC_API_KEY/verify',
      cookies: COOKIE,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().verification).toEqual({ status: 'missing', provider: 'anthropic' });
  });

  it('refuses to store an OpenAI key that OpenAI rejects', async () => {
    stubFetch(401, {
      error: { message: 'Incorrect API key provided', code: 'invalid_api_key' },
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/OPENAI_API_KEY',
      cookies: COOKIE,
      payload: { value: 'apikey-from-some-reseller' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('OpenAI');
    expect(prisma.appSetting.upsert).not.toHaveBeenCalled();
  });

  it('stores an OpenAI key that OpenAI accepts', async () => {
    stubFetch(200, { object: 'list', data: [{ id: 'gpt-5', object: 'model' }] });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/OPENAI_API_KEY',
      cookies: COOKIE,
      payload: { value: 'sk-good-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.appSetting.upsert).toHaveBeenCalledTimes(1);
  });

  it('verifies the OpenAI key on demand', async () => {
    prisma.appSetting.findMany.mockResolvedValue([
      { key: 'OPENAI_API_KEY', valueEncrypted: encryptSecret('sk-wrong', TEST_ENCRYPTION_KEY) },
    ]);
    invalidateSettingsCache();
    stubFetch(401, { error: { message: 'Incorrect API key provided' } });

    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/OPENAI_API_KEY/verify',
      cookies: COOKIE,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().verification).toMatchObject({ status: 'rejected', provider: 'openai' });
  });

  /**
   * The real-world failure this closes: an operator buys ONE API key and pastes
   * it into whichever Settings box they opened first. An OpenAI `sk-proj-…` key
   * sitting in the Anthropic slot authenticates against nothing — the save
   * looks fine and every single agent run afterwards 401s.
   */
  it('files a pasted key under the provider that issued it, not the box it was typed into', async () => {
    stubFetch(200, { object: 'list', data: [{ id: 'gpt-5', object: 'model' }] });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/ANTHROPIC_API_KEY',
      cookies: COOKIE,
      payload: { value: 'sk-proj-an-openai-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().notice).toContain('OpenAI');
    const written = prisma.appSetting.upsert.mock.calls[0]![0] as {
      where: { tenantId_key: { key: string } };
    };
    expect(written.where.tenantId_key.key).toBe('OPENAI_API_KEY');
  });

  it('verifies a re-filed key against its real provider, not the chosen box', async () => {
    // OpenAI refuses it — so it must be refused, even though the operator
    // submitted it to the Anthropic endpoint.
    stubFetch(401, { error: { message: 'Incorrect API key provided' } });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/ANTHROPIC_API_KEY',
      cookies: COOKIE,
      payload: { value: 'sk-proj-a-dead-openai-key' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('OpenAI');
    expect(prisma.appSetting.upsert).not.toHaveBeenCalled();
  });

  it('leaves a correctly-filed key in its own slot', async () => {
    stubFetch(200, MODELS_OK);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/ANTHROPIC_API_KEY',
      cookies: COOKIE,
      payload: { value: 'sk-ant-api03-correct' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().notice).toBeUndefined();
    const written = prisma.appSetting.upsert.mock.calls[0]![0] as {
      where: { tenantId_key: { key: string } };
    };
    expect(written.where.tenantId_key.key).toBe('ANTHROPIC_API_KEY');
  });

  it('refuses to verify a setting that is not an AI key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/META_APP_SECRET/verify',
      cookies: COOKIE,
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/ANTHROPIC_API_KEY/verify',
    });
    expect(res.statusCode).toBe(401);
  });
});
