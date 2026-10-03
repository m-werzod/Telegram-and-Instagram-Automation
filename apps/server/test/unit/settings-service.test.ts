import { beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../../src/lib/crypto.js';
import { initLogger } from '../../src/lib/logger.js';
import {
  clearSetting,
  invalidateSettingsCache,
  isSettingKey,
  resolveGlobalSetting,
  resolveSetting,
  setSetting,
  settingsStatus,
} from '../../src/modules/settings/service.js';
import { makeTestEnv, TEST_ENCRYPTION_KEY } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';

const TENANT = 'tenant-1';

describe('settings service', () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
    invalidateSettingsCache();
    prisma.appSetting.findMany.mockResolvedValue([]);
  });

  it('isSettingKey accepts known keys and rejects unknown ones', () => {
    expect(isSettingKey('ANTHROPIC_API_KEY')).toBe(true);
    expect(isSettingKey('META_APP_SECRET')).toBe(true);
    expect(isSettingKey('DATABASE_URL')).toBe(false);
    expect(isSettingKey('')).toBe(false);
  });

  it('resolveSetting returns the decrypted DB value when present', async () => {
    prisma.appSetting.findMany.mockResolvedValue([
      {
        key: 'ANTHROPIC_API_KEY',
        valueEncrypted: encryptSecret('sk-ant-db-key', TEST_ENCRYPTION_KEY),
      },
    ]);
    const value = await resolveSetting(TENANT, 'ANTHROPIC_API_KEY');
    expect(value).toBe('sk-ant-db-key');
  });

  it('resolveSetting falls back to the env value when the DB has none', async () => {
    makeTestEnv({ META_APP_SECRET: 'env-secret' });
    invalidateSettingsCache();
    const value = await resolveSetting(TENANT, 'META_APP_SECRET');
    expect(value).toBe('env-secret');
  });

  it('a DB value overrides the env value', async () => {
    makeTestEnv({ META_APP_SECRET: 'env-secret' });
    invalidateSettingsCache();
    prisma.appSetting.findMany.mockResolvedValue([
      { key: 'META_APP_SECRET', valueEncrypted: encryptSecret('db-secret', TEST_ENCRYPTION_KEY) },
    ]);
    expect(await resolveSetting(TENANT, 'META_APP_SECRET')).toBe('db-secret');
  });

  it('an unreadable encrypted value (rotated key) is skipped, env fallback applies', async () => {
    makeTestEnv({ META_APP_SECRET: 'env-secret' });
    invalidateSettingsCache();
    prisma.appSetting.findMany.mockResolvedValue([
      { key: 'META_APP_SECRET', valueEncrypted: 'v1:broken:broken:broken' },
    ]);
    expect(await resolveSetting(TENANT, 'META_APP_SECRET')).toBe('env-secret');
  });

  it('setSetting encrypts (never stores plaintext) and invalidates the cache', async () => {
    prisma.appSetting.upsert.mockResolvedValue({});
    await setSetting(TENANT, 'ANTHROPIC_API_KEY', '  sk-ant-new  ');
    const arg = prisma.appSetting.upsert.mock.calls[0]![0] as {
      create: { valueEncrypted: string; key: string };
    };
    expect(arg.create.key).toBe('ANTHROPIC_API_KEY');
    expect(arg.create.valueEncrypted).not.toContain('sk-ant-new');
    expect(arg.create.valueEncrypted.startsWith('v1:')).toBe(true);

    // After the write, the next read reloads from the DB (cache invalidated).
    prisma.appSetting.findMany.mockResolvedValue([
      { key: 'ANTHROPIC_API_KEY', valueEncrypted: arg.create.valueEncrypted },
    ]);
    expect(await resolveSetting(TENANT, 'ANTHROPIC_API_KEY')).toBe('sk-ant-new');
  });

  it('setSetting rejects empty values', async () => {
    await expect(setSetting(TENANT, 'META_APP_ID', '   ')).rejects.toThrow(/empty/i);
  });

  it('clearSetting deletes the row and invalidates the cache', async () => {
    prisma.appSetting.deleteMany.mockResolvedValue({ count: 1 });
    await clearSetting(TENANT, 'META_APP_ID');
    expect(prisma.appSetting.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, key: 'META_APP_ID' },
    });
  });

  it('settingsStatus reports source and masked value, never the plaintext', async () => {
    makeTestEnv({ META_APP_SECRET: 'env-secret-value-123456', META_APP_ID: undefined });
    invalidateSettingsCache();
    prisma.appSetting.findMany.mockResolvedValue([
      {
        key: 'ANTHROPIC_API_KEY',
        valueEncrypted: encryptSecret('sk-ant-super-secret-key-98765', TEST_ENCRYPTION_KEY),
      },
    ]);
    const statuses = await settingsStatus(TENANT);
    const byKey = Object.fromEntries(statuses.map((s) => [s.key, s]));

    expect(byKey.ANTHROPIC_API_KEY!.source).toBe('platform');
    expect(byKey.ANTHROPIC_API_KEY!.maskedValue).not.toContain('super-secret');
    expect(byKey.ANTHROPIC_API_KEY!.maskedValue).toContain('••');
    expect(byKey.META_APP_SECRET!.source).toBe('env');
    expect(byKey.META_APP_ID!.source).toBe('unset');
    expect(byKey.META_APP_ID!.maskedValue).toBe('');
  });

  it('resolveGlobalSetting scans tenants for webhook routes without tenant context', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: TENANT }]);
    prisma.appSetting.findMany.mockResolvedValue([
      { key: 'META_VERIFY_TOKEN', valueEncrypted: encryptSecret('vtoken', TEST_ENCRYPTION_KEY) },
    ]);
    expect(await resolveGlobalSetting('META_VERIFY_TOKEN')).toBe('vtoken');
  });

  it('resolveGlobalSetting falls back to env when no tenant configured it', async () => {
    makeTestEnv({ META_VERIFY_TOKEN: 'env-verify' });
    invalidateSettingsCache();
    prisma.tenant.findMany.mockResolvedValue([{ id: TENANT }]);
    prisma.appSetting.findMany.mockResolvedValue([]);
    expect(await resolveGlobalSetting('META_VERIFY_TOKEN')).toBe('env-verify');
  });
});
