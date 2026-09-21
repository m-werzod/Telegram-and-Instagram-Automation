import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TELEGRAM_MAX_MESSAGE,
  TelegramClient,
  splitMessage,
} from '../../src/modules/channels/telegram/client.js';
import {
  IG_DM_MAX_BYTES,
  InstagramClient,
  clampBytes,
  clampChars,
} from '../../src/modules/channels/instagram/client.js';
import { ExternalApiError, RateLimitedError } from '../../src/lib/errors.js';
import { initLogger } from '../../src/lib/logger.js';
import { makeTestEnv } from '../helpers/test-env.js';

const encoder = new TextEncoder();

/** Minimal Response stand-in — the clients only touch .ok, .status and .json(). */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function nonWs(s: string): string {
  return s.replace(/\s+/g, '');
}

describe('splitMessage', () => {
  it('returns a short message untouched as a single part', () => {
    expect(splitMessage('hello world', TELEGRAM_MAX_MESSAGE)).toEqual(['hello world']);
  });

  it('trims surrounding whitespace on the passthrough path', () => {
    expect(splitMessage('  hi there \n', TELEGRAM_MAX_MESSAGE)).toEqual(['hi there']);
  });

  it('splits text longer than 4096 chars at newline boundaries, no part exceeding the limit', () => {
    const line = 'x'.repeat(100);
    const text = Array.from({ length: 60 }, (_, i) => `${line}${i % 10}`).join('\n'); // ~6060 chars
    const parts = splitMessage(text, TELEGRAM_MAX_MESSAGE);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
      // split happened on the newline: no part starts or ends mid-line with whitespace
      expect(part).toBe(part.trim());
    }
    // content is preserved, in order
    expect(nonWs(parts.join(''))).toBe(nonWs(text));
  });

  it('falls back to space boundaries when no newline is in range', () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}abcdef`).join(' '); // no newlines
    const parts = splitMessage(words, 50);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(50);
    }
    expect(nonWs(parts.join(''))).toBe(nonWs(words));
    // every part except possibly boundaries contains whole words
    expect(parts[0]!.endsWith('abcdef')).toBe(true);
  });

  it('hard-cuts an unbroken run longer than the limit', () => {
    const blob = 'a'.repeat(120);
    const parts = splitMessage(blob, 50);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(50);
    expect(parts.join('')).toBe(blob);
  });
});

describe('clampChars', () => {
  it('passes through text at or under the limit', () => {
    expect(clampChars('short', 10)).toBe('short');
    expect(clampChars('exactlyten', 10)).toBe('exactlyten');
  });

  it('truncates over-limit text to at most max chars, ending with an ellipsis', () => {
    const out = clampChars('a'.repeat(50), 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('a'.repeat(9))).toBe(true);
  });
});

describe('clampBytes', () => {
  it('passes through text within the byte budget', () => {
    expect(clampBytes('hello', 1000)).toBe('hello');
  });

  it('clamps cyrillic text (2-byte chars) without splitting a code point', () => {
    const text = 'привет'.repeat(200); // 1200 chars, 2400 bytes
    const out = clampBytes(text, 100);
    const bytes = encoder.encode(out);
    expect(bytes.length).toBeLessThanOrEqual(100);
    // re-decode: a split code point would surface as U+FFFD
    expect(new TextDecoder().decode(bytes)).toBe(out);
    expect(out.includes('�')).toBe(false);
    expect(out.endsWith('…')).toBe(true);
    // preserved prefix matches the original
    expect(text.startsWith(out.slice(0, -1))).toBe(true);
  });

  it('clamps emoji text (4-byte chars, surrogate pairs) without splitting a code point', () => {
    const text = '😀'.repeat(500); // 2000 bytes
    const out = clampBytes(text, 101); // budget not divisible by 4 forces a mid-char stop
    const bytes = encoder.encode(out);
    expect(bytes.length).toBeLessThanOrEqual(101);
    expect(new TextDecoder().decode(bytes)).toBe(out);
    expect(out.includes('�')).toBe(false);
    // no lone surrogate anywhere (in /u mode this class matches only unpaired halves)
    expect(/[\uD800-\uDFFF]/u.test(out)).toBe(false);
    expect([...out.slice(0, -1)].every((ch) => ch === '😀')).toBe(true);
  });
});

describe('TelegramClient', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = () => new TelegramClient('test-token', 'https://tg.example');

  it('getMe returns the result on ok:true', async () => {
    const bot = { id: 42, is_bot: true, first_name: 'Bot', username: 'test_bot' };
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: bot }));
    await expect(client().getMe()).resolves.toEqual(bot);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://tg.example/bottest-token/getMe');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('throws RateLimitedError with retryAfterMs on error_code 429 + retry_after', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: false,
        error_code: 429,
        description: 'Too Many Requests',
        parameters: { retry_after: 7 },
      }),
    );
    const err = await client().getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBe(7000);
    expect((err as RateLimitedError).retryable).toBe(true);
  });

  it('defaults retryAfterMs to 5000 on a 429 without parameters', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error_code: 429 }));
    const err = await client().getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBe(5000);
  });

  it('throws a non-retryable ExternalApiError on error_code 401', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }),
    );
    const err = await client().getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalApiError);
    expect(err).not.toBeInstanceOf(RateLimitedError);
    expect((err as ExternalApiError).retryable).toBe(false);
    expect((err as ExternalApiError).statusCode).toBe(401);
  });

  it('throws a retryable ExternalApiError on error_code 500', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: false, error_code: 500, description: 'Internal' }),
    );
    const err = await client().getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalApiError);
    expect((err as ExternalApiError).retryable).toBe(true);
  });

  it('sendMessage splits long text into multiple sequential POSTs', async () => {
    const msg = (id: number) => ({
      message_id: id,
      chat: { id: 1, type: 'private' },
      date: 0,
      text: 'part',
    });
    let n = 0;
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, result: msg(++n) }));

    const line = 'y'.repeat(200);
    const text = Array.from({ length: 30 }, () => line).join('\n'); // ~6030 chars
    const sent = await client().sendMessage(123, text);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(sent).toHaveLength(fetchMock.mock.calls.length);
    const bodies = fetchMock.mock.calls.map(
      (c) => JSON.parse((c[1] as RequestInit).body as string) as { chat_id: number; text: string },
    );
    for (const body of bodies) {
      expect(body.chat_id).toBe(123);
      expect(body.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
    }
    expect(nonWs(bodies.map((b) => b.text).join(''))).toBe(nonWs(text));
  });

  it('wraps a network failure as a retryable ExternalApiError', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const err = await client().getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalApiError);
    expect((err as ExternalApiError).retryable).toBe(true);
    expect((err as ExternalApiError).message).toContain('network failure');
  });
});

describe('InstagramClient', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = () => new InstagramClient('ig-token', 'https://ig.example');

  it('getMe returns the account on success and sends the bearer token', async () => {
    const account = { user_id: '789', username: 'shop', account_type: 'BUSINESS' };
    fetchMock.mockResolvedValueOnce(jsonResponse(account));
    await expect(client().getMe()).resolves.toEqual(account);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('https://ig.example/v25.0/me');
    expect(String(url)).toContain('fields=');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer ig-token' });
  });

  it('maps error code 190 (invalid token) to a non-retryable 401 ExternalApiError', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: 'Invalid OAuth access token', code: 190 } }, 400),
    );
    const err = await client().getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalApiError);
    expect(err).not.toBeInstanceOf(RateLimitedError);
    expect((err as ExternalApiError).statusCode).toBe(401);
    expect((err as ExternalApiError).retryable).toBe(false);
  });

  it('maps error code 4 (app rate limit) to RateLimitedError', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: 'Application request limit reached', code: 4 } }, 400),
    );
    const err = await client().getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBe(60_000);
  });

  it('maps error code 10 (permission denied) to a non-retryable error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: 'Permission denied', code: 10 } }, 400),
    );
    const err = await client().getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalApiError);
    expect((err as ExternalApiError).retryable).toBe(false);
    expect((err as ExternalApiError).statusCode).toBe(403);
  });

  it('maps HTTP 500 with error code 1 to a retryable error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: 'An unknown error occurred', code: 1 } }, 500),
    );
    const err = await client().getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalApiError);
    expect((err as ExternalApiError).retryable).toBe(true);
    expect((err as ExternalApiError).statusCode).toBe(500);
  });

  it('treats an error body on an HTTP 200 as a failure too', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: 'Invalid OAuth access token', code: 190 } }, 200),
    );
    const err = await client().getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalApiError);
    expect((err as ExternalApiError).retryable).toBe(false);
  });

  it('sendMessage clamps text over 1000 UTF-8 bytes before POSTing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ recipient_id: 'r', message_id: 'm' }));
    const text = 'ё'.repeat(900); // 1800 bytes
    await client().sendMessage('igsid-1', text);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/v25.0/me/messages');
    const body = JSON.parse((init as RequestInit).body as string) as {
      recipient: { id: string };
      message: { text: string };
    };
    expect(body.recipient.id).toBe('igsid-1');
    expect(encoder.encode(body.message.text).length).toBeLessThanOrEqual(IG_DM_MAX_BYTES);
    expect(body.message.text.endsWith('…')).toBe(true);
    expect(text.startsWith(body.message.text.slice(0, -1))).toBe(true);
  });

  it('sendMessage passes short text through unclamped', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message_id: 'm' }));
    await client().sendMessage('igsid-1', 'hi there');
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as { message: { text: string } };
    expect(body.message.text).toBe('hi there');
  });
});
