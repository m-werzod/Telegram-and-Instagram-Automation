import { ExternalApiError } from '../../lib/errors.js';
import type { EmbeddingProvider } from './provider.js';

/**
 * Embedding providers for semantic knowledge retrieval. Anthropic does not
 * offer a first-party embeddings API; Voyage AI is their documented partner.
 * OpenAI embeddings are supported as an alternative. When neither is
 * configured the knowledge module falls back to Postgres full-text search
 * (a real, degraded retrieval mode — not a mock).
 */

async function postJson(url: string, apiKey: string, body: unknown, provider: string): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ExternalApiError(provider, `Embeddings request failed (${res.status})`, {
      statusCode: res.status,
      retryable: res.status === 429 || res.status >= 500,
      detail: text.slice(0, 500),
    });
  }
  return res.json();
}

export class VoyageEmbeddings implements EmbeddingProvider {
  readonly name = 'voyage';
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = 'voyage-4', dimensions = 1024) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
    if (texts.length === 0) return [];
    const data = await postJson(
      'https://api.voyageai.com/v1/embeddings',
      this.apiKey,
      { input: texts, model: this.model, input_type: kind },
      'voyage',
    );
    const items = (data.data ?? []) as Array<{ index: number; embedding: number[] }>;
    return items.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

export class OpenAIEmbeddings implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = 'text-embedding-3-small', dimensions = 1536) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(texts: string[], _kind: 'document' | 'query'): Promise<number[][]> {
    if (texts.length === 0) return [];
    const data = await postJson(
      'https://api.openai.com/v1/embeddings',
      this.apiKey,
      { input: texts, model: this.model },
      'openai',
    );
    const items = (data.data ?? []) as Array<{ index: number; embedding: number[] }>;
    return items.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
