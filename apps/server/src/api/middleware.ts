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

/**
 * Admin-only for an entire route group, as a hook.
 *
 * `requireAdmin(req)` called by hand inside each handler was the previous
 * pattern, and it failed the way per-handler checks always eventually do:
 * agent configuration, the knowledge base and the execution logs had none at
 * all, so an OPERATOR could rewrite an agent's system instructions or delete a
 * knowledge base through the API even though the dashboard never showed them
 * the page. A group-level hook cannot be forgotten when a route is added.
 *
 * Register AFTER requireAuth so req.user is populated:
 *   app.addHook('preHandler', requireAuth);
 *   app.addHook('preHandler', adminOnly);
 */
export async function adminOnly(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  requireAdmin(req);
}

/**
 * Admin-only for writes; any signed-in user may read. For groups an operator
 * legitimately needs to see but must never change.
 */
export async function adminOnlyWrites(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') requireAdmin(req);
}

export function tenantOf(req: FastifyRequest): string {
  if (!req.tenantId) throw new AuthError();
  return req.tenantId;
}
