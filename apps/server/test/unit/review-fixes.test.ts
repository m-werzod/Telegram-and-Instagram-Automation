/** Regression tests for defects found in the adversarial code review. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitedError } from '../../src/lib/errors.js';
import { initLogger } from '../../src/lib/logger.js';
import { InlineQueue } from '../../src/queue/inline-queue.js';
import { isTrivialComment } from '../../src/modules/engine/business-rules.js';
import { runAgentPipeline } from '../../src/modules/engine/pipeline.js';
import { makeTestEnv } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';
import { installStubAI } from '../helpers/stub-ai.js';

describe('inline queue honors RateLimitedError.retryAfterMs', () => {
  beforeEach(() => {
    initLogger('silent', false);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits at least retry_after before retrying instead of the 3s base backoff', async () => {
    const queue = new InlineQueue(1);
    let calls = 0;
    queue.registerHandler('webhook:process', async () => {
      calls += 1;
      if (calls === 1) throw new RateLimitedError('flood control', 30_000);
    });
    await queue.start();
    await queue.enqueue('webhook:process', { webhookEventId: 'e1' });
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toBe(1);

    // The old fixed backoff would retry at 3s — inside the flood window.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(10_100);
    expect(calls).toBe(2);
  });
});

describe('isTrivialComment', () => {
  it('treats empty, mention-only, and emoji-only comments as trivial', () => {
    expect(isTrivialComment('')).toBe(true);
    expect(isTrivialComment('   ')).toBe(true);
    expect(isTrivialComment('@brand')).toBe(true);
    expect(isTrivialComment('@brand @other.user')).toBe(true);
    expect(isTrivialComment('🔥🔥🔥')).toBe(true);
    expect(isTrivialComment('👍❤️😍')).toBe(true);
    expect(isTrivialComment('!!! …')).toBe(true);
  });

  it('keeps comments with real content', () => {
    expect(isTrivialComment('How much does this cost?')).toBe(false);
    expect(isTrivialComment('@brand love this! do you ship?')).toBe(false);
    expect(isTrivialComment('narxi qancha')).toBe(false);
    expect(isTrivialComment('сколько стоит? 🔥')).toBe(false);
  });
});

describe('pipeline history excludes the just-persisted current message', () => {
  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
  });

  it('the current inbound text reaches the model exactly once', async () => {
    const prisma = mockPrisma();
    prisma.install();
    const ai = installStubAI();

    const inbound = 'Do you deliver on weekends?';
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conv-1',
      tenantId: 'tenant-1',
      status: 'ACTIVE',
    });
    // Newest-first, as the pipeline queries: the current message is row 0.
    prisma.conversationMessage.findMany.mockResolvedValue([
      { role: 'USER', content: inbound, createdAt: new Date() },
      { role: 'AGENT', content: 'Hello! How can I help?', createdAt: new Date(Date.now() - 60_000) },
      { role: 'USER', content: 'hi', createdAt: new Date(Date.now() - 120_000) },
    ]);
    prisma.conversationMessage.count.mockResolvedValue(0);
    prisma.conversationMessage.findFirst.mockResolvedValue(null);
    prisma.aIExecution.create.mockResolvedValue({ id: 'exec-1' });
    prisma.aIExecution.update.mockResolvedValue({ id: 'exec-1' });

    const outcome = await runAgentPipeline({
      tenantId: 'tenant-1',
      tenantName: 'Test Business',
      agent: {
        id: 'agent-1',
        tenantId: 'tenant-1',
        type: 'TELEGRAM',
        name: 'Agent',
        enabled: true,
        systemInstructions: '',
        businessObjective: '',
        tone: 'friendly',
        language: 'auto',
        provider: 'anthropic',
        model: 'claude-opus-5',
        knowledgeBaseId: null,
        escalationRules: {},
        settings: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never,
      conversationId: 'conv-1',
      lead: null,
      channelKey: 'telegram',
      inboundText: inbound,
      requestId: 'req-1',
    });

    expect(outcome.status).toBe('replied');
    const call = ai.calls[0]!;
    const occurrences = call.messages.filter((m) => m.content.includes(inbound)).length;
    expect(occurrences).toBe(1); // only the <current_user_message> turn
    // History turns survive: 'hi' and the assistant reply are still present.
    expect(call.messages.some((m) => m.role === 'user' && m.content === 'hi')).toBe(true);
    expect(call.messages.some((m) => m.role === 'assistant')).toBe(true);
  });
});
