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

describe('agent routes — model catalogue and provider routing', () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(async () => {
    initLogger('silent', false);
    prisma = mockPrisma();
    prisma.install();
    prisma.authSession.findUnique.mockResolvedValue({
      id: 'sess-1',
      expiresAt: new Date(Date.now() + 3_600_000),
      user: {
        id: 'user-1',
        tenantId: 'tenant-1',
        username: 'Admin',
        role: 'ADMIN',
        name: 'Administrator',
      },
    });
    prisma.agent.findFirst.mockResolvedValue({
      id: 'agent-1',
      tenantId: 'tenant-1',
      model: 'claude-sonnet-5',
      provider: 'anthropic',
    });
    prisma.agent.update.mockImplementation(async (args: any) => ({ id: 'agent-1', ...args.data }));
    setQueueForTesting(noopQueue);
    app = await buildApp(makeTestEnv());
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves the model catalogue with both providers and their prices', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agents/models', cookies: COOKIE });
    expect(res.statusCode).toBe(200);

    const models = res.json().models as Array<{ id: string; provider: string }>;
    const ids = models.map((m) => m.id);
    expect(ids).toContain('claude-sonnet-5');
    expect(ids).toContain('gpt-5');
    expect(ids).toContain('gpt-5-mini');
    expect(models.find((m) => m.id === 'gpt-5')?.provider).toBe('openai');
    expect(models.every((m) => typeof (m as any).inputPerMTok === 'number')).toBe(true);
  });

  // The static catalogue route must not be swallowed by /api/agents/:id.
  it('does not resolve the catalogue route as an agent id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agents/models', cookies: COOKIE });
    expect(res.json().models).toBeDefined();
    expect(res.json().agent).toBeUndefined();
  });

  /**
   * The provider is derived from the model, so an operator switching the
   * dropdown to a GPT model cannot leave the agent pointed at Anthropic — the
   * exact mismatch that would 401 on every message.
   */
  it('switches the provider to openai when the model becomes a GPT model', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/agents/agent-1',
      cookies: COOKIE,
      payload: { model: 'gpt-5-mini' },
    });

    expect(res.statusCode).toBe(200);
    const data = prisma.agent.update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data.data.model).toBe('gpt-5-mini');
    expect(data.data.provider).toBe('openai');
  });

  it('switches the provider back to anthropic for a Claude model', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/agents/agent-1',
      cookies: COOKIE,
      payload: { model: 'claude-haiku-4-5' },
    });

    expect(res.statusCode).toBe(200);
    const data = prisma.agent.update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data.data.provider).toBe('anthropic');
  });

  it('leaves the provider untouched when the model is not being changed', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/agents/agent-1',
      cookies: COOKIE,
      payload: { tone: 'samimiy' },
    });

    expect(res.statusCode).toBe(200);
    const data = prisma.agent.update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data.data.provider).toBeUndefined();
  });

  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agents/models' });
    expect(res.statusCode).toBe(401);
  });
});
