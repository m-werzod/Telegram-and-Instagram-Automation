import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AnthropicProvider } from '../../src/modules/ai/anthropic-provider.js';
import { ExternalApiError } from '../../src/lib/errors.js';
import { initLogger } from '../../src/lib/logger.js';
import { makeTestEnv } from '../helpers/test-env.js';

const schema = z.object({ reply: z.string().nullable(), intent: z.string() });

function messageResponse(over: Record<string, unknown>): unknown {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
    ...over,
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
  return new AnthropicProvider('sk-ant-test').generateStructured({
    system: 'you are a test agent',
    messages: [{ role: 'user', content: 'salom' }],
    schema,
    schemaName: 'test_decision',
    model: 'claude-sonnet-5',
    ...(maxTokens === undefined ? {} : { maxTokens }),
    effort: 'medium',
  });
}

describe('AnthropicProvider.generateStructured', () => {
  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('parses and validates a well-formed structured response', async () => {
    stubFetch(
      200,
      messageResponse({
        content: [{ type: 'text', text: '{"reply":"Assalomu alaykum","intent":"greeting"}' }],
        usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 400 },
      }),
    );

    const result = await generate();
    expect(result.output).toEqual({ reply: 'Assalomu alaykum', intent: 'greeting' });
    // Cached reads are real input tokens — they belong in the usage total.
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 30 });
  });

  it('sends the schema and effort inside output_config', async () => {
    const fetchSpy = stubFetch(
      200,
      messageResponse({ content: [{ type: 'text', text: '{"reply":null,"intent":"spam"}' }] }),
    );
    await generate();

    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body.output_config.effort).toBe('medium');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema.required).toEqual(['reply', 'intent']);
    // Provider default when the caller does not pass one.
    expect(body.max_tokens).toBe(4096);
  });

  // A truncated response is a half-written JSON object. It must not be
  // reported as "the model returned non-JSON", and must not be retried —
  // the same request under the same ceiling truncates identically.
  it('reports a response cut off at the token ceiling as exactly that', async () => {
    stubFetch(
      200,
      messageResponse({
        content: [{ type: 'text', text: '{"reply":"Assalomu alay' }],
        stop_reason: 'max_tokens',
      }),
    );

    await expect(generate(2048)).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining('2048-token ceiling'),
    });
  });

  it('surfaces a safety refusal instead of throwing', async () => {
    stubFetch(
      200,
      messageResponse({
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'other', explanation: 'declined' },
      }),
    );

    const result = await generate();
    expect(result.refused).toBe(true);
    expect(result.refusalReason).toBe('declined');
  });

  it('rejects output that does not satisfy the schema', async () => {
    stubFetch(
      200,
      messageResponse({ content: [{ type: 'text', text: '{"reply":"hi"}' }] }),
    );
    await expect(generate()).rejects.toBeInstanceOf(ExternalApiError);
  });

  it('maps a 401 to a non-retryable error — a bad key must not be retried', async () => {
    stubFetch(401, {
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' },
    });

    await expect(generate()).rejects.toMatchObject({
      statusCode: 401,
      retryable: false,
    });
  });

  it('maps a 429 to a retryable error', async () => {
    stubFetch(429, {
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down' },
    });

    await expect(generate()).rejects.toMatchObject({ statusCode: 429, retryable: true });
  });
});
