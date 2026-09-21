import { z } from 'zod';

/**
 * Environment configuration, validated at boot. The process refuses to start
 * with an invalid configuration rather than failing at request time.
 *
 * Secrets are only ever read here and passed to the modules that need them.
 * They must never be logged or returned by any API response.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Public HTTPS base URL of this deployment (used to build webhook callback URLs). */
  APP_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  /** Optional. When absent, jobs run on the in-process inline queue (no Redis required). */
  REDIS_URL: z.string().optional(),

  /** 64 hex chars = 32 bytes. Used for AES-256-GCM encryption of stored credentials. */
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),
  /** Secret used to sign/derive dashboard session tokens. */
  SESSION_SECRET: z.string().min(16),
  /** Session lifetime in hours. */
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(72),

  // AI providers
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Embeddings provider for semantic knowledge retrieval. 'none' falls back to Postgres full-text search. */
  EMBEDDINGS_PROVIDER: z.enum(['voyage', 'openai', 'none']).default('none'),
  VOYAGE_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  // Meta / Instagram
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  /** Token you choose; entered verbatim in the Meta App Dashboard webhook configuration. */
  META_VERIFY_TOKEN: z.string().optional(),
  /** Optional: seed an Instagram connection from env instead of the dashboard. */
  INSTAGRAM_ACCESS_TOKEN: z.string().optional(),

  // Telegram
  /** Optional: seed the Telegram connection from env instead of the dashboard. */
  TELEGRAM_BOT_TOKEN: z.string().optional(),

  // Initial admin (used by prisma seed only)
  ADMIN_EMAIL: z.string().email().default('admin@example.com'),
  ADMIN_PASSWORD: z.string().min(8).default('change-me-now'),
  TENANT_NAME: z.string().default('Default Business'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(overrides?: Partial<Record<keyof Env, string>>): Env {
  const parsed = envSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export function getEnv(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

/** Test helper — inject a fully-built env. */
export function setEnvForTesting(env: Env): void {
  cached = env;
}
