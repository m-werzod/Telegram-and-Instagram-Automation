/**
 * One API key, pasted into the other provider's slot, is the single most
 * effective way to brick this platform: the save succeeds, the agents stay
 * "enabled", and every inbound message dies at a 401 nobody sees. These tests
 * pin the three places that now refuse to be fooled by the slot and look at
 * the key itself — env vars, stored settings, and the per-run resolution.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../../src/lib/crypto.js';
import { initLogger } from '../../src/lib/logger.js';
import { initAI, getAIProvider, resolveProviderForModel } from '../../src/modules/ai/index.js';
import { invalidateSettingsCache } from '../../src/modules/settings/service.js';
import { makeTestEnv, TEST_ENCRYPTION_KEY } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';

const TENANT = 'tenant-1';

describe('initAI — env keys routed by issuer', () => {
  beforeEach(() => initLogger('silent', false));

  it('registers an OpenAI key found in ANTHROPIC_API_KEY as the OpenAI provider', () => {
    initAI(makeTestEnv({ ANTHROPIC_API_KEY: 'sk-proj-openai-key', OPENAI_API_KEY: undefined }));
    expect(getAIProvider('openai')?.name).toBe('openai');
    // Crucially NOT present as Anthropic: a provider that 401s on every call is
    // worse than no provider, because it suppresses the fallback.
    expect(getAIProvider('anthropic')).toBeNull();
  });

  it('never lets a misfiled key displace a correctly-filed one', () => {
    initAI(
      makeTestEnv({ ANTHROPIC_API_KEY: 'sk-proj-misfiled', OPENAI_API_KEY: 'sk-proj-the-real-one' }),
    );
    expect(getAIProvider('openai')?.name).toBe('openai');
    expect(getAIProvider('anthropic')).toBeNull();
  });

  it('leaves correctly-filed keys exactly where they are', () => {
    initAI(makeTestEnv({ ANTHROPIC_API_KEY: 'sk-ant-api03-key', OPENAI_API_KEY: 'sk-proj-key' }));
    expect(getAIProvider('anthropic')?.name).toBe('anthropic');
    expect(getAIProvider('openai')?.name).toBe('openai');
  });

  it('keeps a key of unrecognisable shape in the slot the operator chose', () => {
    initAI(makeTestEnv({ ANTHROPIC_API_KEY: 'some-reseller-token', OPENAI_API_KEY: undefined }));
    expect(getAIProvider('anthropic')?.name).toBe('anthropic');
  });
});

describe('resolveProviderForModel — stored keys and fallback', () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    initLogger('silent', false);
    prisma = mockPrisma();
    prisma.install();
    invalidateSettingsCache();
    prisma.appSetting.findMany.mockResolvedValue([]);
  });

  function store(key: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY', value: string): void {
    prisma.appSetting.findMany.mockResolvedValue([
      { key, valueEncrypted: encryptSecret(value, TEST_ENCRYPTION_KEY) },
    ]);
    invalidateSettingsCache();
  }

  it('uses the configured model when its provider has a key', async () => {
    initAI(makeTestEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }));
    store('ANTHROPIC_API_KEY', 'sk-ant-api03-good');

    const resolved = await resolveProviderForModel(TENANT, 'claude-sonnet-5');
    expect(resolved).toMatchObject({ model: 'claude-sonnet-5' });
    expect(resolved?.provider.name).toBe('anthropic');
    expect(resolved?.fallbackFrom).toBeUndefined();
  });

  // The live failure: the agents are on Claude, the only key bought is OpenAI's.
  it('falls back to the provider that has a key, at the same capability tier', async () => {
    initAI(makeTestEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }));
    store('OPENAI_API_KEY', 'sk-proj-good');

    const resolved = await resolveProviderForModel(TENANT, 'claude-sonnet-5');
    expect(resolved?.provider.name).toBe('openai');
    expect(resolved?.model).toBe('gpt-5-mini');
    expect(resolved?.fallbackFrom).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
  });

  // Defence in depth: even if the boot-time repair has not run yet, a stored
  // key belonging to the other provider must not masquerade as this one.
  it('ignores a stored key that belongs to the other provider', async () => {
    initAI(makeTestEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }));
    store('ANTHROPIC_API_KEY', 'sk-proj-an-openai-key');

    const resolved = await resolveProviderForModel(TENANT, 'claude-sonnet-5');
    expect(resolved?.provider.name).toBe('openai');
    expect(resolved?.model).toBe('gpt-5-mini');
  });

  it('returns null only when no provider has any key at all', async () => {
    initAI(makeTestEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }));
    await expect(resolveProviderForModel(TENANT, 'claude-sonnet-5')).resolves.toBeNull();
  });
});
