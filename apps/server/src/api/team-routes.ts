import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../db/client.js';
import { hashPassword } from '../lib/crypto.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { createUser } from '../modules/auth/service.js';
import { requireAdmin, requireAuth, tenantOf } from './middleware.js';

/**
 * Team and business identity — what a handover needs.
 *
 * The platform was built for one operator who was seeded into the database.
 * Giving it to the business owner it actually serves requires three things
 * that had no interface at all: create their account, let them (or you) change
 * a password, and remove the installer's own account afterwards. Plus renaming
 * the business, because the tenant name is not cosmetic — it is injected into
 * every agent's system prompt and printed on the public privacy and data
 * deletion pages.
 *
 * Everything here is tenant-scoped and ADMIN-only, and the guards below make
 * the destructive version of a handover impossible: the last administrator
 * cannot be deleted or demoted, and nobody can delete themselves. Locking
 * everyone out of a running automation would be unrecoverable from the UI.
 */

const createSchema = z.object({
  username: z.string().trim().min(3).max(50).regex(/^[A-Za-z0-9._-]+$/, {
    message: 'Username may contain only letters, digits, dot, underscore and hyphen',
  }),
  name: z.string().trim().min(1).max(120),
  email: z.string().email().optional().or(z.literal('')),
  password: z.string().min(8).max(200),
  role: z.enum(['ADMIN', 'OPERATOR']),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().email().or(z.literal('')),
    password: z.string().min(8).max(200),
    role: z.enum(['ADMIN', 'OPERATOR']),
  })
  .partial();

const PUBLIC_USER = {
  id: true,
  username: true,
  name: true,
  email: true,
  role: true,
  createdAt: true,
} as const;

export async function teamRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/users', async (req) => {
    requireAdmin(req);
    const users = await getPrisma().user.findMany({
      where: { tenantId: tenantOf(req) },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      select: PUBLIC_USER,
    });
    return { users };
  });

  app.post('/api/users', async (req, reply) => {
    requireAdmin(req);
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid user', parsed.error.issues);

    const prisma = getPrisma();
    const taken = await prisma.user.findUnique({ where: { username: parsed.data.username } });
    if (taken) throw new ValidationError('That username is already taken');

    const user = await createUser({
      tenantId: tenantOf(req),
      username: parsed.data.username,
      name: parsed.data.name,
      email: parsed.data.email || undefined,
      password: parsed.data.password,
      role: parsed.data.role,
    });
    await audit(req, 'user.create', user.id);
    return reply.code(201).send({
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
      },
    });
  });

  app.patch<{ Params: { id: string } }>('/api/users/:id', async (req) => {
    requireAdmin(req);
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid update', parsed.error.issues);

    const prisma = getPrisma();
    const tenantId = tenantOf(req);
    const target = await prisma.user.findFirst({ where: { id: req.params.id, tenantId } });
    if (!target) throw new NotFoundError('User not found');

    // Demoting the only administrator would lock the business out of its own
    // settings, agents and connections with no way back through the UI.
    if (parsed.data.role === 'OPERATOR' && target.role === 'ADMIN') {
      await assertNotLastAdmin(tenantId, target.id, 'demote');
    }

    const user = await prisma.user.update({
      where: { id: target.id },
      data: {
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.email !== undefined ? { email: parsed.data.email || null } : {}),
        ...(parsed.data.role ? { role: parsed.data.role } : {}),
        ...(parsed.data.password ? { passwordHash: await hashPassword(parsed.data.password) } : {}),
      },
      select: PUBLIC_USER,
    });

    // A changed password must end that person's other sessions, or the old
    // credential keeps working everywhere it is already signed in.
    if (parsed.data.password) {
      await prisma.authSession.deleteMany({ where: { userId: target.id } });
    }
    await audit(req, 'user.update', target.id);
    return { user };
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id', async (req) => {
    requireAdmin(req);
    const prisma = getPrisma();
    const tenantId = tenantOf(req);
    const target = await prisma.user.findFirst({ where: { id: req.params.id, tenantId } });
    if (!target) throw new NotFoundError('User not found');

    // Deleting yourself mid-session is how an installer locks themselves out
    // before confirming the new owner can actually sign in. Hand over first,
    // then have the new administrator remove the old account.
    if (target.id === req.user!.id) {
      throw new ValidationError(
        'You cannot delete your own account. Sign in as the new administrator and remove this one from there.',
      );
    }
    if (target.role === 'ADMIN') await assertNotLastAdmin(tenantId, target.id, 'delete');

    await prisma.user.delete({ where: { id: target.id } });
    await audit(req, 'user.delete', target.id);
    return { ok: true };
  });

  /**
   * The business name. Not cosmetic: it is injected into every agent's system
   * prompt ("you represent X") and rendered on the public privacy and data
   * deletion pages, so a handover that leaves the old name in place puts the
   * wrong company on documents Meta reviewers read.
   */
  app.get('/api/business', async (req) => {
    const tenant = await getPrisma().tenant.findUnique({
      where: { id: tenantOf(req) },
      select: { id: true, name: true, slug: true },
    });
    if (!tenant) throw new NotFoundError('Business not found');
    return { business: tenant };
  });

  app.patch('/api/business', async (req) => {
    requireAdmin(req);
    const parsed = z
      .object({ name: z.string().trim().min(1).max(120) })
      .safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError('A business name is required');

    const business = await getPrisma().tenant.update({
      where: { id: tenantOf(req) },
      data: { name: parsed.data.name },
      select: { id: true, name: true, slug: true },
    });
    await audit(req, 'business.rename', business.id);
    return { business };
  });
}

async function assertNotLastAdmin(
  tenantId: string,
  excludingUserId: string,
  action: 'delete' | 'demote',
): Promise<void> {
  const others = await getPrisma().user.count({
    where: { tenantId, role: 'ADMIN', id: { not: excludingUserId } },
  });
  if (others === 0) {
    throw new ValidationError(
      `Cannot ${action} the last administrator — the business would lose access to its own settings. Create another administrator first.`,
    );
  }
}

async function audit(
  req: { tenantId?: string; user?: { id: string } },
  action: string,
  resourceId: string,
): Promise<void> {
  await getPrisma()
    .auditLog.create({
      data: {
        tenantId: req.tenantId!,
        userId: req.user?.id ?? null,
        action,
        resource: 'user',
        resourceId,
      },
    })
    .catch(() => undefined);
}
