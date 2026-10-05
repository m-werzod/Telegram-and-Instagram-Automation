import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ExternalApiError } from '../../lib/errors.js';
import { getLogger } from '../../lib/logger.js';
import type { AIProvider, GenerateResult, GenerateStructuredParams } from './provider.js';

/**
 * Anthropic Claude provider. Uses structured outputs (`output_config.format`)
 * so responses are schema-constrained by the API and re-validated locally with
 * Zod before any action is taken (spec §34 — never trust raw model output).
 *
 * Server-side refusal fallbacks are enabled by default on Claude Opus 5 so a
 * safety-classifier decline re-runs on a fallback model within the same call.
 */
/**
 * Result of checking an API key against Anthropic.
 *
 * `rejected` means Anthropic itself refused the credential (401/403) — the key
 * is wrong, revoked, or not an Anthropic key at all. `unknown` means the check
 * could not be completed (network, 429, 5xx); the key may well be fine, so
 * callers must not treat it as a failure.
 */
export type KeyVerification =
  | { status: 'valid' }
  | { status: 'rejected'; detail: string }
  | { status: 'unknown'; detail: string };

/**
 * Verify an Anthropic API key without spending a single token: `GET /v1/models`
 * is free metadata, but still authenticated — so it answers "is this key usable"
 * exactly, with no inference cost. Used when an operator pastes a key in the
 * dashboard (reject a bad one immediately instead of letting all four agents
 * fail at 401 on the next inbound message) and by the periodic health check.
 */
export async function verifyAnthropicKey(apiKey: string): Promise<KeyVerification> {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 15_000 });
  try {
    await client.models.list({ limit: 1 });
    return { status: 'valid' };
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      // Only 401/403 prove the credential itself is bad. Everything else
      // (429, 5xx, timeouts) says nothing about the key.
      if (err.status === 401 || err.status === 403) {
        return { status: 'rejected', detail: err.message };
      }
      return { status: 'unknown', detail: `${err.status ?? 'network'}: ${err.message}` };
    }
    return { status: 'unknown', detail: err instanceof Error ? err.message : String(err) };
  }
}

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2 });
  }

  async generateStructured<T>(params: GenerateStructuredParams<T>): Promise<GenerateResult<T>> {
    const { system, messages, schema, schemaName, model } = params;
    const maxTokens = params.maxTokens ?? 4096;

    try {
      // Refusal fallbacks: on a safety decline the API re-runs the request on a
      // fallback model within the same call (enabled by default on Opus 5).
      const supportsFallbacks = model.startsWith('claude-opus-5') || model.startsWith('claude-fable');
      void schemaName;
      const response = await this.client.beta.messages.create({
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        output_config: {
          format: zodOutputFormat(schema),
          ...(params.effort ? { effort: params.effort } : {}),
        },
        ...(supportsFallbacks
          ? {
              betas: ['server-side-fallback-2026-06-01'],
              fallbacks: [{ model: 'claude-opus-4-8' }],
            }
          : {}),
      });

      const usage = {
        inputTokens:
          response.usage.input_tokens +
          (response.usage.cache_read_input_tokens ?? 0) +
          (response.usage.cache_creation_input_tokens ?? 0),
        outputTokens: response.usage.output_tokens,
      };

      if (response.stop_reason === 'refusal') {
        const detail =
          (response as { stop_details?: { explanation?: string } | null }).stop_details
            ?.explanation ?? 'safety refusal';
        return { output: undefined as T, model: response.model, usage, refused: true, refusalReason: detail };
      }

      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      // A response cut off at the token ceiling leaves a half-written JSON
      // object. Say that plainly instead of letting it surface as the much
      // more confusing "model returned non-JSON output" — and don't retry it,
      // since the same request under the same cap truncates the same way.
      if (response.stop_reason === 'max_tokens') {
        throw new ExternalApiError(
          'anthropic',
          `Response hit the ${maxTokens}-token ceiling before the decision was complete — raise maxTokens`,
          { retryable: false, detail: text.slice(-200) },
        );
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(text);
      } catch {
        throw new ExternalApiError('anthropic', 'Model returned non-JSON output', {
          retryable: true,
          detail: text.slice(0, 500),
        });
      }

      const validated = schema.safeParse(parsedJson);
      if (!validated.success) {
        throw new ExternalApiError('anthropic', 'Model output failed schema validation', {
          retryable: true,
          detail: validated.error.issues,
        });
      }

      return { output: validated.data, model: response.model, usage };
    } catch (err) {
      if (err instanceof ExternalApiError) throw err;
      throw this.mapError(err);
    }
  }

  private mapError(err: unknown): ExternalApiError {
    if (err instanceof Anthropic.APIError) {
      const status = typeof err.status === 'number' ? err.status : 502;
      const retryable = status === 429 || status >= 500 || status === 408;
      getLogger().warn({ status, message: err.message }, 'anthropic api error');
      return new ExternalApiError('anthropic', err.message, { statusCode: status, retryable });
    }
    return new ExternalApiError('anthropic', err instanceof Error ? err.message : String(err), {
      retryable: true,
    });
  }
}
