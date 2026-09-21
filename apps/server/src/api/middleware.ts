import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@prisma/client';
import { AuthError } from '../lib/errors.js';
import { getSessionUser, SESSION_COOKIE } from '../modules/auth/service.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    tenantId?: string;
  }
}

/**
 * Session auth + tenant scoping. Every authenticated request carries the
 * user's tenantId; all queries in route handlers MUST filter by it (spec §36).
 */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) throw new AuthError();
  const user = await getSessionUser(token);
  if (!user) throw new AuthError('Session expired');
  req.user = user;
  req.tenantId = user.tenantId;
}

export function requireAdmin(req: FastifyRequest): void {
  if (req.user?.role !== 'ADMIN') {
    throw new AuthError('Admin role required');
  }
}

export function tenantOf(req: FastifyRequest): string {
  if (!req.tenantId) throw new AuthError();
  return req.tenantId;
}
