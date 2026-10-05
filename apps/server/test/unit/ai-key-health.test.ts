import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../../src/lib/crypto.js';
import { initLogger } from '../../src/lib/logger.js';
import { verifyAnthropicKey } from '../../src/modules/ai/anthropic-provider.js';
import { verifyOpenAIKey } from '../../src/modules/ai/openai-provider.js';
import {
  AI_KEY_ACTION_KEY,
  checkTenantAIKey,
  repairMisfiledAIKeys,
  runAIKeyHealthCheck,
} from '../../src/modules/ai/health.js';
import {
  equivalentModel,
  providerForKey,
  providerForModel,
  keyNameForProvider,
} from '../../src/modules/ai/models.js';
import { invalidateSettingsCache } from '../../src/modules/settings/service.js';
import { makeTestEnv, TEST_ENCRYPTION_KEY } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';

const TENANT = 'tenant-1';

/** Minimal stand-in for the HTTP layer both SDKs call. */
function stubFetch(status: number, body: unknown = {}): void {
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

const ANTHROPIC_MODELS_OK = { data: [{ id: 'claude-sonnet-5', type: 'model' }], has_more: false };
const OPENAI_MODELS_OK = { object: 'list', data: [{ id: 'gpt-5', object: 'model' }] };
const ANTHROPIC_AUTH_ERROR = {
  type: 'error',
  error: { type: 'authentication_error', message: 'invalid x-api-key' },
};
const OPENAI_AUTH_ERROR = {
  error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' },
};

describe('model → provider routing', () => {
  it('routes each catalogue model to its own provider', () => {
    expect(providerForModel('claude-sonnet-5')).toBe('anthropic');
    expect(providerForModel('claude-haiku-4-5')).toBe('anthropic');
    expect(providerForModel('gpt-5')).toBe('openai');
    expect(providerForModel('gpt-5-mini')).toBe('openai');
    expect(providerForModel('gpt-5-nano')).toBe('openai');
  });

  // A model released after this list ships must still route somewhere sane
  // rather than being sent to the wrong provider's API.
  it('routes unknown models by id prefix', () => {
    expect(providerForModel('gpt-6-astra')).toBe('openai');
    expect(providerForModel('o4-mini')).toBe('openai');
    expect(providerForModel('claude-opus-6')).toBe('anthropic');
  });

  it('maps each provider to its own settings key', () => {
    expect(keyNameForProvider('anthropic')).toBe('ANTHROPIC_API_KEY');
    expect(keyNameForProvider('openai')).toBe('OPENAI_API_KEY');
  });
});

describe('key → provider routing', () => {
  it('tells an Anthropic key from an OpenAI one by its prefix', () => {
    expect(providerForKey('sk-ant-api03-abc')).toBe('anthropic');
    expect(providerForKey('sk-proj-abc')).toBe('openai');
    expect(providerForKey('sk-abc')).toBe('openai');
  });

  // An unrecognisable shape proves nothing — the caller keeps the operator's
  // own choice rather than guessing wrong.
  it('returns null for a key whose shape identifies neither provider', () => {
    expect(providerForKey('apikey-from-some-reseller')).toBeNull();
    expect(providerForKey('')).toBeNull();
  });
});

describe('equivalentModel', () => {
  it('maps a model to the same capability tier on the other provider', () => {
    expect(equivalentModel('claude-opus-5', 'openai')).toBe('gpt-5');
    expect(equivalentModel('claude-sonnet-5', 'openai')).toBe('gpt-5-mini');
    expect(equivalentModel('claude-haiku-4-5', 'openai')).toBe('gpt-5-nano');
    expect(equivalentModel('gpt-5', 'anthropic')).toBe('claude-opus-5');
    expect(equivalentModel('gpt-5-nano', 'anthropic')).toBe('claude-haiku-4-5');
  });

  it('falls back to the mid tier for a model it has never heard of', () => {
    expect(equivalentModel('gpt-7-unreleased', 'anthropic')).toBe('claude-sonnet-5');
  });
});

describe('verifyAnthropicKey', () => {
  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports a key Anthropic accepts as valid', async () => {
    stubFetch(200, ANTHROPIC_MODELS_OK);
    await expect(verifyAnthropicKey('sk-ant-good')).resolves.toEqual({ status: 'valid' });
  });

  it('reports a 401 as rejected — the exact failure that silently breaks every agent', async () => {
    stubFetch(401, ANTHROPIC_AUTH_ERROR);
    const result = await verifyAnthropicKey('not-an-anthropic-key');
    expect(result.status).toBe('rejected');
    expect(result.status === 'rejected' && result.detail).toContain('invalid x-api-key');
  });

  it('reports a 403 as rejected', async () => {
    stubFetch(403, { type: 'error', error: { type: 'permission_error', message: 'forbidden' } });
    expect((await verifyAnthropicKey('sk-ant-revoked')).status).toBe('rejected');
  });

  // A failed CHECK must never be reported as a failed KEY: a transient outage
  // would otherwise reject a perfectly good key on save.
  it('reports a 500 as unknown, not rejected', async () => {
    stubFetch(500, { type: 'error', error: { type: 'api_error', message: 'boom' } });
    expect((await verifyAnthropicKey('sk-ant-good')).status).toBe('unknown');
  });

  it('reports a rate limit as unknown, not rejected', async () => {
    stubFetch(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
    expect((await verifyAnthropicKey('sk-ant-good')).status).toBe('unknown');
  });

  it('reports a network failure as unknown, not rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect((await verifyAnthropicKey('sk-ant-good')).status).toBe('unknown');
  });
});

