import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import { ExternalApiError } from '../../lib/errors.js';
import { getLogger } from '../../lib/logger.js';
import type { KeyVerification } from './anthropic-provider.js';
import type { AIProvider, GenerateResult, GenerateStructuredParams } from './provider.js';

/**
 * OpenAI (ChatGPT) provider. Uses the Responses API with strict structured
 * outputs (`text.format`), so the model is schema-constrained server-side and
 * the result is re-validated locally with Zod before any action is taken
 * (spec §34 — never trust raw model output).
 */

/**
 * JSON Schema keywords OpenAI's strict mode accepts. Anything else is dropped:
 * `zodTextFormat` faithfully emits `minimum`/`maximum` for `z.number().min().max()`,
 * and strict mode rejects the whole request with a 400 over it. Nothing is lost
 * by dropping them — the local Zod re-validation still enforces every
 * constraint, and the business rules clamp the values regardless.
 */
const ALLOWED_SCHEMA_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'allOf',
  'oneOf',
  'enum',
  'const',
  'description',
  'title',
  '$ref',
  '$defs',
  'definitions',
]);

export function toStrictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStrictSchema);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (!ALLOWED_SCHEMA_KEYWORDS.has(key)) continue;
    // `properties` and `$defs` are maps of names → schemas: recurse into the
    // values, never filter their keys (a property legitimately named "format"
    // must survive).
    if (key === 'properties' || key === '$defs' || key === 'definitions') {
      const inner: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        inner[name] = toStrictSchema(sub);
      }
      out[key] = inner;
    } else {
      out[key] = toStrictSchema(value);
    }
  }
  return out;
}

/** Build the `text.format` payload for a Zod schema, strict-mode safe. */
export function strictTextFormat(schema: z.ZodType, name: string): OpenAI.Responses.ResponseTextConfig['format'] {
  const generated = zodTextFormat(schema, name) as unknown as { schema: unknown };
  return {
    type: 'json_schema',
    name,
    strict: true,
    schema: toStrictSchema(generated.schema) as Record<string, unknown>,
  };
}

export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';
  private client: OpenAI;

  /**
   * `baseURL` lets an OpenAI-compatible gateway (a reseller, a self-hosted
   * proxy) be used with the same wire format. Left unset, the official API.
   */
  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({
      apiKey,
      maxRetries: 2,
      ...(baseURL ? { baseURL } : {}),
    });
  }

  async generateStructured<T>(params: GenerateStructuredParams<T>): Promise<GenerateResult<T>> {
    const { system, messages, schema, schemaName, model } = params;
    const maxTokens = params.maxTokens ?? 4096;

    try {
      const response = await this.client.responses.create({
        model,
        // `instructions` is the stable prefix — keeping it out of `input` is
        // what lets OpenAI's automatic prompt caching hit on repeat traffic.
        instructions: system,
        input: messages.map((m) => ({ role: m.role, content: m.content })),
        max_output_tokens: maxTokens,
        text: { format: strictTextFormat(schema, schemaName) },
        // GPT-5 models are reasoning models: effort is the cost/quality dial,
        // the same knob `effort` means for Claude.
        ...(params.effort ? { reasoning: { effort: params.effort } } : {}),
      });

      const usage = {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      };

      // A safety decline comes back as a `refusal` content item rather than
      // schema-shaped output — the caller escalates to a human on this.
      const refusal = findRefusal(response);
      if (refusal !== null) {
        return {
          output: undefined as T,
          model: response.model,
          usage,
          refused: true,
          refusalReason: refusal || 'safety refusal',
        };
      }

      // Truncated at the ceiling means a half-written JSON object. Say that
      // plainly, and don't retry — the same request truncates the same way.
      if (response.incomplete_details?.reason === 'max_output_tokens') {
        throw new ExternalApiError(
          'openai',
          `Response hit the ${maxTokens}-token ceiling before the decision was complete — raise maxTokens`,
          { retryable: false },
        );
      }

      const text = outputText(response);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(text);
      } catch {
        throw new ExternalApiError('openai', 'Model returned non-JSON output', {
          retryable: true,
          detail: text.slice(0, 500),
        });
      }

      const validated = schema.safeParse(parsedJson);
      if (!validated.success) {
        throw new ExternalApiError('openai', 'Model output failed schema validation', {
          retryable: true,
          detail: validated.error.issues,
        });
      }

      return { output: validated.data, model: response.model, usage };
    } catch (err) {
      if (err instanceof ExternalApiError) throw err;
      throw mapOpenAIError(err);
    }
  }
}

/**
 * The model's text output. Prefers the API's own `output_text` convenience
 * field and falls back to concatenating the output-text parts, so a response
 * shape that omits it still parses.
 */
function outputText(response: OpenAI.Responses.Response): string {
  if (response.output_text) return response.output_text;
  let text = '';
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part.type === 'output_text') text += part.text;
    }
  }
  return text;
}

/** The refusal text when the model declined, else null. */
function findRefusal(response: OpenAI.Responses.Response): string | null {
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part.type === 'refusal') return part.refusal;
    }
  }
  return null;
}

function mapOpenAIError(err: unknown): ExternalApiError {
  if (err instanceof OpenAI.APIError) {
    const status = typeof err.status === 'number' ? err.status : 502;
    const retryable = status === 429 || status >= 500 || status === 408;
    getLogger().warn({ status, message: err.message }, 'openai api error');
    return new ExternalApiError('openai', err.message, { statusCode: status, retryable });
  }
  return new ExternalApiError('openai', err instanceof Error ? err.message : String(err), {
    retryable: true,
  });
}

/**
 * Verify an OpenAI API key without spending a token: `GET /v1/models` is free
 * metadata but still authenticated. Mirrors `verifyAnthropicKey` so the
 * dashboard can refuse a bad key on save whichever provider it belongs to.
 */
export async function verifyOpenAIKey(apiKey: string, baseURL?: string): Promise<KeyVerification> {
  const client = new OpenAI({
    apiKey,
    maxRetries: 0,
    timeout: 15_000,
    ...(baseURL ? { baseURL } : {}),
  });
  try {
    await client.models.list();
    return { status: 'valid' };
  } catch (err) {
    if (err instanceof OpenAI.APIError) {
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
