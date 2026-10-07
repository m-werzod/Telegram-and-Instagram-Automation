import { getPrisma } from '../../db/client.js';
import { getEnv } from '../../config/env.js';
import { decryptSecret, encryptSecret, maskSecret } from '../../lib/crypto.js';
import { ValidationError } from '../../lib/errors.js';

/**
 * Operator-editable platform settings (spec: "paste the AI key in the
 * dashboard, no redeploy"). Values are stored AES-256-GCM-encrypted in
 * AppSetting and override the matching environment variables; the env value
 * remains the fallback so existing env-based deployments keep working.
 *
 * A short-TTL in-process cache keeps the hot path (webhook signature checks,
 * per-message AI key resolution) free of extra DB round-trips.
 */

export const SETTING_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'META_APP_ID',
  'META_APP_SECRET',
  'META_IG_APP_SECRET',
  'META_VERIFY_TOKEN',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

const CACHE_TTL_MS = 30_000;

interface TenantCache {
  values: Map<string, string>;
  loadedAt: number;
}

const cache = new Map<string, TenantCache>();

export function invalidateSettingsCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

async function loadTenantSettings(tenantId: string): Promise<Map<string, string>> {
  const cached = cache.get(tenantId);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.values;

  const env = getEnv();
  const rows = await getPrisma().appSetting.findMany({ where: { tenantId } });
  const values = new Map<string, string>();
  for (const row of rows) {
    try {
      values.set(row.key, decryptSecret(row.valueEncrypted, env.ENCRYPTION_KEY));
    } catch {
      // A value encrypted under a rotated ENCRYPTION_KEY is unreadable — skip
      // it (the env fallback still applies) rather than failing every request.
    }
  }
  cache.set(tenantId, { values, loadedAt: Date.now() });
  return values;
}

/** The decrypted DB value only (no env fallback); null when unset. */
export async function getStoredSetting(tenantId: string, key: SettingKey): Promise<string | null> {
  const values = await loadTenantSettings(tenantId);
  return values.get(key) ?? null;
}

function envFallback(key: SettingKey): string | null {
  const env = getEnv();
  switch (key) {
    case 'ANTHROPIC_API_KEY':
      return env.ANTHROPIC_API_KEY ?? null;
    case 'OPENAI_API_KEY':
      return env.OPENAI_API_KEY ?? null;
    case 'META_APP_ID':
      return env.META_APP_ID ?? null;
    case 'META_APP_SECRET':
      return env.META_APP_SECRET ?? null;
    case 'META_IG_APP_SECRET':
      return env.META_IG_APP_SECRET ?? null;
    case 'META_VERIFY_TOKEN':
      return env.META_VERIFY_TOKEN ?? null;
  }
}

/** Effective value: platform (DB) first, env variable as fallback. */
export async function resolveSetting(tenantId: string, key: SettingKey): Promise<string | null> {
  const stored = await getStoredSetting(tenantId, key);
  if (stored) return stored;
  return envFallback(key);
}

/**
 * Effective value without a tenant context — used by public webhook routes
 * (Meta sends no tenant information). Single-app deployments have one tenant;
 * with several, the first tenant that configured the key wins, matching the
 * one-Meta-app-per-deployment model.
 */
export async function resolveGlobalSetting(key: SettingKey): Promise<string | null> {
  const prisma = getPrisma();
  const tenants = await prisma.tenant.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
    take: 10,
  });
  for (const t of tenants) {
    const stored = await getStoredSetting(t.id, key);
    if (stored) return stored;
  }
  return envFallback(key);
}

export async function setSetting(tenantId: string, key: SettingKey, value: string): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError('Value must not be empty');
  if (trimmed.length > 4000) throw new ValidationError('Value too long');
  const env = getEnv();
  const valueEncrypted = encryptSecret(trimmed, env.ENCRYPTION_KEY);
  await getPrisma().appSetting.upsert({
    where: { tenantId_key: { tenantId, key } },
    create: { tenantId, key, valueEncrypted },
    update: { valueEncrypted },
  });
  invalidateSettingsCache(tenantId);
}

export async function clearSetting(tenantId: string, key: SettingKey): Promise<void> {
  await getPrisma().appSetting.deleteMany({ where: { tenantId, key } });
  invalidateSettingsCache(tenantId);
}

export interface SettingStatus {
  key: SettingKey;
  /** Where the effective value comes from. */
  source: 'platform' | 'env' | 'unset';
  maskedValue: string;
}

/** Masked status for the dashboard — plaintext values never leave the server. */
export async function settingsStatus(tenantId: string): Promise<SettingStatus[]> {
  const out: SettingStatus[] = [];
  for (const key of SETTING_KEYS) {
    const stored = await getStoredSetting(tenantId, key);
    const fallback = envFallback(key);
    const effective = stored ?? fallback;
    out.push({
      key,
      source: stored ? 'platform' : fallback ? 'env' : 'unset',
      maskedValue: effective ? maskSecret(effective) : '',
    });
  }
  return out;
}
