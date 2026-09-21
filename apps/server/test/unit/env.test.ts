import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { initLogger } from '../../src/lib/logger.js';

/**
 * loadEnv merges process.env with the given overrides. To keep these tests
 * hermetic we remove every schema-relevant key from process.env before each
 * test and restore the original values afterwards, so the overrides passed to
 * loadEnv fully drive the outcome regardless of the host environment.
 */
const MANAGED_KEYS = [
  'NODE_ENV',
  'PORT',
  'HOST',
  'APP_URL',
  'LOG_LEVEL',
  'DATABASE_URL',
  'REDIS_URL',
  'ENCRYPTION_KEY',
  'SESSION_SECRET',
  'SESSION_TTL_HOURS',
  'ANTHROPIC_API_KEY',
  'EMBEDDINGS_PROVIDER',
  'VOYAGE_API_KEY',
  'OPENAI_API_KEY',
  'META_APP_ID',
  'META_APP_SECRET',
  'META_VERIFY_TOKEN',
  'INSTAGRAM_ACCESS_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'ADMIN_LOGIN',
  'ADMIN_PASSWORD',
  'TENANT_NAME',
  'TRUST_PROXY',
  'ALLOW_INLINE_QUEUE',
] as const;

const VALID_KEY = 'ab'.repeat(32); // 64 lowercase hex chars

/** Minimal set of overrides that satisfies the schema deterministically. */
function baseOverrides(extra: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/app',
    ENCRYPTION_KEY: VALID_KEY,
    SESSION_SECRET: 'a-session-secret-that-is-long-enough',
    ...extra,
  };
}

describe('loadEnv', () => {
  let savedEnv: Map<string, string | undefined>;

  beforeEach(() => {
    initLogger('silent', false);
    savedEnv = new Map();
    for (const key of MANAGED_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('parses a minimal valid override set and applies defaults', () => {
    const env = loadEnv(baseOverrides());
    expect(env.NODE_ENV).toBe('test');
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SESSION_TTL_HOURS).toBe(72);
    expect(env.EMBEDDINGS_PROVIDER).toBe('none');
    expect(env.DATABASE_URL).toBe('postgresql://user:pass@localhost:5432/app');
    expect(env.ENCRYPTION_KEY).toBe(VALID_KEY);
    expect(env.APP_URL).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.ADMIN_LOGIN).toBe('Instagram');
    expect(env.TENANT_NAME).toBe('Default Business');
  });

  it('defaults NODE_ENV to development when unset everywhere', () => {
    const overrides = baseOverrides();
    delete overrides.NODE_ENV;
    const env = loadEnv(overrides);
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces PORT from the string "8080" to the number 8080', () => {
    const env = loadEnv(baseOverrides({ PORT: '8080' }));
    expect(env.PORT).toBe(8080);
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => loadEnv(baseOverrides({ PORT: 'not-a-port' }))).toThrow(
      /Invalid environment configuration:[\s\S]*PORT/,
    );
  });

  it('rejects a negative PORT', () => {
    expect(() => loadEnv(baseOverrides({ PORT: '-1' }))).toThrow(/PORT/);
  });

  it('rejects a fractional PORT (must be an integer)', () => {
    expect(() => loadEnv(baseOverrides({ PORT: '80.5' }))).toThrow(/PORT/);
  });

  it('rejects an ENCRYPTION_KEY that is too short, with a helpful message', () => {
    expect(() => loadEnv(baseOverrides({ ENCRYPTION_KEY: 'abcd1234' }))).toThrow(
      /ENCRYPTION_KEY must be 64 hex characters \(32 bytes\)/,
    );
  });

  it('rejects a 64-char ENCRYPTION_KEY containing non-hex characters', () => {
    expect(() => loadEnv(baseOverrides({ ENCRYPTION_KEY: 'z'.repeat(64) }))).toThrow(
      /ENCRYPTION_KEY must be 64 hex characters/,
    );
  });

  it('accepts an uppercase hex ENCRYPTION_KEY', () => {
    const upper = 'AB'.repeat(32);
    const env = loadEnv(baseOverrides({ ENCRYPTION_KEY: upper }));
    expect(env.ENCRYPTION_KEY).toBe(upper);
  });

  it('throws when DATABASE_URL is missing, naming the field', () => {
    const overrides = baseOverrides();
    delete overrides.DATABASE_URL;
    expect(() => loadEnv(overrides)).toThrow(/DATABASE_URL/);
  });

  it('rejects an APP_URL that is not a URL', () => {
    expect(() => loadEnv(baseOverrides({ APP_URL: 'not a url' }))).toThrow(/APP_URL/);
  });

  it('accepts a valid https APP_URL', () => {
    const env = loadEnv(baseOverrides({ APP_URL: 'https://bot.example.com' }));
    expect(env.APP_URL).toBe('https://bot.example.com');
  });

  it('rejects a SESSION_SECRET shorter than 16 characters', () => {
    expect(() => loadEnv(baseOverrides({ SESSION_SECRET: 'too-short' }))).toThrow(
      /SESSION_SECRET/,
    );
  });

  it('rejects an unknown EMBEDDINGS_PROVIDER and accepts a listed one', () => {
    expect(() => loadEnv(baseOverrides({ EMBEDDINGS_PROVIDER: 'bogus' }))).toThrow(
      /EMBEDDINGS_PROVIDER/,
    );
    const env = loadEnv(baseOverrides({ EMBEDDINGS_PROVIDER: 'voyage' }));
    expect(env.EMBEDDINGS_PROVIDER).toBe('voyage');
  });

  it('lets overrides shadow values present in process.env', () => {
    process.env.PORT = '9999';
    process.env.LOG_LEVEL = 'debug';
    const env = loadEnv(baseOverrides({ PORT: '8080' }));
    expect(env.PORT).toBe(8080);
    // Not overridden, so the process.env value flows through.
    expect(env.LOG_LEVEL).toBe('debug');
  });

  it('aggregates every issue into one error message', () => {
    const overrides = baseOverrides({
      ENCRYPTION_KEY: 'short',
      APP_URL: 'nope',
      PORT: 'abc',
    });
    delete overrides.DATABASE_URL;
    let message = '';
    try {
      loadEnv(overrides);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('Invalid environment configuration:');
    expect(message).toContain('ENCRYPTION_KEY');
    expect(message).toContain('APP_URL');
    expect(message).toContain('PORT');
    expect(message).toContain('DATABASE_URL');
  });

  it('coerces SESSION_TTL_HOURS from a string and rejects zero', () => {
    const env = loadEnv(baseOverrides({ SESSION_TTL_HOURS: '24' }));
    expect(env.SESSION_TTL_HOURS).toBe(24);
    expect(() => loadEnv(baseOverrides({ SESSION_TTL_HOURS: '0' }))).toThrow(
      /SESSION_TTL_HOURS/,
    );
  });

  it('rejects a too-short ADMIN_PASSWORD', () => {
    expect(() => loadEnv(baseOverrides({ ADMIN_PASSWORD: 'short' }))).toThrow(/ADMIN_PASSWORD/);
  });
});
