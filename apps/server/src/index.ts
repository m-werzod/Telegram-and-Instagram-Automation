import { loadEnv, setEnvForTesting } from './config/env.js';
import { disconnectPrisma, getPrisma } from './db/client.js';
import { errorMessage } from './lib/errors.js';
import { initLogger } from './lib/logger.js';
import { initAI } from './modules/ai/index.js';
import { recoverStuckEvents } from './modules/webhooks/service.js';
import { pruneExpiredSessions } from './modules/auth/service.js';
import { createQueue } from './queue/index.js';
import { registerWorkers } from './workers/webhook-processor.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const env = loadEnv();
  setEnvForTesting(env);
  const logger = initLogger(env.LOG_LEVEL, env.NODE_ENV !== 'production');

  initAI(env);

  const queue = await createQueue(env);
  registerWorkers(queue);
  await queue.start();

  const app = await buildApp(env);
  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info({ port: env.PORT }, 'server listening');

  // Recover events persisted before a crash/restart (spec §54).
  try {
    const recovered = await recoverStuckEvents();
    if (recovered > 0) logger.info({ recovered }, 'requeued stuck webhook events');
  } catch (err) {
    logger.warn({ err: errorMessage(err) }, 'recovery sweep failed (db not migrated yet?)');
  }

  // Seed channel connections from env if provided and not yet connected (spec §15).
  await autoConnectFromEnv().catch((err) =>
    logger.warn({ err: errorMessage(err) }, 'env auto-connect failed'),
  );

  // Housekeeping: session pruning + periodic connection health checks.
  const housekeeping = setInterval(
    () => {
      void pruneExpiredSessions().catch(() => undefined);
      void runHealthChecks().catch(() => undefined);
    },
    15 * 60 * 1000,
  );
  housekeeping.unref();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(housekeeping);
    await app.close().catch(() => undefined);
    await queue.stop().catch(() => undefined);
    await disconnectPrisma().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function autoConnectFromEnv(): Promise<void> {
  const env = loadEnv();
  const prisma = getPrisma();
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) return;

  if (env.TELEGRAM_BOT_TOKEN) {
    const existing = await prisma.channelConnection.findUnique({
      where: { tenantId_channel: { tenantId: tenant.id, channel: 'TELEGRAM' } },
    });
    if (!existing || existing.status !== 'connected') {
      const { connectTelegram } = await import('./modules/channels/telegram/service.js');
      await connectTelegram(tenant.id, env.TELEGRAM_BOT_TOKEN);
      initLogger(env.LOG_LEVEL, env.NODE_ENV !== 'production').info(
        'telegram connected from TELEGRAM_BOT_TOKEN env',
      );
    }
  }

  if (env.INSTAGRAM_ACCESS_TOKEN) {
    const existing = await prisma.channelConnection.findUnique({
      where: { tenantId_channel: { tenantId: tenant.id, channel: 'INSTAGRAM' } },
    });
    if (!existing || existing.status !== 'connected') {
      const { connectInstagram } = await import('./modules/channels/instagram/service.js');
      await connectInstagram(tenant.id, env.INSTAGRAM_ACCESS_TOKEN);
    }
  }
}

async function runHealthChecks(): Promise<void> {
  const prisma = getPrisma();
  const connections = await prisma.channelConnection.findMany({
    where: { status: 'connected' },
  });
  for (const connection of connections) {
    try {
      if (connection.channel === 'TELEGRAM') {
        const { checkTelegramHealth } = await import('./modules/channels/telegram/service.js');
        const result = await checkTelegramHealth(connection);
        await prisma.channelConnection.update({
          where: { id: connection.id },
          data: { healthStatus: result.status, healthDetail: result.detail, lastHealthCheckAt: new Date() },
        });
      } else if (connection.channel === 'INSTAGRAM') {
        const { checkInstagramHealth } = await import('./modules/channels/instagram/service.js');
        const result = await checkInstagramHealth(connection);
        await prisma.channelConnection.update({
          where: { id: connection.id },
          data: { healthStatus: result.status, healthDetail: result.detail, lastHealthCheckAt: new Date() },
        });
      }
    } catch {
      // health check failures are recorded on the next successful pass
    }
  }
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
