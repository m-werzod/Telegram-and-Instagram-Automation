import type { Env } from '../../src/config/env.js';
import { setEnvForTesting } from '../../src/config/env.js';

export const TEST_ENCRYPTION_KEY = 'a'.repeat(64);

export function makeTestEnv(overrides: Partial<Env> = {}): Env {
  const env: Env = {
    NODE_ENV: 'test',
    PORT: 0,
    HOST: '127.0.0.1',
    APP_URL: 'https://test.example.com',
    LOG_LEVEL: 'error',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: undefined,
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    SESSION_SECRET: 'test-session-secret-value',
    SESSION_TTL_HOURS: 72,
    ANTHROPIC_API_KEY: undefined,
    EMBEDDINGS_PROVIDER: 'none',
    VOYAGE_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    META_APP_ID: 'test-app-id',
    META_APP_SECRET: 'test-app-secret',
    META_VERIFY_TOKEN: 'test-verify-token',
    INSTAGRAM_ACCESS_TOKEN: undefined,
    TELEGRAM_BOT_TOKEN: undefined,
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'test-password',
    TENANT_NAME: 'Test Tenant',
    ...overrides,
  };
  setEnvForTesting(env);
  return env;
}
