import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../db/client.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import {
  REGISTRATION_STATUSES,
  changeRegistrationStatus,
  normalizePhone,
} from '../modules/crm/registrations.js';
import { requireAuth, tenantOf } from './middleware.js';

/**
 * Course registrations API.
 *
 * Deliberately open to OPERATOR as well as ADMIN: working this queue — calling
 * applicants, moving them along, leaving notes — is the operator's entire job.
 * Everything here stays inside the caller's tenant, and nothing here exposes
 * agent configuration, credentials or other administration.
 */

const statusEnum = z.enum(REGISTRATION_STATUSES);

const LIST_SELECT = {
  id: true,
  fullName: true,
  phone: true,
  course: true,
  preferredTime: true,
  note: true,
  sourceChannel: true,
  sourceAccount: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  leadId: true,
  conversationId: true,
  assignedToUserId: true,
  assignedTo: { select: { id: true, name: true, username: true } },
} as const;

export async function registrationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get<{
    Querystring: { status?: string; course?: string; source?: string; q?: string; assignee?: string; page?: string };
  }>('/api/registrations', async (req) => {
    const tenantId = tenantOf(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = 25;
    const where: Record<string, unknown> = { tenantId };

    if (req.query.status) {
      const parsed = statusEnum.safeParse(req.query.status);
      if (!parsed.success) throw new ValidationError('Invalid status filter');
      where.status = parsed.data;
    }
    if (req.query.source) {
      const parsed = z.enum(['INSTAGRAM', 'TELEGRAM']).safeParse(req.query.source);
      if (!parsed.success) throw new ValidationError('Invalid source filter');
      where.sourceChannel = parsed.data;
    }
    if (req.query.course) where.course = req.query.course;
    if (req.query.assignee) where.assignedToUserId = req.query.assignee;
    if (req.query.q) {
      where.OR = [
        { fullName: { contains: req.query.q, mode: 'insensitive' } },
        { phone: { contains: req.query.q } },
        { course: { contains: req.query.q, mode: 'insensitive' } },
      ];
    }

    const prisma = getPrisma();
    const [registrations, total, byStatus, courses] = await Promise.all([
      prisma.courseRegistration.findMany({
        where: where as never,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: LIST_SELECT,
      }),
      prisma.courseRegistration.count({ where: where as never }),
      prisma.courseRegistration.groupBy({
        by: ['status'],
        where: { tenantId },
        _count: { _all: true },
      }),
      prisma.courseRegistration.groupBy({
        by: ['course'],
        where: { tenantId },
        _count: { _all: true },
      }),
    ]);

    return {
      registrations,
      total,
      page,
      pageSize,
      summary: {
        byStatus: Object.fromEntries(
          REGISTRATION_STATUSES.map((s) => [
            s,
            byStatus.find((r) => r.status === s)?._count._all ?? 0,
          ]),
        ),
        courses: courses
          .map((c) => ({ course: c.course, count: c._count._all }))
          .sort((a, b) => b.count - a.count),
      },
    };
  });

  app.get<{ Params: { id: string } }>('/api/registrations/:id', async (req) => {
    const registration = await getPrisma().courseRegistration.findFirst({
      where: { id: req.params.id, tenantId: tenantOf(req) },
      include: {
        assignedTo: { select: { id: true, name: true, username: true } },
        events: { orderBy: { createdAt: 'desc' }, take: 50 },
        lead: { select: { id: true, name: true, username: true, status: true } },
        conversation: { select: { id: true, kind: true, channel: true } },
      },
    });
    if (!registration) throw new NotFoundError('Registration not found');
    return { registration };
  });

  const patchSchema = z
    .object({
      status: statusEnum,
      note: z.string().max(2000).nullable(),
      assignedToUserId: z.string().nullable(),
      fullName: z.string().trim().min(1).max(200),
      phone: z.string().trim().min(3).max(50),
      course: z.string().trim().min(1).max(200),
      preferredTime: z.string().max(200).nullable(),
      /** Note attached to a status change, kept in the event trail. */
      statusNote: z.string().max(500).nullable(),
    })
    .partial();

  app.patch<{ Params: { id: string } }>('/api/registrations/:id', async (req) => {
    const tenantId = tenantOf(req);
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid registration update', parsed.error.issues);

    const prisma = getPrisma();
    const existing = await prisma.courseRegistration.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!existing) throw new NotFoundError('Registration not found');

    if (parsed.data.assignedToUserId) {
      const operator = await prisma.user.findFirst({
        where: { id: parsed.data.assignedToUserId, tenantId },
      });
      if (!operator) throw new ValidationError('Assigned operator not found');
    }

    // A phone that cannot be dialled is the one field worth rejecting here:
    // the whole point of this record is that somebody can call the applicant.
    let phone: string | undefined;
    if (parsed.data.phone !== undefined) {
      const normalized = normalizePhone(parsed.data.phone);
      if (!normalized) throw new ValidationError('That does not look like a phone number');
      phone = normalized;
    }

    // The status change goes through the service so it lands in the trail.
    if (parsed.data.status && parsed.data.status !== existing.status) {
      await changeRegistrationStatus({
        tenantId,
        registrationId: existing.id,
        toStatus: parsed.data.status,
        note: parsed.data.statusNote ?? null,
        byUserId: req.user!.id,
      });
    }

    const data = {
      ...(parsed.data.fullName !== undefined ? { fullName: parsed.data.fullName } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(parsed.data.course !== undefined ? { course: parsed.data.course } : {}),
      ...(parsed.data.preferredTime !== undefined ? { preferredTime: parsed.data.preferredTime } : {}),
      ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      ...(parsed.data.assignedToUserId !== undefined
        ? { assignedToUserId: parsed.data.assignedToUserId }
        : {}),
    };

    const registration = Object.keys(data).length
      ? await prisma.courseRegistration.update({
          where: { id: existing.id },
          data,
          select: LIST_SELECT,
        })
      : await prisma.courseRegistration.findUniqueOrThrow({
          where: { id: existing.id },
          select: LIST_SELECT,
        });
    return { registration };
  });

  /** Operators who can be assigned a registration. Names only, no emails. */
  app.get('/api/registrations-assignees', async (req) => {
    const users = await getPrisma().user.findMany({
      where: { tenantId: tenantOf(req) },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, username: true, role: true },
    });
    return { users };
  });
}
