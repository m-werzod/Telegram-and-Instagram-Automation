import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../db/client.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import {
  checkInstagramHealth,
  connectInstagram,
  disconnectInstagram,
} from '../modules/channels/instagram/service.js';
import {
  applyTelegramProfile,
  checkTelegramHealth,
  configureTelegramWebhook,
  connectTelegram,
  disconnectTelegram,
  readTelegramProfile,
  DEFAULT_BOT_PROFILE,
} from '../modules/channels/telegram/service.js';
import { adminOnlyWrites, requireAdmin, requireAuth, tenantOf } from './middleware.js';

const botProfileSchema = z.object({
  name: z.string().trim().min(1).max(64),
  shortDescription: z.string().trim().max(120),
  description: z.string().trim().max(512),
  commands: z
    .array(
      z.object({
        command: z
          .string()
          .trim()
          .regex(/^[a-z0-9_]{1,32}$/, 'A command may only contain a-z, 0-9 and _'),
        description: z.string().trim().min(1).max(256),
      }),
    )
    .max(100),
});

/**
 * Channel connections (spec §14–16, §27). Secrets never leave the server:
 * responses carry display metadata and health only.
 */
export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  // Belt and braces: every handler below also calls requireAdmin, but a new
  // route added later must not be able to forget it.
  app.addHook('preHandler', adminOnlyWrites);

  app.get('/api/connections', async (req) => {
    const connections = await getPrisma().channelConnection.findMany({
      where: { tenantId: tenantOf(req) },
      orderBy: { channel: 'asc' },
    });
    return { connections: connections.map(publicConnection) };
  });

  app.post<{ Body: { botToken?: string } }>('/api/connections/telegram', async (req) => {
    requireAdmin(req);
    const token = z.string().min(10).safeParse(req.body?.botToken);
    if (!token.success) throw new ValidationError('botToken is required');
    const connection = await connectTelegram(tenantOf(req), token.data);
    return { connection: publicConnection(connection) };
  });

  app.post<{ Body: { accessToken?: string } }>('/api/connections/instagram', async (req) => {
    requireAdmin(req);
    const token = z.string().min(10).safeParse(req.body?.accessToken);
    if (!token.success) throw new ValidationError('accessToken is required');
    const connection = await connectInstagram(tenantOf(req), token.data);
    return { connection: publicConnection(connection) };
  });

  app.post('/api/connections/telegram/reconfigure-webhook', async (req) => {
    requireAdmin(req);
    const connection = await getPrisma().channelConnection.findUnique({
      where: { tenantId_channel: { tenantId: tenantOf(req), channel: 'TELEGRAM' } },
    });
    if (!connection) throw new NotFoundError('Telegram is not connected');
    await configureTelegramWebhook(connection.id);
    const updated = await getPrisma().channelConnection.findUnique({ where: { id: connection.id } });
    return { connection: publicConnection(updated!) };
  });

  /** How the bot presents itself in Telegram — owned by the dashboard. */
  app.get('/api/connections/telegram/profile', async (req) => {
    const connection = await telegramConnectionOf(tenantOf(req));
    return { profile: readTelegramProfile(connection), defaults: DEFAULT_BOT_PROFILE };
  });

  app.put('/api/connections/telegram/profile', async (req) => {
    requireAdmin(req);
    const parsed = botProfileSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid bot profile');
    const connection = await telegramConnectionOf(tenantOf(req));
    const { profile, results } = await applyTelegramProfile(connection, parsed.data);
    return { profile, results };
  });

  app.delete<{ Params: { channel: string } }>('/api/connections/:channel', async (req) => {
    requireAdmin(req);
    const channel = req.params.channel.toUpperCase();
    if (channel === 'TELEGRAM') await disconnectTelegram(tenantOf(req));
    else if (channel === 'INSTAGRAM') await disconnectInstagram(tenantOf(req));
    else throw new ValidationError('Unknown channel');
    return { ok: true };
  });

  /** Run a real health check now (spec §27 — never fake "connected"). */
  app.post<{ Params: { channel: string } }>('/api/connections/:channel/health', async (req) => {
    const prisma = getPrisma();
    const channel = req.params.channel.toUpperCase();
    if (channel !== 'TELEGRAM' && channel !== 'INSTAGRAM') throw new ValidationError('Unknown channel');
    const connection = await prisma.channelConnection.findUnique({
      where: { tenantId_channel: { tenantId: tenantOf(req), channel: channel as 'TELEGRAM' | 'INSTAGRAM' } },
    });
    if (!connection) throw new NotFoundError('Not connected');

    const result =
      channel === 'TELEGRAM'
        ? await checkTelegramHealth(connection)
        : await checkInstagramHealth(connection);

    const updated = await prisma.channelConnection.update({
      where: { id: connection.id },
      data: {
        healthStatus: result.status,
        healthDetail: result.detail,
        lastHealthCheckAt: new Date(),
      },
    });
    return { connection: publicConnection(updated) };
  });
}

async function telegramConnectionOf(tenantId: string) {
  const connection = await getPrisma().channelConnection.findUnique({
    where: { tenantId_channel: { tenantId, channel: 'TELEGRAM' } },
  });
  if (!connection || connection.status !== 'connected') {
    throw new NotFoundError('Telegram is not connected');
  }
  return connection;
}

/** Strip secrets before anything leaves the server (spec §17–18). */
function publicConnection(c: {
  id: string;
  channel: string;
  status: string;
  displayName: string;
  externalAccountId: string;
  metadata: unknown;
  healthStatus: string;
  healthDetail: string;
  lastHealthCheckAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: c.id,
    channel: c.channel,
    status: c.status,
    displayName: c.displayName,
    externalAccountId: c.externalAccountId,
    metadata: c.metadata,
    healthStatus: c.healthStatus,
    healthDetail: c.healthDetail,
    lastHealthCheckAt: c.lastHealthCheckAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}