describe('verifyOpenAIKey', () => {
  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports a key OpenAI accepts as valid', async () => {
    stubFetch(200, OPENAI_MODELS_OK);
    await expect(verifyOpenAIKey('sk-good')).resolves.toEqual({ status: 'valid' });
  });

  it('reports a 401 as rejected', async () => {
    stubFetch(401, OPENAI_AUTH_ERROR);
    const result = await verifyOpenAIKey('apikey-from-some-reseller');
    expect(result.status).toBe('rejected');
    expect(result.status === 'rejected' && result.detail).toContain('Incorrect API key');
  });

  it('reports a 500 as unknown, not rejected', async () => {
    stubFetch(500, { error: { message: 'server error' } });
    expect((await verifyOpenAIKey('sk-good')).status).toBe('unknown');
  });

  it('reports a rate limit as unknown, not rejected', async () => {
    stubFetch(429, { error: { message: 'rate limited' } });
    expect((await verifyOpenAIKey('sk-good')).status).toBe('unknown');
  });
});

describe('AI key health', () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
    invalidateSettingsCache();
    prisma.appSetting.findMany.mockResolvedValue([]);
    prisma.tenant.findMany.mockResolvedValue([{ id: TENANT }]);
    // Default: the tenant's agents run on Claude.
    prisma.agent.findMany.mockResolvedValue([{ model: 'claude-sonnet-5' }]);
  });
  afterEach(() => vi.unstubAllGlobals());

  function storeKey(key: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY', value: string): void {
    prisma.appSetting.findMany.mockResolvedValue([
      { key, valueEncrypted: encryptSecret(value, TEST_ENCRYPTION_KEY) },
    ]);
    invalidateSettingsCache();
  }

  it('reports "missing" when no key is configured anywhere', async () => {
    await expect(checkTenantAIKey(TENANT, 'anthropic')).resolves.toEqual({
      status: 'missing',
      provider: 'anthropic',
    });
    await expect(checkTenantAIKey(TENANT, 'openai')).resolves.toEqual({
      status: 'missing',
      provider: 'openai',
    });
  });

  it('reports the dashboard-stored key as the platform source', async () => {
    storeKey('ANTHROPIC_API_KEY', 'sk-ant-good');
    stubFetch(200, ANTHROPIC_MODELS_OK);
    await expect(checkTenantAIKey(TENANT, 'anthropic')).resolves.toEqual({
      status: 'valid',
      provider: 'anthropic',
      source: 'platform',
    });
  });

  it('checks the OpenAI key when the agents run on a GPT model', async () => {
    prisma.agent.findMany.mockResolvedValue([{ model: 'gpt-5-mini' }]);
    storeKey('OPENAI_API_KEY', 'sk-good');
    stubFetch(200, OPENAI_MODELS_OK);
    await runAIKeyHealthCheck();

    expect(prisma.manualAction.upsert).not.toHaveBeenCalled();
    expect(prisma.manualAction.updateMany).toHaveBeenCalled();
  });

  // The trap this guards: switching the agents to GPT while only a Claude key
  // is stored looks fine on the Settings page and fails on every message.
  it('raises a task when the agents use GPT but only a Claude key is stored', async () => {
    prisma.agent.findMany.mockResolvedValue([{ model: 'gpt-5' }]);
    storeKey('ANTHROPIC_API_KEY', 'sk-ant-good');
    await runAIKeyHealthCheck();

    const arg = prisma.manualAction.upsert.mock.calls[0]![0] as {
      create: { platform: string; title: string };
    };
    expect(arg.create.platform).toBe('OpenAI');
    expect(arg.create.title).toContain('OpenAI');
  });

  it('raises an operator task when the stored key is rejected', async () => {
    storeKey('ANTHROPIC_API_KEY', 'not-an-anthropic-key');
    stubFetch(401, ANTHROPIC_AUTH_ERROR);
    await runAIKeyHealthCheck();

    expect(prisma.manualAction.upsert).toHaveBeenCalledTimes(1);
    const arg = prisma.manualAction.upsert.mock.calls[0]![0] as {
      where: { tenantId_dedupKey: { dedupKey: string } };
      create: { steps: string[]; status: string };
    };
    expect(arg.where.tenantId_dedupKey.dedupKey).toBe(AI_KEY_ACTION_KEY);
    expect(arg.create.status).toBe('PENDING');
    expect(arg.create.steps.join(' ')).toContain('invalid x-api-key');
  });

  it('raises an operator task when no key is configured', async () => {
    await runAIKeyHealthCheck();
    expect(prisma.manualAction.upsert).toHaveBeenCalledTimes(1);
  });

  it('clears the task once the key works', async () => {
    storeKey('ANTHROPIC_API_KEY', 'sk-ant-good');
    stubFetch(200, ANTHROPIC_MODELS_OK);
    await runAIKeyHealthCheck();

    expect(prisma.manualAction.upsert).not.toHaveBeenCalled();
    expect(prisma.manualAction.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, dedupKey: AI_KEY_ACTION_KEY, status: 'PENDING' },
      data: { status: 'DONE' },
    });
  });

  it('stays quiet when the check itself could not complete', async () => {
    storeKey('ANTHROPIC_API_KEY', 'sk-ant-good');
    stubFetch(503, { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } });
    await runAIKeyHealthCheck();

    expect(prisma.manualAction.upsert).not.toHaveBeenCalled();
    expect(prisma.manualAction.updateMany).not.toHaveBeenCalled();
  });

  it('ignores a tenant whose agents are all disabled', async () => {
    prisma.agent.findMany.mockResolvedValue([]);
    await runAIKeyHealthCheck();
    expect(prisma.manualAction.upsert).not.toHaveBeenCalled();
    expect(prisma.manualAction.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * Rescues the single most common way this platform is bricked: one API key,
 * pasted into the other provider's box. New saves are routed by issuer, but a
 * key stored before that still has to be moved — on boot, with no operator
 * action, because until it moves not one message gets a reply.
 */
describe('repairMisfiledAIKeys', () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
    invalidateSettingsCache();
    prisma.appSetting.findMany.mockResolvedValue([]);
    prisma.tenant.findMany.mockResolvedValue([{ id: TENANT }]);
  });

  function stored(entries: Array<['ANTHROPIC_API_KEY' | 'OPENAI_API_KEY', string]>): void {
    prisma.appSetting.findMany.mockResolvedValue(
      entries.map(([key, value]) => ({
        key,
        valueEncrypted: encryptSecret(value, TEST_ENCRYPTION_KEY),
      })),
    );
    invalidateSettingsCache();
  }

  it('moves an OpenAI key out of the Anthropic slot', async () => {
    stored([['ANTHROPIC_API_KEY', 'sk-proj-the-paid-key']]);
    await repairMisfiledAIKeys();

    const write = prisma.appSetting.upsert.mock.calls[0]![0] as {
      where: { tenantId_key: { key: string } };
    };
    expect(write.where.tenantId_key.key).toBe('OPENAI_API_KEY');
    expect(prisma.appSetting.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, key: 'ANTHROPIC_API_KEY' },
    });
  });

  it('moves an Anthropic key out of the OpenAI slot', async () => {
    stored([['OPENAI_API_KEY', 'sk-ant-api03-the-paid-key']]);
    await repairMisfiledAIKeys();

    const write = prisma.appSetting.upsert.mock.calls[0]![0] as {
      where: { tenantId_key: { key: string } };
    };
    expect(write.where.tenantId_key.key).toBe('ANTHROPIC_API_KEY');
  });

  it('leaves correctly-filed keys untouched', async () => {
    stored([
      ['ANTHROPIC_API_KEY', 'sk-ant-api03-good'],
      ['OPENAI_API_KEY', 'sk-proj-good'],
    ]);
    await repairMisfiledAIKeys();

    expect(prisma.appSetting.upsert).not.toHaveBeenCalled();
    expect(prisma.appSetting.deleteMany).not.toHaveBeenCalled();
  });

  // Never destroy a working credential to rescue a misfiled one.
  it('never overwrites a key already present in the destination slot', async () => {
    stored([
      ['ANTHROPIC_API_KEY', 'sk-proj-misfiled'],
      ['OPENAI_API_KEY', 'sk-proj-already-here'],
    ]);
    await repairMisfiledAIKeys();

    expect(prisma.appSetting.upsert).not.toHaveBeenCalled();
    expect(prisma.appSetting.deleteMany).not.toHaveBeenCalled();
  });

  it('leaves a key whose shape identifies no provider alone', async () => {
    stored([['ANTHROPIC_API_KEY', 'apikey-from-some-reseller']]);
    await repairMisfiledAIKeys();

    expect(prisma.appSetting.upsert).not.toHaveBeenCalled();
  });
});
