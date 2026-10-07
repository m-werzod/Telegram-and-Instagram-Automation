/**
 * Handing the platform to the business it serves: create the owner's account,
 * rename the business, remove the installer. The guards matter more than the
 * happy path — a handover that locks everyone out of a running automation
 * cannot be undone from the UI.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { initLogger } from '../../src/lib/logger.js';
import { makeTestEnv } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';
import { setQueueForTesting, type JobQueue } from '../../src/queue/index.js';

const noopQueue: JobQueue = {
  enqueue: async () => undefined,
  registerHandler: () => undefined,
  start: async () => undefined,
  stop: async () => undefined,
};

const COOKIE = { sid: 'session-token' };
const ME = { id: 'user-1', tenantId: 'tenant-1', username: 'Admin', role: 'ADMIN', name: 'Installer' };

describe('team + business routes (client handover)', () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(async () => {
    initLogger('silent', false);
    prisma = mockPrisma();
    prisma.install();
    prisma.authSession.findUnique.mockResolvedValue({
      id: 'sess-1',
      expiresAt: new Date(Date.now() + 3_600_000),
      user: ME,
    });
    prisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });
    setQueueForTesting(noopQueue);
    app = await buildApp(makeTestEnv());
  });
  afterEach(async () => app.close());

  it('creates the business owner as an administrator', async () => {
    prisma.user.findUnique.mockResolvedValue(null); // username free
    prisma.user.create.mockResolvedValue({
      id: 'user-2',
      username: 'turon',
      name: 'Turon Owner',
      email: null,
      role: 'ADMIN',
      createdAt: new Date(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      cookies: COOKIE,
      payload: { username: 'turon', name: 'Turon Owner', password: 'a-strong-password', role: 'ADMIN' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().user.role).toBe('ADMIN');
    // The password must never be stored as given.
    const created = prisma.user.create.mock.calls[0]![0] as { data: { passwordHash: string } };
    expect(created.data.passwordHash).not.toContain('a-strong-password');
  });

  it('refuses a username that is already taken', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'other', username: 'turon' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      cookies: COOKIE,
      payload: { username: 'turon', name: 'X', password: 'a-strong-password', role: 'ADMIN' },
    });
    expect(res.statusCode).toBe(400);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('refuses a password shorter than 8 characters', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      cookies: COOKIE,
      payload: { username: 'turon', name: 'X', password: 'short', role: 'ADMIN' },
    });
    expect(res.statusCode).toBe(400);
  });

  // The failure this prevents: the installer deletes their own account before
  // confirming the new owner can sign in, and nobody can get back in.
  it('refuses to let an admin delete their own account', async () => {
    prisma.user.findFirst.mockResolvedValue({ ...ME });
    const res = await app.inject({ method: 'DELETE', url: '/api/users/user-1', cookies: COOKIE });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('cannot delete your own account');
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('refuses to delete the last administrator', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'user-9', tenantId: 'tenant-1', role: 'ADMIN' });
    prisma.user.count.mockResolvedValue(0); // no other admins

    const res = await app.inject({ method: 'DELETE', url: '/api/users/user-9', cookies: COOKIE });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('last administrator');
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('deletes the installer once another administrator exists', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'user-9', tenantId: 'tenant-1', role: 'ADMIN' });
    prisma.user.count.mockResolvedValue(1); // the new owner
    prisma.user.delete.mockResolvedValue({ id: 'user-9' });

    const res = await app.inject({ method: 'DELETE', url: '/api/users/user-9', cookies: COOKIE });
    expect(res.statusCode).toBe(200);
    expect(prisma.user.delete).toHaveBeenCalled();
  });

  it('refuses to demote the last administrator', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'user-9', tenantId: 'tenant-1', role: 'ADMIN' });
    prisma.user.count.mockResolvedValue(0);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/user-9',
      cookies: COOKIE,
      payload: { role: 'OPERATOR' },
    });
    expect(res.statusCode).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  // A changed password that leaves old sessions alive is not a changed password.
  it('ends the target user’s sessions when their password is changed', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'user-9', tenantId: 'tenant-1', role: 'OPERATOR' });
    prisma.user.update.mockResolvedValue({ id: 'user-9', username: 'x', name: 'X', email: null, role: 'OPERATOR', createdAt: new Date() });
    prisma.authSession.deleteMany.mockResolvedValue({ count: 2 });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/user-9',
      cookies: COOKIE,
      payload: { password: 'another-strong-password' },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.authSession.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-9' } });
  });

  it('never returns password hashes in the user list', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 'user-1', username: 'Admin', name: 'Installer', email: null, role: 'ADMIN', createdAt: new Date() },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/users', cookies: COOKIE });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('passwordHash');
    const select = prisma.user.findMany.mock.calls[0]![0] as { select: Record<string, boolean> };
    expect(select.select.passwordHash).toBeUndefined();
  });

  it('renames the business (it is injected into every prompt and legal page)', async () => {
    prisma.tenant.update.mockResolvedValue({ id: 'tenant-1', name: 'Yangi Biznes', slug: 'turon' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/business',
      cookies: COOKIE,
      payload: { name: 'Yangi Biznes' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().business.name).toBe('Yangi Biznes');
  });

  // The app answers AuthError with 401 everywhere (settings, connections);
  // kept consistent here rather than introducing a second convention.
  it('rejects a non-admin session on every mutation', async () => {
    prisma.authSession.findUnique.mockResolvedValue({
      id: 'sess-2',
      expiresAt: new Date(Date.now() + 3_600_000),
      user: { ...ME, id: 'user-op', role: 'OPERATOR' },
    });
    for (const [method, url] of [
      ['GET', '/api/users'],
      ['POST', '/api/users'],
      ['PATCH', '/api/business'],
    ] as const) {
      const res = await app.inject({ method, url, cookies: COOKIE, payload: {} });
      expect(res.statusCode).toBe(401);
    }
  });
});
