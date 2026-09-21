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
