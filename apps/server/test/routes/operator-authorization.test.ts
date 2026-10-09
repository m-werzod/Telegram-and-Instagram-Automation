/**
 * What an OPERATOR may and may not reach.
 *
 * This exists because the split used to be enforced only by hiding pages in
 * the dashboard. The API had no guard at all on agent configuration, the
 * knowledge base or the execution logs, so an operator could rewrite an
 * agent's system instructions or delete a knowledge base with a single
 * request — the dashboard simply never showed them the button.
 *
 * Both halves are asserted: the operator is refused everywhere they should
 * be, and the administrator is still allowed, because a lockdown that also
 * breaks the owner is not a fix.
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

/** Everything an operator must never reach, as [method, url]. */
const FORBIDDEN = [
  ['GET', '/api/agents'],
  ['GET', '/api/agents/agent-1'],
  ['PATCH', '/api/agents/agent-1'],
  ['GET', '/api/knowledge-bases'],
  ['POST', '/api/knowledge-bases'],
  ['DELETE', '/api/knowledge-bases/kb-1'],
  ['GET', '/api/owner-instructions'],
  ['POST', '/api/owner-instructions'],
  ['DELETE', '/api/owner-instructions/i-1'],
  ['GET', '/api/users'],
  ['POST', '/api/users'],
  ['PATCH', '/api/business'],
  ['GET', '/api/settings'],
  ['GET', '/api/logs/ai-executions'],
  ['GET', '/api/logs/tool-executions'],
  ['GET', '/api/logs/webhook-events'],
  ['GET', '/api/stats'],
  ['GET', '/api/manual-actions'],
  ['GET', '/api/telegram-personal-accounts'],
  ['PATCH', '/api/telegram-personal-accounts/acc-1'],
  ['POST', '/api/connections/telegram'],
  ['POST', '/api/connections/instagram'],
  ['DELETE', '/api/connections/telegram'],
] as const;

/** The CRM work an operator is employed to do. */
const ALLOWED = [
  ['GET', '/api/leads'],
  ['GET', '/api/registrations'],
  ['GET', '/api/registrations-assignees'],
  ['GET', '/api/handoffs'],
] as const;

describe('operator authorization', () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof mockPrisma>;

  const signInAs = (role: 'ADMIN' | 'OPERATOR') => {
    prisma.authSession.findUnique.mockResolvedValue({
      id: 'sess-1',
      expiresAt: new Date(Date.now() + 3_600_000),
      user: { id: 'u-1', tenantId: 'tenant-1', username: 'x', role, name: 'X' },
    });
  };

  beforeEach(async () => {
    initLogger('silent', false);
    prisma = mockPrisma();
    prisma.install();
    prisma.auditLog.create.mockResolvedValue({ id: 'a-1' });
    setQueueForTesting(noopQueue);
    app = await buildApp(makeTestEnv());
  });
  afterEach(async () => app.close());

  it.each(FORBIDDEN)('refuses an operator: %s %s', async (method, url) => {
    signInAs('OPERATOR');
    const res = await app.inject({ method, url, cookies: COOKIE, payload: {} });
    // The app answers AuthError with 401 by convention everywhere else.
    expect(res.statusCode).toBe(401);
  });

  it.each(ALLOWED)('allows an operator: %s %s', async (method, url) => {
    signInAs('OPERATOR');
    const res = await app.inject({ method, url, cookies: COOKIE });
    expect(res.statusCode).toBe(200);
  });

  it('still lets an administrator read agent configuration', async () => {
    signInAs('ADMIN');
    prisma.agent.findMany.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: '/api/agents', cookies: COOKIE });
    expect(res.statusCode).toBe(200);
  });

  it('still lets an administrator manage owner instructions', async () => {
    signInAs('ADMIN');
    prisma.ownerInstruction.findMany.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: '/api/owner-instructions', cookies: COOKIE });
    expect(res.statusCode).toBe(200);
  });

  // The classic escalation: ask to be an admin while being an operator.
  it('does not let an operator grant themselves the admin role', async () => {
    signInAs('OPERATOR');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/u-1',
      cookies: COOKIE,
      payload: { role: 'ADMIN' },
    });
    expect(res.statusCode).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  // An operator working another company's registrations would be worse than
  // one reading an admin page.
  it('scopes an operator’s registration list to their own tenant', async () => {
    signInAs('OPERATOR');
    prisma.courseRegistration.findMany.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: '/api/registrations', cookies: COOKIE });

    expect(res.statusCode).toBe(200);
    const where = (prisma.courseRegistration.findMany.mock.calls[0]![0] as { where: { tenantId: string } })
      .where;
    expect(where.tenantId).toBe('tenant-1');
  });

  it('refuses everything without a session', async () => {
    prisma.authSession.findUnique.mockResolvedValue(null);
    for (const url of ['/api/registrations', '/api/agents', '/api/owner-instructions']) {
      const res = await app.inject({ method: 'GET', url, cookies: COOKIE });
      expect(res.statusCode).toBe(401);
    }
  });
});
