import { getEnv, type Env } from '../../config/env.js';
import { sha256Hex } from '../../lib/crypto.js';
import { getLogger } from '../../lib/logger.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAIEmbeddings, VoyageEmbeddings } from './embeddings.js';
import {
  equivalentModel,
  keyNameForProvider,
  otherProvider,
  providerForKey,
  providerForModel,
  type ProviderName,
} from './models.js';
import { OpenAIProvider } from './openai-provider.js';
import type { AIProvider, EmbeddingProvider } from './provider.js';

export * from './provider.js';
export { verifyAnthropicKey, type KeyVerification } from './anthropic-provider.js';
export { verifyOpenAIKey, OpenAIProvider } from './openai-provider.js';
export * from './models.js';
export {
  checkTenantAIKey,
  repairMisfiledAIKeys,
  runAIKeyHealthCheck,
  AI_KEY_ACTION_KEY,
  type AIKeyHealth,
} from './health.js';

const providers = new Map<string, AIProvider>();
/** Providers built from dashboard-pasted keys, keyed by sha256(key). */
const dynamicProviders = new Map<string, AIProvider>();
let embeddings: EmbeddingProvider | null = null;
let initialized = false;

export function initAI(env: Env): void {
  initialized = true;
  providers.clear();

  // Route each env key by the provider that ISSUED it, not by the variable it
  // was assigned to. An OpenAI `sk-proj-…` key in ANTHROPIC_API_KEY would
  // otherwise build a Claude client that 401s on every message — and, worse,
  // make the Anthropic provider look *present*, suppressing the cross-provider
  // fallback that would have kept the agents answering. Correctly-filed keys
  // are claimed first so a misfiled one can never displace a good one.
  const keys: Array<[ProviderName, string | undefined]> = [
    ['anthropic', env.ANTHROPIC_API_KEY],
    ['openai', env.OPENAI_API_KEY],
  ];
  const resolved = new Map<ProviderName, string>();
  for (const [slot, key] of keys) {
    if (key && (providerForKey(key) ?? slot) === slot) resolved.set(slot, key);
  }
  for (const [slot, key] of keys) {
    if (!key) continue;
    const issuer = providerForKey(key) ?? slot;
    if (issuer === slot || resolved.has(issuer)) continue;
    getLogger().warn(
      `${keyNameForProvider(slot)} holds a key issued by ${issuer} — using it as the ${issuer} credential instead of failing every request`,
    );
    resolved.set(issuer, key);
  }

  const anthropicKey = resolved.get('anthropic');
  if (anthropicKey) providers.set('anthropic', new AnthropicProvider(anthropicKey));
  const openaiKey = resolved.get('openai');
  if (openaiKey) providers.set('openai', new OpenAIProvider(openaiKey, env.OPENAI_BASE_URL));

  if (providers.size === 0) {
    getLogger().warn(
      'no AI provider key set (ANTHROPIC_API_KEY / OPENAI_API_KEY) — agents cannot generate responses until one is configured',
    );
  }

  if (env.EMBEDDINGS_PROVIDER === 'voyage' && env.VOYAGE_API_KEY) {
    embeddings = new VoyageEmbeddings(env.VOYAGE_API_KEY);
  } else if (env.EMBEDDINGS_PROVIDER === 'openai' && env.OPENAI_API_KEY) {
    embeddings = new OpenAIEmbeddings(env.OPENAI_API_KEY);
  } else {
    if (env.EMBEDDINGS_PROVIDER !== 'none') {
      getLogger().warn(
        `EMBEDDINGS_PROVIDER=${env.EMBEDDINGS_PROVIDER} but its API key is missing — using full-text retrieval`,
      );
    }
    embeddings = null;
  }
}

export function getAIProvider(name: string): AIProvider | null {
  if (!initialized) throw new Error('AI module not initialized');
  return providers.get(name) ?? null;
}

function buildProvider(name: ProviderName, key: string): AIProvider {
  // A dashboard-pasted key must reach the same endpoint an env-configured one
  // would — OPENAI_BASE_URL is a deployment choice (a gateway/reseller), not a
  // property of where the key was typed.
  return name === 'openai'
    ? new OpenAIProvider(key, getEnv().OPENAI_BASE_URL)
    : new AnthropicProvider(key);
}

