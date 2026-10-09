import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../db/client.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { requireAdmin, requireAuth, tenantOf } from './middleware.js';

const eventStatusFilter = z.enum([
  'RECEIVED',
  'ENQUEUED',
  'PROCESSING',
  'PROCESSED',
  'SKIPPED',
  'FAILED',
  'DEAD_LETTER',
]);
const channelFilter = z.enum(['INSTAGRAM', 'TELEGRAM']);
const handoffStatusFilter = z.enum(['OPEN', 'RESOLVED']);

function parseFilter<T>(schema: z.ZodType<T>, value: string | undefined, name: string): T | undefined {
  if (!value) return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError(`Invalid ${name} filter`);
  return parsed.data;
}

/**
 * Operations API: logs & observability (spec §26, §32), human handoffs
 * (spec §22), manual actions (spec §28), and overview stats.
 */
export async function opsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // ── Logs ──────────────────────────────────────────────────────────────────
  app.get<{ Querystring: { status?: string; channel?: string; page?: string } }>(
    '/api/logs/webhook-events',
    async (req) => {
      requireAdmin(req);
      const tenantId = tenantOf(req);
      const page = Math.max(1, Number(req.query.page) || 1);
      const where: Record<string, unknown> = { tenantId };
      const status = parseFilter(eventStatusFilter, req.query.status, 'status');
      const channel = parseFilter(channelFilter, req.query.channel, 'channel');
      if (status) where.status = status;
      if (channel) where.channel = channel;
      const events = await getPrisma().webhookEvent.findMany({
        where: where as never,
        orderBy: { receivedAt: 'desc' },
        skip: (page - 1) * 50,
        take: 50,
      });
      return { events };
    },
  );

  app.get<{ Querystring: { page?: string } }>('/api/logs/ai-executions', async (req) => {
    requireAdmin(req);
    const tenantId = tenantOf(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const executions = await getPrisma().aIExecution.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * 50,
      take: 50,
      include: { agent: { select: { name: true, type: true } } },
    });
    return { executions };
  });

  app.get<{ Querystring: { page?: string } }>('/api/logs/tool-executions', async (req) => {
    requireAdmin(req);
    const tenantId = tenantOf(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const executions = await getPrisma().toolExecution.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * 50,
      take: 50,
    });
    return { executions };
  });

  app.get('/api/stats', async (req) => {
    requireAdmin(req);
    const tenantId = tenantOf(req);
    const prisma = getPrisma();
    const dayAgo = new Date(Date.now() - 24 * 3600_000);
    const [leads, openHandoffs, events24h, executions24h, failures24h, avgLatency] =
      await Promise.all([
        prisma.lead.count({ where: { tenantId, mergedIntoId: null } }),
        prisma.humanHandoff.count({ where: { tenantId, status: 'OPEN' } }),
        prisma.webhookEvent.count({ where: { tenantId, receivedAt: { gte: dayAgo } } }),
        prisma.aIExecution.count({ where: { tenantId, createdAt: { gte: dayAgo } } }),
        prisma.aIExecution.count({
          where: { tenantId, createdAt: { gte: dayAgo }, status: 'FAILED' },
        }),
        prisma.aIExecution.aggregate({
          where: { tenantId, createdAt: { gte: dayAgo }, status: 'SUCCEEDED' },
          _avg: { latencyMs: true },
        }),
      ]);
    return {
      stats: {
        leads,
        openHandoffs,
        events24h,
        executions24h,
        failures24h,
        avgLatencyMs: Math.round(avgLatency._avg.latencyMs ?? 0),
      },
    };
  });

  // ── Handoffs ──────────────────────────────────────────────────────────────
  app.get<{ Querystring: { status?: string } }>('/api/handoffs', async (req) => {
    const tenantId = tenantOf(req);
    const status = parseFilter(handoffStatusFilter, req.query.status, 'status');
    const handoffs = await getPrisma().humanHandoff.findMany({
      where: { tenantId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        lead: { select: { id: true, name: true, username: true, status: true } },
        conversation: { select: { id: true, kind: true, channel: true, status: true } },
      },
    });
    return { handoffs };
  });

  app.post<{ Params: { id: string }; Body: { resumeAgent?: boolean } }>(
    '/api/handoffs/:id/resolve',
    async (req) => {
      const tenantId = tenantOf(req);
      const prisma = getPrisma();
      const handoff = await prisma.humanHandoff.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!handoff) throw new NotFoundError('Handoff not found');
      await prisma.humanHandoff.update({
        where: { id: handoff.id },
        data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedByUserId: req.user!.id },
      });
      if (req.body?.resumeAgent !== false) {
        await prisma.conversation.updateMany({
          where: { id: handoff.conversationId, status: 'HANDED_OFF' },
          data: { status: 'ACTIVE', handedOffAt: null },
        });
      }
      return { ok: true };
    },
  );

  // ── Manual actions ────────────────────────────────────────────────────────
  app.get('/api/manual-actions', async (req) => {
    requireAdmin(req);
    const actions = await getPrisma().manualAction.findMany({
      where: { tenantId: tenantOf(req) },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    });
    return { actions };
  });

  app.post<{ Params: { id: string }; Body: { status?: 'DONE' | 'DISMISSED' | 'PENDING' } }>(
    '/api/manual-actions/:id/status',
    async (req) => {
      requireAdmin(req);
      const tenantId = tenantOf(req);
      const status = req.body?.status ?? 'DONE';
      const action = await getPrisma().manualAction.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!action) throw new NotFoundError('Manual action not found');
      await getPrisma().manualAction.update({ where: { id: action.id }, data: { status } });
      return { ok: true };
    },
  );
}
