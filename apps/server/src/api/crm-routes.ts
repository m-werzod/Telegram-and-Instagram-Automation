import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../db/client.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { addNote, findMergeCandidates, mergeLeads } from '../modules/crm/service.js';
import { requireAdmin, requireAuth, tenantOf } from './middleware.js';

/** CRM API (spec §9, §26): leads, conversations, notes, manual merging. */
export async function crmRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  const leadStatusFilter = z.enum(['NEW', 'OPEN', 'QUALIFIED', 'CONVERTED', 'LOST', 'SPAM']);
  const sourceFilter = z.enum(['INSTAGRAM', 'TELEGRAM']);

  app.get<{
    Querystring: { status?: string; source?: string; q?: string; page?: string; pageSize?: string };
  }>('/api/leads', async (req) => {
    const tenantId = tenantOf(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const where: Record<string, unknown> = { tenantId, mergedIntoId: null };
    // Validate enum filters — raw values reaching Prisma throw as 500s.
    if (req.query.status) {
      const parsed = leadStatusFilter.safeParse(req.query.status);
      if (!parsed.success) throw new ValidationError('Invalid status filter');
      where.status = parsed.data;
    }
    if (req.query.source) {
      const parsed = sourceFilter.safeParse(req.query.source);
      if (!parsed.success) throw new ValidationError('Invalid source filter');
      where.source = parsed.data;
    }
    if (req.query.q) {
      where.OR = [
        { name: { contains: req.query.q, mode: 'insensitive' } },
        { username: { contains: req.query.q, mode: 'insensitive' } },
        { phone: { contains: req.query.q } },
        { email: { contains: req.query.q, mode: 'insensitive' } },
      ];
    }
    const prisma = getPrisma();
    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where: where as never,
        orderBy: { lastInteractionAt: { sort: 'desc', nulls: 'last' } },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { identities: true },
      }),
      prisma.lead.count({ where: where as never }),
    ]);
    return { leads, total, page, pageSize };
  });

  /**
   * Per-channel totals for the CRM header. The lead list is paginated, so the
   * channel sections cannot count their own rows without reporting "Instagram:
   * 4" when the page simply happens to hold four of them. Static segment, so
   * find-my-way matches this before /api/leads/:id regardless of order.
   */
  app.get('/api/leads/summary', async (req) => {
    const prisma = getPrisma();
    const tenantId = tenantOf(req);
    const [bySource, byStatus, total] = await Promise.all([
      prisma.lead.groupBy({
        by: ['source'],
        where: { tenantId, mergedIntoId: null },
        _count: { _all: true },
      }),
      prisma.lead.groupBy({
        by: ['status'],
        where: { tenantId, mergedIntoId: null },
        _count: { _all: true },
      }),
      prisma.lead.count({ where: { tenantId, mergedIntoId: null } }),
    ]);
    const countOf = <T extends string>(
      rows: Array<{ _count: { _all: number } } & Record<string, unknown>>,
      key: string,
      value: T,
    ): number => rows.find((r) => r[key] === value)?._count._all ?? 0;

    return {
      summary: {
        total,
        bySource: {
          INSTAGRAM: countOf(bySource, 'source', 'INSTAGRAM'),
          TELEGRAM: countOf(bySource, 'source', 'TELEGRAM'),
        },
        byStatus: Object.fromEntries(
          (['NEW', 'OPEN', 'QUALIFIED', 'CONVERTED', 'LOST', 'SPAM'] as const).map((st) => [
            st,
            countOf(byStatus, 'status', st),
          ]),
        ),
      },
    };
  });

  app.get<{ Params: { id: string } }>('/api/leads/:id', async (req) => {
    const tenantId = tenantOf(req);
    const lead = await getPrisma().lead.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        identities: true,
        conversations: {
          orderBy: { lastMessageAt: 'desc' },
          select: {
            id: true,
            kind: true,
            channel: true,
            status: true,
            lastMessageAt: true,
            externalThreadId: true,
            metadata: true,
          },
        },
        notes: { orderBy: { createdAt: 'desc' }, take: 50 },
        handoffs: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    });
    if (!lead) throw new NotFoundError('Lead not found');
    return { lead };
  });

  const leadPatchSchema = z
    .object({
      name: z.string().max(200).nullable(),
      phone: z.string().max(50).nullable(),
      email: z.string().max(200).nullable(),
      status: z.enum(['NEW', 'OPEN', 'QUALIFIED', 'CONVERTED', 'LOST', 'SPAM']),
      score: z.number().min(0).max(100),
      tags: z.array(z.string().max(50)).max(50),
      assignedToUserId: z.string().nullable(),
      intent: z.string().max(200).nullable(),
    })
    .partial();

  app.patch<{ Params: { id: string } }>('/api/leads/:id', async (req) => {
    const tenantId = tenantOf(req);
    const parsed = leadPatchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid lead fields', parsed.error.issues);
    const prisma = getPrisma();
    const existing = await prisma.lead.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw new NotFoundError('Lead not found');
    if (parsed.data.assignedToUserId) {
      const operator = await prisma.user.findFirst({
        where: { id: parsed.data.assignedToUserId, tenantId },
      });
      if (!operator) throw new ValidationError('Assigned operator not found');
    }
    const lead = await prisma.lead.update({ where: { id: existing.id }, data: parsed.data });
    return { lead };
  });

  app.post<{ Params: { id: string }; Body: { content?: string } }>(
    '/api/leads/:id/notes',
    async (req) => {
      const tenantId = tenantOf(req);
      const content = z.string().min(1).max(4000).safeParse(req.body?.content);
      if (!content.success) throw new ValidationError('Note content is required');
      const lead = await getPrisma().lead.findFirst({ where: { id: req.params.id, tenantId } });
      if (!lead) throw new NotFoundError('Lead not found');
      await addNote(tenantId, lead.id, content.data, { type: 'OPERATOR', userId: req.user!.id });
      return { ok: true };
    },
  );

  app.get<{ Params: { id: string } }>('/api/leads/:id/merge-candidates', async (req) => {
    const candidates = await findMergeCandidates(tenantOf(req), req.params.id);
    return { candidates };
  });

  app.post<{ Params: { id: string }; Body: { sourceLeadId?: string } }>(
    '/api/leads/:id/merge',
    async (req) => {
      const sourceId = z.string().min(1).safeParse(req.body?.sourceLeadId);
      if (!sourceId.success) throw new ValidationError('sourceLeadId is required');
      const lead = await mergeLeads(tenantOf(req), sourceId.data, req.params.id);
      return { lead };
    },
  );

  /**
   * Exclude a conversation from automation, or let it resume.
   *
   * The owner normally does this from inside Telegram by typing /stop in the
   * chat — the supported stand-in for pinning it, since the Bot API cannot
   * report pinned dialogs. This is the same flag from the dashboard, so an
   * exclusion set on a phone is visible and reversible here.
   *
   * Admin-only: it changes what the automation does, which is configuration
   * rather than the CRM work an operator is employed for.
   */
  app.patch<{ Params: { id: string }; Body: { excluded?: boolean } }>(
    '/api/conversations/:id/automation',
    async (req) => {
      requireAdmin(req);
      const tenantId = tenantOf(req);
      const excluded = z.boolean().safeParse(req.body?.excluded);
      if (!excluded.success) throw new ValidationError('excluded must be true or false');

      const conversation = await getPrisma().conversation.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!conversation) throw new NotFoundError('Conversation not found');

      const { setConversationExcluded } = await import(
        '../modules/channels/telegram/exclusions.js'
      );
      await setConversationExcluded({
        tenantId,
        conversationId: conversation.id,
        excluded: excluded.data,
        by: 'dashboard',
      });
      return { ok: true, excluded: excluded.data };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/conversations/:id/messages',
    async (req) => {
      const tenantId = tenantOf(req);
      const prisma = getPrisma();
      const conversation = await prisma.conversation.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!conversation) throw new NotFoundError('Conversation not found');
      const messages = await prisma.conversationMessage.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: 'asc' },
        take: Math.min(500, Number(req.query.limit) || 200),
      });
      return { conversation, messages };
    },
  );
}
