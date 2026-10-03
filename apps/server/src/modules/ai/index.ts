import type { Env } from '../../config/env.js';
import { sha256Hex } from '../../lib/crypto.js';
import { getLogger } from '../../lib/logger.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAIEmbeddings, VoyageEmbeddings } from './embeddings.js';
import type { AIProvider, EmbeddingProvider } from './provider.js';

export * from './provider.js';

const providers = new Map<string, AIProvider>();
/** Providers built from dashboard-pasted keys, keyed by sha256(key). */
const dynamicProviders = new Map<string, AIProvider>();
let embeddings: EmbeddingProvider | null = null;
let initialized = false;

export function initAI(env: Env): void {
  initialized = true;
  if (env.ANTHROPIC_API_KEY) {
    providers.set('anthropic', new AnthropicProvider(env.ANTHROPIC_API_KEY));
  } else {
    getLogger().warn('ANTHROPIC_API_KEY not set — agents cannot generate responses until configured');
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

/**
 * Tenant-aware provider resolution: a key pasted in the dashboard Settings
 * page (AppSetting ANTHROPIC_API_KEY) takes precedence over the env-configured
 * provider, so operators can activate/rotate the AI key with no redeploy.
 * Falls back to the env-initialized provider (or null when neither exists).
 */
export async function resolveAIProvider(tenantId: string, name: string): Promise<AIProvider | null> {
  if (!initialized) throw new Error('AI module not initialized');
  if (name !== 'anthropic') return getAIProvider(name);
  try {
    const { getStoredSetting } = await import('../settings/service.js');
    const key = await getStoredSetting(tenantId, 'ANTHROPIC_API_KEY');
    if (key) {
      const hash = sha256Hex(key);
      let provider = dynamicProviders.get(hash);
      if (!provider) {
        provider = new AnthropicProvider(key);
        dynamicProviders.clear(); // a rotated key obsoletes the previous client
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
