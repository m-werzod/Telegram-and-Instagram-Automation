/**
 * The models an agent may be configured with, and which provider serves each.
 *
 * Provider is derived from the model id rather than chosen separately: an
 * operator picks "gpt-5" in one dropdown and the platform routes it correctly.
 * A provider/model pair cannot drift out of sync because there is only one
 * field to set.
 */

export type ProviderName = 'anthropic' | 'openai';

/**
 * Capability/cost band. Used to translate a model to its counterpart on the
 * other provider when the configured provider has no usable credential — a
 * mid-tier agent falls back to a mid-tier model, not to a flagship or a nano.
 */
export type ModelTier = 'high' | 'mid' | 'low';

export interface ModelInfo {
  id: string;
  provider: ProviderName;
  tier: ModelTier;
  /** Price per million tokens, for the operator-facing cost hint. */
  inputPerMTok: number;
  outputPerMTok: number;
}

export const SUPPORTED_MODELS: readonly ModelInfo[] = [
  // Anthropic — https://platform.claude.com
  { id: 'claude-opus-5', provider: 'anthropic', tier: 'high', inputPerMTok: 5, outputPerMTok: 25 },
  { id: 'claude-sonnet-5', provider: 'anthropic', tier: 'mid', inputPerMTok: 2, outputPerMTok: 10 },
  { id: 'claude-haiku-4-5', provider: 'anthropic', tier: 'low', inputPerMTok: 1, outputPerMTok: 5 },
  // OpenAI — https://developers.openai.com/api/docs/pricing
  { id: 'gpt-5', provider: 'openai', tier: 'high', inputPerMTok: 1.25, outputPerMTok: 10 },
  { id: 'gpt-5-mini', provider: 'openai', tier: 'mid', inputPerMTok: 0.25, outputPerMTok: 2 },
  { id: 'gpt-5-nano', provider: 'openai', tier: 'low', inputPerMTok: 0.05, outputPerMTok: 0.4 },
] as const;

/**
 * Which provider serves this model. Falls back to the id prefix so a model
 * released after this list still routes correctly instead of 400-ing — an
 * operator can type a newer id and it works.
 */
export function providerForModel(model: string): ProviderName {
  const known = SUPPORTED_MODELS.find((m) => m.id === model);
  if (known) return known.provider;
  if (/^(gpt|o\d|chatgpt)/i.test(model)) return 'openai';
  return 'anthropic';
}

export function modelInfo(model: string): ModelInfo | null {
  return SUPPORTED_MODELS.find((m) => m.id === model) ?? null;
}

/** The settings key holding the API key for a provider. */
export function keyNameForProvider(provider: ProviderName): 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' {
  return provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
}

export function otherProvider(provider: ProviderName): ProviderName {
  return provider === 'openai' ? 'anthropic' : 'openai';
}

/**
 * Which provider issued this API key, read from its prefix.
 *
 * Anthropic keys are `sk-ant-…`; OpenAI's are `sk-…` (today `sk-proj-…` for
 * project keys). The two are trivially distinguishable, and telling them apart
 * matters: an operator who pastes the key they bought into whichever field
 * they happened to open otherwise gets a credential that authenticates against
 * nothing, and every agent run dies at a 401 with no hint as to why.
 *
 * Returns null for a shape that identifies neither provider — the caller then
 * trusts the field the operator chose rather than guessing.
 */
export function providerForKey(key: string): ProviderName | null {
  const k = key.trim();
  if (/^sk-ant-/i.test(k)) return 'anthropic';
  if (/^sk-/i.test(k)) return 'openai';
  return null;
}

/**
 * The closest model to `model` that `provider` serves — same tier where one
 * exists, that provider's mid tier otherwise. Used only for the cross-provider
 * fallback, never to silently rewrite an agent's stored configuration.
 */
export function equivalentModel(model: string, provider: ProviderName): string {
  const tier = modelInfo(model)?.tier ?? 'mid';
  const sameTier = SUPPORTED_MODELS.find((m) => m.provider === provider && m.tier === tier);
  if (sameTier) return sameTier.id;
  const mid = SUPPORTED_MODELS.find((m) => m.provider === provider && m.tier === 'mid');
  return mid?.id ?? SUPPORTED_MODELS.find((m) => m.provider === provider)!.id;
}
