import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getEnv } from '../config/env.js';
import { ValidationError } from '../lib/errors.js';
import { login, logout, SESSION_COOKIE } from '../modules/auth/service.js';
import { requireAuth } from './middleware.js';

const loginSchema = z.object({
  login: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Login and password are required');
      const { token, user, expiresAt } = await login(parsed.data.login, parsed.data.password);
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: getEnv().NODE_ENV === 'production',
        path: '/',
        expires: expiresAt,
      });
      return { user: { id: user.id, username: user.username, name: user.name, role: user.role } };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await logout(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    const u = req.user!;
    return { user: { id: u.id, username: u.username, name: u.name, role: u.role } };
  });
}
