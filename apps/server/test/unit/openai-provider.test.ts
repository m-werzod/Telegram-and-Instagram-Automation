import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenAIProvider, strictTextFormat, toStrictSchema } from '../../src/modules/ai/openai-provider.js';
import { agentDecisionSchema } from '../../src/modules/engine/decision.js';
import { ExternalApiError } from '../../src/lib/errors.js';
import { initLogger } from '../../src/lib/logger.js';
import { makeTestEnv } from '../helpers/test-env.js';

const schema = z.object({ reply: z.string().nullable(), intent: z.string() });

function responsePayload(over: Record<string, unknown> = {}): unknown {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 1_700_000_000,
    status: 'completed',
    model: 'gpt-5',
    output: [],
    output_text: '',
    incomplete_details: null,
    error: null,
    usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 },
    ...over,
  };
}

function textMessage(text: string): unknown {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

function generate(maxTokens?: number) {
  return new OpenAIProvider('sk-test').generateStructured({
    system: 'you are a test agent',
    messages: [{ role: 'user', content: 'salom' }],
    schema,
    schemaName: 'test_decision',
    model: 'gpt-5',
    ...(maxTokens === undefined ? {} : { maxTokens }),
    effort: 'medium',
  });
}

/**
 * OpenAI strict mode rejects the whole request over an unsupported keyword, and
 * `zodTextFormat` faithfully emits `minimum`/`maximum` for the decision's
 * `leadScore`. Without this stripping, every single agent run would 400.
 */
describe('toStrictSchema', () => {
  it('drops numeric constraints strict mode rejects', () => {
    const cleaned = toStrictSchema({
      type: 'object',
      properties: { score: { type: 'number', minimum: 0, maximum: 100 } },
      required: ['score'],
      additionalProperties: false,
    }) as Record<string, any>;

    expect(cleaned.properties.score).toEqual({ type: 'number' });
    expect(cleaned.required).toEqual(['score']);
    expect(cleaned.additionalProperties).toBe(false);
  });

  it('keeps enums, nullable unions and nesting intact', () => {
    const cleaned = toStrictSchema({
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['a', 'b'] },
        nested: {
          anyOf: [
            { type: 'object', properties: { x: { type: ['string', 'null'] } }, required: ['x'] },
            { type: 'null' },
          ],
        },
      },
    }) as Record<string, any>;

    expect(cleaned.properties.intent.enum).toEqual(['a', 'b']);
    expect(cleaned.properties.nested.anyOf[0].properties.x.type).toEqual(['string', 'null']);
  });

  // A property legitimately called "format" or "pattern" must survive — only
  // schema KEYWORDS are filtered, never property NAMES.
  it('does not filter property names that collide with keywords', () => {
    const cleaned = toStrictSchema({
      type: 'object',
      properties: { format: { type: 'string' }, pattern: { type: 'string' } },
      required: ['format', 'pattern'],
    }) as Record<string, any>;

    expect(Object.keys(cleaned.properties)).toEqual(['format', 'pattern']);
  });

  it('produces a strict-safe format for the real agent decision schema', () => {
    const format = strictTextFormat(agentDecisionSchema, 'agent_decision') as any;
    const json = JSON.stringify(format.schema);

    expect(format.strict).toBe(true);
    expect(format.schema.additionalProperties).toBe(false);
    // Strict mode requires every property listed as required.
    expect(format.schema.required).toHaveLength(Object.keys(format.schema.properties).length);
    expect(json).not.toContain('minimum');
    expect(json).not.toContain('maximum');
    expect(json).not.toContain('$schema');
    // The constraint that matters for routing is preserved.
    expect(format.schema.properties.intent.enum).toContain('purchase_intent');
  });
});

describe('OpenAIProvider.generateStructured', () => {
  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('parses and validates a well-formed structured response', async () => {
    stubFetch(
      200,
      responsePayload({
        output: [textMessage('{"reply":"Assalomu alaykum","intent":"greeting"}')],
        output_text: '{"reply":"Assalomu alaykum","intent":"greeting"}',
      }),
    );

    const result = await generate();
    expect(result.output).toEqual({ reply: 'Assalomu alaykum', intent: 'greeting' });
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 30 });
    expect(result.model).toBe('gpt-5');
  });

  it('sends the strict schema, effort and token cap on the Responses API', async () => {
    const fetchSpy = stubFetch(
      200,
      responsePayload({
        output: [textMessage('{"reply":null,"intent":"spam"}')],
        output_text: '{"reply":null,"intent":"spam"}',
      }),
    );
    await generate(8192);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/responses');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('gpt-5');
    expect(body.instructions).toBe('you are a test agent');
    expect(body.max_output_tokens).toBe(8192);
    expect(body.reasoning.effort).toBe('medium');
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.strict).toBe(true);
    expect(JSON.stringify(body.text.format.schema)).not.toContain('minimum');
  });

  it('falls back to the output parts when output_text is absent', async () => {
    stubFetch(
      200,
      responsePayload({ output: [textMessage('{"reply":"ok","intent":"question"}')] }),
    );
    const result = await generate();
    expect(result.output).toEqual({ reply: 'ok', intent: 'question' });
  });

  it('surfaces a refusal instead of throwing', async () => {
    stubFetch(
      200,
      responsePayload({
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'refusal', refusal: 'I cannot help with that' }],
          },
        ],
      }),
    );

    const result = await generate();
    expect(result.refused).toBe(true);
    expect(result.refusalReason).toBe('I cannot help with that');
  });

  it('reports a response cut off at the token ceiling as exactly that', async () => {
    stubFetch(
      200,
      responsePayload({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [textMessage('{"reply":"Assalomu alay')],
      }),
    );

    await expect(generate(2048)).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining('2048-token ceiling'),
    });
  });

  it('rejects output that does not satisfy the schema', async () => {
    stubFetch(
      200,
      responsePayload({ output: [textMessage('{"reply":"hi"}')], output_text: '{"reply":"hi"}' }),
    );
    await expect(generate()).rejects.toBeInstanceOf(ExternalApiError);
  });

  it('maps a 401 to a non-retryable error — a bad key must not be retried', async () => {
    stubFetch(401, { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } });
    await expect(generate()).rejects.toMatchObject({ statusCode: 401, retryable: false });
  });

  it('maps a 429 to a retryable error', async () => {
    stubFetch(429, { error: { message: 'Rate limit reached' } });
    await expect(generate()).rejects.toMatchObject({ statusCode: 429, retryable: true });
  });
});
