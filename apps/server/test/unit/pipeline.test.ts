import { beforeEach, describe, expect, it } from 'vitest';
import type { Agent, Lead } from '@prisma/client';
import { guardStatusTransition, runAgentPipeline } from '../../src/modules/engine/pipeline.js';
import { makeTestEnv } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';
import { installStubAI, type StubAIProvider } from '../helpers/stub-ai.js';
import { setAIForTesting } from '../../src/modules/ai/index.js';
import { initLogger } from '../../src/lib/logger.js';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    tenantId: 'tenant-1',
    type: 'TELEGRAM',
    name: 'Test Agent',
    enabled: true,
    systemInstructions: 'Be helpful.',
    businessObjective: 'Qualify leads',
    tone: 'friendly',
    language: 'auto',
    provider: 'anthropic',
    model: 'claude-opus-5',
    knowledgeBaseId: null,
    escalationRules: {},
    settings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Agent;
}

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1',
    tenantId: 'tenant-1',
    source: 'TELEGRAM',
    name: null,
    username: 'testuser',
    phone: null,
    email: null,
    language: null,
    intent: null,
    status: 'NEW',
    score: 0,
    tags: [],
    assignedToUserId: null,
    qualification: {},
    mergedIntoId: null,
    lastInteractionAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Lead;
}

