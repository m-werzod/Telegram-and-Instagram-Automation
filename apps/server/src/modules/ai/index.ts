import type { Env } from '../../config/env.js';
import { getLogger } from '../../lib/logger.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAIEmbeddings, VoyageEmbeddings } from './embeddings.js';
import type { AIProvider, EmbeddingProvider } from './provider.js';

export * from './provider.js';

const providers = new Map<string, AIProvider>();
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
  for (const [k, v] of Object.entries(opts.providers ?? {})) providers.set(k, v);
  if (opts.embeddings !== undefined) embeddings = opts.embeddings;
}