/**
 * The stored key that genuinely belongs to `name`.
 *
 * Looks in that provider's own slot first, then — because a key filed into the
 * other provider's box is still a credential for whoever issued it — in the
 * other slot. This is what keeps a misfiled key working in the window before
 * the boot-time repair moves it, and what stops it being mistaken for a
 * credential of the provider whose box it is sitting in.
 */
async function storedKeyFor(tenantId: string, name: ProviderName): Promise<string | null> {
  const { getStoredSetting } = await import('../settings/service.js');
  const own = await getStoredSetting(tenantId, keyNameForProvider(name));
  if (own && (providerForKey(own) ?? name) === name) return own;
  const other = await getStoredSetting(tenantId, keyNameForProvider(otherProvider(name)));
  if (other && providerForKey(other) === name) {
    getLogger().warn(
      { provider: name, slot: keyNameForProvider(otherProvider(name)) },
      'using an API key saved under the wrong provider — it was issued by this one',
    );
    return other;
  }
  return null;
}

/**
 * Tenant-aware provider resolution: a key pasted in the dashboard Settings
 * page (AppSetting ANTHROPIC_API_KEY / OPENAI_API_KEY) takes precedence over
 * the env-configured provider, so operators can activate/rotate an AI key with
 * no redeploy. Falls back to the env-initialized provider (or null when
 * neither exists).
 */
export async function resolveAIProvider(tenantId: string, name: string): Promise<AIProvider | null> {
  if (!initialized) throw new Error('AI module not initialized');
  if (name !== 'anthropic' && name !== 'openai') return getAIProvider(name);
  try {
    const key = await storedKeyFor(tenantId, name);
    if (key) {
      // Key the cache by provider too — the two providers' keys are different
      // credentials and must never resolve to each other's client.
      const hash = `${name}:${sha256Hex(key)}`;
      let provider = dynamicProviders.get(hash);
      if (!provider) {
        provider = buildProvider(name, key);
        // A rotated key obsoletes the previous client for THAT provider only.
        for (const existing of dynamicProviders.keys()) {
          if (existing.startsWith(`${name}:`)) dynamicProviders.delete(existing);
        }
        dynamicProviders.set(hash, provider);
      }
      return provider;
    }
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to read AI key from settings — falling back to env provider',
    );
  }
  return getAIProvider(name);
}

/**
 * The provider+model an agent run should actually use.
 *
 * `model` is normally the agent's configured model. It differs only when the
 * configured provider has NO credential at all while the other provider does:
 * rather than failing every inbound message — which is indistinguishable, from
 * the customer's side, from the bot being switched off — the run continues on
 * the equivalent model from the provider that *is* configured. The substitution
 * is recorded on the AI execution and logged, never hidden.
 *
 * A provider that has a key which the API later rejects is NOT substituted:
 * that is a broken credential the operator must fix, and silently spending
 * another provider's budget to paper over it would be worse than failing.
 */
export interface ResolvedProvider {
  provider: AIProvider;
  model: string;
  /** Set only when the configured provider had no credential at all. */
  fallbackFrom?: { provider: ProviderName; model: string };
}

export async function resolveProviderForModel(
  tenantId: string,
  model: string,
): Promise<ResolvedProvider | null> {
  const wanted = providerForModel(model);
  const direct = await resolveAIProvider(tenantId, wanted);
  if (direct) return { provider: direct, model };

  const alternate = otherProvider(wanted);
  const fallback = await resolveAIProvider(tenantId, alternate);
  if (!fallback) return null;

  const substitute = equivalentModel(model, alternate);
  getLogger().warn(
    { tenantId, configuredProvider: wanted, configuredModel: model, usingProvider: alternate, usingModel: substitute },
    "no API key for the agent's provider — running on the configured alternative so replies keep flowing",
  );
  return { provider: fallback, model: substitute, fallbackFrom: { provider: wanted, model } };
}

export function getEmbeddings(): EmbeddingProvider | null {
  if (!initialized) throw new Error('AI module not initialized');
  return embeddings;
}

export function setAIForTesting(opts: {
  providers?: Record<string, AIProvider>;
  embeddings?: EmbeddingProvider | null;
}): void {
  initialized = true;
  providers.clear();
  dynamicProviders.clear();
  for (const [k, v] of Object.entries(opts.providers ?? {})) providers.set(k, v);
  if (opts.embeddings !== undefined) embeddings = opts.embeddings;
}