describe('runAgentPipeline', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let ai: StubAIProvider;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
    ai = installStubAI();

    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conv-1',
      tenantId: 'tenant-1',
      status: 'ACTIVE',
    });
    prisma.conversationMessage.findMany.mockResolvedValue([]);
    prisma.conversationMessage.count.mockResolvedValue(0);
    prisma.conversationMessage.findFirst.mockResolvedValue(null);
    prisma.aIExecution.create.mockResolvedValue({ id: 'exec-1' });
    prisma.aIExecution.update.mockResolvedValue({ id: 'exec-1' });
    prisma.toolExecution.create.mockResolvedValue({ id: 'tool-1' });
    prisma.toolExecution.update.mockResolvedValue({ id: 'tool-1' });
    prisma.lead.findFirst.mockResolvedValue(makeLead());
    prisma.lead.update.mockResolvedValue(makeLead());
  });

  const baseInput = () => ({
    tenantId: 'tenant-1',
    tenantName: 'Test Business',
    agent: makeAgent(),
    conversationId: 'conv-1',
    lead: makeLead(),
    channelKey: 'telegram' as const,
    inboundText: 'How much does delivery cost?',
    requestId: 'req-1',
  });

  it('DISABLED agent never generates or replies (backend enforcement, spec §5)', async () => {
    const outcome = await runAgentPipeline({ ...baseInput(), agent: makeAgent({ enabled: false }) });
    expect(outcome.status).toBe('skipped');
    expect(ai.calls).toHaveLength(0);
    expect(prisma.aIExecution.create).not.toHaveBeenCalled();
  });

  it('handed-off conversations stay silent (spec §22)', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conv-1',
      tenantId: 'tenant-1',
      status: 'HANDED_OFF',
    });
    const outcome = await runAgentPipeline(baseInput());
    expect(outcome.status).toBe('skipped');
    expect(ai.calls).toHaveLength(0);
  });

  it('happy path: generates, validates, applies rules, returns a sendable reply', async () => {
    ai.respondWith({ reply: 'Delivery costs $5.', intent: 'price_inquiry', leadScore: 40 });
    const outcome = await runAgentPipeline(baseInput());
    expect(outcome.status).toBe('replied');
    expect(outcome.verdict?.reply).toBe('Delivery costs $5.');
    // AI execution was logged with the decision.
    expect(prisma.aIExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCEEDED' }) }),
    );
    // Lead update tool ran (intent + score).
    expect(prisma.toolExecution.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'updateLead' }) }),
    );
  });

  // Thinking is on by default on every current Claude model and shares this
  // budget with the JSON decision, so a tight ceiling truncates the object
  // mid-write and the reply is lost. Pin the headroom.
  it('asks for enough output budget that a thinking model cannot truncate the decision', async () => {
    ai.respondWith({ reply: 'ok', intent: 'question' });
    await runAgentPipeline(baseInput());
    expect(ai.calls[0]?.maxTokens ?? 0).toBeGreaterThanOrEqual(8192);
  });

  it('spam is silently suppressed', async () => {
    ai.respondWith({ reply: 'should not be sent', isSpamOrIrrelevant: true, intent: 'spam' });
    const outcome = await runAgentPipeline(baseInput());
    expect(outcome.status).toBe('silent');
    expect(outcome.verdict?.suppressedReason).toBe('spam_or_irrelevant');
    expect(outcome.verdict?.reply).toBeNull();
  });

  it('escalation creates a handoff, and hands the conversation over when it stayed silent', async () => {
    // Silent + escalated is the real handover shape: nobody answered the
    // customer, so a human must. (A turn that DID reply is covered below —
    // that one must NOT pause, or the conversation dies after one flag.)
    ai.respondWith({
      reply: null,
      shouldEscalate: true,
      escalationReason: 'customer asked for a human',
    });
    prisma.humanHandoff.findFirst.mockResolvedValue(null);
    prisma.humanHandoff.create.mockResolvedValue({ id: 'handoff-1' });

    const outcome = await runAgentPipeline(baseInput());
    expect(outcome.escalated).toBe(true);
    expect(prisma.humanHandoff.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'customer asked for a human' }),
      }),
    );
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'HANDED_OFF' }) }),
    );
  });

  /**
   * The bug this pins killed real conversations: the agent answered AND flagged
   * a follow-up, the flag paused the conversation, and every later customer
   * message was then skipped forever. A turn we replied to is not a handover.
   */
  it('does NOT pause the conversation when it escalated but still replied', async () => {
    ai.respondWith({ reply: 'Men buni aniqlashtirib, javob beraman.', shouldEscalate: true, escalationReason: 'fact not in knowledge base' });
    const outcome = await runAgentPipeline(baseInput());

    expect(outcome.status).toBe('replied');
    expect(outcome.escalated).toBe(true);
    const call = prisma.toolExecution.create.mock.calls.find((c) =>
      JSON.stringify((c[0] as { data: unknown }).data).includes('escalateToHuman'),
    );
    expect(JSON.stringify((call![0] as { data: unknown }).data)).toContain('"pauseAgent":false');
  });

  it('DOES pause when it escalated without replying — a real human handover', async () => {
    ai.respondWith({ reply: null, shouldEscalate: true, escalationReason: 'customer asked for a human' });
    const outcome = await runAgentPipeline(baseInput());

    expect(outcome.status).toBe('silent');
    const call = prisma.toolExecution.create.mock.calls.find((c) =>
      JSON.stringify((c[0] as { data: unknown }).data).includes('escalateToHuman'),
    );
    expect(JSON.stringify((call![0] as { data: unknown }).data)).toContain('"pauseAgent":true');
  });

  // 12-32 s of silence on a chat channel reads as "nobody is there".
  it('asks the provider for the low reasoning tier so replies are not 20s late', async () => {
    await runAgentPipeline(baseInput());
    expect(ai.calls[0]!.effort).toBe('low');
  });

  it('banned phrases block the reply and force escalation', async () => {
    ai.respondWith({ reply: 'We guarantee a full refund always!' });
    prisma.humanHandoff.findFirst.mockResolvedValue(null);
    prisma.humanHandoff.create.mockResolvedValue({ id: 'handoff-2' });

    const outcome = await runAgentPipeline({
      ...baseInput(),
      agent: makeAgent({ settings: { bannedPhrases: ['guarantee'] } as never }),
    });
    expect(outcome.status).toBe('silent');
    expect(outcome.verdict?.suppressedReason).toBe('banned_phrase');
    expect(outcome.escalated).toBe(true);
  });

  it('AI safety refusal escalates instead of replying', async () => {
    ai.refuseNext = true;
    prisma.humanHandoff.findFirst.mockResolvedValue(null);
    prisma.humanHandoff.create.mockResolvedValue({ id: 'handoff-3' });
    const outcome = await runAgentPipeline(baseInput());
    expect(outcome.status).toBe('silent');
    expect(outcome.escalated).toBe(true);
  });

  it('no AI key configured at all fails cleanly without throwing', async () => {
    setAIForTesting({ providers: {}, embeddings: null });
    const outcome = await runAgentPipeline(baseInput());
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('No AI API key');
  });

  // The failure this prevents: an operator buys ONE key, the agents are set to
  // the other vendor's model, and every inbound message 401s — which from the
  // customer's side is indistinguishable from the bot being switched off.
  it('falls back to the provider that HAS a key rather than failing every message', async () => {
    const outcome = await runAgentPipeline({
      ...baseInput(),
      agent: makeAgent({ model: 'gpt-5', provider: 'openai' }),
    });

    expect(outcome.status).toBe('replied');
    expect(ai.calls).toHaveLength(1);
    // Same capability tier on the provider that is actually configured.
    expect(ai.calls[0]!.model).toBe('claude-opus-5');
    // The substitution is recorded, never hidden: the execution log shows the
    // model that really ran.
    expect(prisma.aIExecution.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ model: 'claude-opus-5' }) }),
    );
  });
});

describe('guardStatusTransition', () => {
  it('never downgrades QUALIFIED or touches CONVERTED', () => {
    expect(guardStatusTransition('QUALIFIED', 'OPEN')).toBeNull();
    expect(guardStatusTransition('QUALIFIED', 'SPAM')).toBeNull();
    expect(guardStatusTransition('CONVERTED', 'LOST')).toBeNull();
    expect(guardStatusTransition('NEW', 'QUALIFIED')).toBe('QUALIFIED');
    expect(guardStatusTransition('OPEN', 'LOST')).toBe('LOST');
    expect(guardStatusTransition('OPEN', null)).toBeNull();
    expect(guardStatusTransition('OPEN', 'OPEN')).toBeNull();
  });
});
