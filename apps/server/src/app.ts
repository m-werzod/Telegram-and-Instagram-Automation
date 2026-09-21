import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from './config/env.js';
import { getPrisma } from './db/client.js';
import { AppError } from './lib/errors.js';
import { getLogger } from './lib/logger.js';
import { agentRoutes } from './api/agent-routes.js';
import { authRoutes } from './api/auth-routes.js';
import { connectionRoutes } from './api/connection-routes.js';
import { crmRoutes } from './api/crm-routes.js';
import { knowledgeRoutes } from './api/knowledge-routes.js';
import { opsRoutes } from './api/ops-routes.js';
import { instagramWebhookRoutes } from './modules/channels/instagram/routes.js';
import { telegramWebhookRoutes } from './modules/channels/telegram/routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    loggerInstance: getLogger().child({ module: 'http' }) as FastifyInstance['log'],
    // Only trust X-Forwarded-For behind a real reverse proxy — otherwise
    // clients could spoof req.ip and rotate past per-IP rate limits.
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 25 * 1024 * 1024,
  });

  // JSON parser that keeps the raw body — required for Meta signature checks.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 },
    (req, body, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
      try {
        const text = (body as Buffer).toString('utf8');
        done(null, text.length ? JSON.parse(text) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
  });
  await app.register(fastifyCookie);
  await app.register(fastifyCors, {
    // Same-origin in production (dashboard is served by this server).
    // In development the Vite dev server proxies /api, so no cross-origin either;
    // localhost:5173 is allowed as a convenience for direct API calls.
    origin: env.NODE_ENV === 'production' ? false : ['http://localhost:5173'],
    credentials: true,
  });
  // Rate-limit state lives in Redis when available (durable, multi-instance
  // safe); the in-memory store remains for development without Redis.
  let rateLimitRedis: import('ioredis').Redis | undefined;
  if (env.REDIS_URL) {
    const { Redis } = await import('ioredis');
    rateLimitRedis = new Redis(env.REDIS_URL, { connectTimeout: 1000, maxRetriesPerRequest: 1 });
    app.addHook('onClose', async () => {
      rateLimitRedis?.disconnect();
    });
  }
  await app.register(fastifyRateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    ...(rateLimitRedis ? { redis: rateLimitRedis } : {}),
  });
  await app.register(fastifyMultipart);

  // Uniform error responses; AppError carries status + code, secrets never leak.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply
        .code(err.statusCode)
        .send({ error: { code: err.code, message: err.message } });
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  // Public liveness/readiness. Must respond fast even when the DB is down.
  app.get('/api/health', { config: { rateLimit: false } }, async () => {
    let db = 'ok';
    try {
      await Promise.race([
        getPrisma().$queryRaw`SELECT 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error('db ping timeout')), 1500).unref()),
      ]);
    } catch {
      db = 'down';
    }
    return { status: db === 'ok' ? 'ok' : 'degraded', db };
  });

  // Webhooks (public, verified by signature / secret token).
  await app.register(instagramWebhookRoutes);
  await app.register(telegramWebhookRoutes);

  // Authenticated dashboard API.
  await app.register(authRoutes);
  await app.register(agentRoutes);
  await app.register(connectionRoutes);
  await app.register(crmRoutes);
  await app.register(knowledgeRoutes);
  await app.register(opsRoutes);

  // Dashboard SPA (built by apps/dashboard → public/dashboard).
  const dashboardDir = path.resolve(here, '..', 'public', 'dashboard');
  if (existsSync(dashboardDir)) {
    await app.register(fastifyStatic, { root: dashboardDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    });
  }

  return app;
}
