import type { z } from 'zod';

/**
 * AI provider abstraction (spec §19). The platform is not coupled to a single
 * vendor: agents select a provider+model in their configuration, and new
 * providers implement this interface.
 */

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenerateStructuredParams<T> {
  /** Stable system prompt (cache-friendly: keep volatile content in messages). */
  system: string;
  messages: ChatTurn[];
  /** Zod schema the model output MUST validate against (spec §34). */
  schema: z.ZodType<T>;
  /** Human-readable schema name for the provider. */
  schemaName: string;
  model: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
}

export interface GenerateResult<T> {
  output: T;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  /** Set when the provider refused for safety reasons. `output` is absent then. */
  refused?: boolean;
  refusalReason?: string;
}

export interface AIProvider {
  readonly name: string;
  generateStructured<T>(params: GenerateStructuredParams<T>): Promise<GenerateResult<T>>;
}

export interface EmbeddingProvider {
  readonly name: string;
  /** Dimension of produced vectors (informational). */
  readonly dimensions: number;
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>;
}
