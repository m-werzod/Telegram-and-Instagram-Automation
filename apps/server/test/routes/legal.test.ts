/**
 * Meta will not let an app go Live without a privacy policy URL and either a
 * data deletion callback or a deletion instructions URL. These pages are the
 * ones pasted into App Dashboard → Settings → Basic, so they must be publicly
 * reachable with no session and must render real content, not the SPA shell.
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

describe('public legal pages (Meta App Review prerequisites)', () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(async () => {
    initLogger('silent', false);
    prisma = mockPrisma();
    prisma.install();
    prisma.tenant.findFirst.mockResolvedValue({ id: 't1', name: 'Turon Avtomaktab' });
    prisma.agent.findMany.mockResolvedValue([]);
    setQueueForTesting(noopQueue);
    app = await buildApp(makeTestEnv());
  });
  afterEach(async () => app.close());

  it('serves the privacy policy with no authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/privacy' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Privacy Policy');
    expect(res.body).toContain('Turon Avtomaktab');
  });

  it('discloses the AI provider as a processor — the disclosure Meta checks for', async () => {
    const res = await app.inject({ method: 'GET', url: '/privacy' });
    expect(res.body).toMatch(/OpenAI or Anthropic/);
    expect(res.body).toMatch(/not used to train their models/);
  });

  it('serves data deletion instructions with no authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/data-deletion' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('How to delete your data');
    expect(res.body).toMatch(/within <strong>30 days<\/strong>/);
  });

  // The pages carry a real contact only when an operator configured one —
  // inventing a phone number on a legal page would be worse than omitting it.
  it('uses the operator-configured contact when one exists', async () => {
    prisma.agent.findMany.mockResolvedValue([{ settings: { contactFallback: '+998 55 252 37 37' } }]);
    const res = await app.inject({ method: 'GET', url: '/privacy' });
    expect(res.body).toContain('+998 55 252 37 37');
  });

  it('never invents a contact when none is configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/data-deletion' });
    expect(res.body).not.toMatch(/\+\d[\d\s]{6,}/);
    expect(res.body).toContain('ask for a human');
  });
});
