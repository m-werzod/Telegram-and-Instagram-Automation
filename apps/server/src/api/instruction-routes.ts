import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../db/client.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { adminOnly, requireAuth, tenantOf } from './middleware.js';

/**
 * "Qo'shimcha AI ko'rsatmalari" — the owner's own situational rules.
 *
 * Administration, not CRM work: a rule here changes what every agent does, so
 * it sits behind the same guard as agent configuration.
 */

const AGENT_TYPES = ['INSTAGRAM_COMMENT', 'INSTAGRAM_DM', 'TELEGRAM', 'TELEGRAM_PERSONAL'] as const;

/**
 * Long enough for a real rule, short enough that the list cannot quietly grow
 * into a second system prompt that nobody reviews.
 */
const MAX_LENGTH = 500;
const MAX_INSTRUCTIONS = 50;

const bodySchema = z.object({
  text: z.string().trim().min(3).max(MAX_LENGTH),
  enabled: z.boolean().optional(),
  appliesTo: z.enum(AGENT_TYPES).nullable().optional(),
});

const patchSchema = bodySchema.partial();

const SELECT = {
  id: true,
  text: true,
  enabled: true,
  appliesTo: true,
  position: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function instructionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', adminOnly);

  app.get('/api/owner-instructions', async (req) => {
    const instructions = await getPrisma().ownerInstruction.findMany({
      where: { tenantId: tenantOf(req) },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: SELECT,
    });
    return { instructions, limits: { maxLength: MAX_LENGTH, maxInstructions: MAX_INSTRUCTIONS } };
  });

  app.post('/api/owner-instructions', async (req, reply) => {
    const tenantId = tenantOf(req);
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError(
        `Ko'rsatma 3–${MAX_LENGTH} belgi orasida bo'lishi kerak`,
        parsed.error.issues,
      );
    }
    const prisma = getPrisma();
    const count = await prisma.ownerInstruction.count({ where: { tenantId } });
    if (count >= MAX_INSTRUCTIONS) {
      throw new ValidationError(
        `Eng ko'pi bilan ${MAX_INSTRUCTIONS} ta ko'rsatma. Keraksizlarini o'chiring yoki birlashtiring.`,
      );
    }

    const instruction = await prisma.ownerInstruction.create({
      data: {
        tenantId,
        text: parsed.data.text,
        enabled: parsed.data.enabled ?? true,
        appliesTo: parsed.data.appliesTo ?? null,
        position: count,
      },
      select: SELECT,
    });
    return reply.code(201).send({ instruction });
  });

  app.patch<{ Params: { id: string } }>('/api/owner-instructions/:id', async (req) => {
    const tenantId = tenantOf(req);
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid instruction', parsed.error.issues);

    const prisma = getPrisma();
    const existing = await prisma.ownerInstruction.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw new NotFoundError('Instruction not found');

    const instruction = await prisma.ownerInstruction.update({
      where: { id: existing.id },
      data: {
        ...(parsed.data.text !== undefined ? { text: parsed.data.text } : {}),
        ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
        ...(parsed.data.appliesTo !== undefined ? { appliesTo: parsed.data.appliesTo } : {}),
      },
      select: SELECT,
    });
    return { instruction };
  });

  app.delete<{ Params: { id: string } }>('/api/owner-instructions/:id', async (req) => {
    const tenantId = tenantOf(req);
    const prisma = getPrisma();
    const existing = await prisma.ownerInstruction.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw new NotFoundError('Instruction not found');
    await prisma.ownerInstruction.delete({ where: { id: existing.id } });
    return { ok: true };
  });
}
