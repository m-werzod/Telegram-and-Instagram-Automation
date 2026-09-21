import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/lib/crypto.js';
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

describe('dashboard authentication (login + password)', () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof mockPrisma>;
  let passwordHash: string;

  const adminUser = () => ({
    id: 'user-1',
    tenantId: 'tenant-1',
    username: 'Instagram',
    email: null,
    passwordHash,
    name: 'Administrator',
    role: 'ADMIN',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeEach(async () => {
    initLogger('silent', false);
    passwordHash = await hashPassword('Telegram3737');
    prisma = mockPrisma();
    prisma.install();
    setQueueForTesting(noopQueue);
    app = await buildApp(makeTestEnv());
  });

  afterEach(async () => {
    await app.close();
  });

  it('signs in with the correct login + password and sets the session cookie', async () => {
    prisma.user.findUnique.mockResolvedValue(adminUser());
    prisma.authSession.create.mockResolvedValue({ id: 'sess-1' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'Instagram', password: 'Telegram3737' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ username: 'Instagram', role: 'ADMIN' });
    const cookie = res.headers['set-cookie'];
    expect(String(cookie)).toContain('sid=');
    expect(String(cookie)).toContain('HttpOnly');
    // Lookup is by username, not email.
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { username: 'Instagram' } });
  });

  it('rejects a wrong password with the uniform error', async () => {
    prisma.user.findUnique.mockResolvedValue(adminUser());
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'Instagram', password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Invalid login or password');
  });

  it('rejects an unknown login with the same uniform error (no enumeration)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'nobody', password: 'whatever-123' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Invalid login or password');
  });

  it('rejects missing fields with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'Instagram' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/auth/me without a session returns 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });
});
