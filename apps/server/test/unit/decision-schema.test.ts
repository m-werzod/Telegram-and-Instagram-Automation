import { beforeEach, describe, expect, it } from 'vitest';
import { agentDecisionSchema, type AgentDecision } from '../../src/modules/engine/decision.js';
import { makeDecision } from '../helpers/stub-ai.js';
import { initLogger } from '../../src/lib/logger.js';

/** A fully populated, valid decision written out longhand (no helper). */
function fullDecision(): AgentDecision {
  return {
    reply: 'Our pricing starts at $99/month.',
    detectedLanguage: 'en',
    intent: 'price_inquiry',
    sentiment: 'positive',
    isSpamOrIrrelevant: false,
    leadUpdate: {
      name: 'Alice Doe',
      phone: '+15550001111',
      email: 'alice@example.com',
      requestedService: 'automation setup',
      category: 'B',
      purpose: 'personal car',
      budget: '$500',
      location: 'Tashkent',
      timeline: 'next month',
    },
    leadStatusSuggestion: 'QUALIFIED',
    leadScore: 85,
    tags: ['pricing', 'hot-lead'],
    shouldEscalate: true,
    escalationReason: 'High-value purchase intent',
    internalNote: 'Asked for pricing tier details.',
    courseRegistration: {
      fullName: 'Alice Doe',
      phone: '+998901234567',
      course: 'B toifa',
      preferredTime: 'ertalab',
    },
    sendPrivateReply: true,
    privateReplyText: 'Sent you a DM with details!',
    sendImageId: null,
  };
}

describe('agentDecisionSchema', () => {
  beforeEach(() => {
    initLogger('silent', false);
  });

  it('parses a fully valid, fully populated decision unchanged', () => {
    const input = fullDecision();
    const parsed = agentDecisionSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  it('round-trips the makeDecision test helper default', () => {
    const decision = makeDecision();
    const parsed = agentDecisionSchema.parse(decision);
    expect(parsed).toEqual(decision);
  });

  it('round-trips makeDecision with overrides applied', () => {
    const decision = makeDecision({ intent: 'complaint', leadScore: 10, tags: ['angry'] });
    const parsed = agentDecisionSchema.parse(decision);
    expect(parsed.intent).toBe('complaint');
    expect(parsed.leadScore).toBe(10);
    expect(parsed.tags).toEqual(['angry']);
  });

  it('rejects a decision missing a required field (intent)', () => {
    const { intent: _omitted, ...withoutIntent } = makeDecision();
    const result = agentDecisionSchema.safeParse(withoutIntent);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'intent')).toBe(true);
    }
  });

  it('rejects a decision missing the tags field', () => {
    const { tags: _omitted, ...withoutTags } = makeDecision();
    const result = agentDecisionSchema.safeParse(withoutTags);
    expect(result.success).toBe(false);
  });

  it('rejects an invalid intent enum value', () => {
    const result = agentDecisionSchema.safeParse({ ...makeDecision(), intent: 'buy_now' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['intent']);
      expect(result.error.issues[0]?.code).toBe('invalid_value');
    }
  });

  it('rejects an invalid sentiment enum value', () => {
    const result = agentDecisionSchema.safeParse({ ...makeDecision(), sentiment: 'mixed' });
    expect(result.success).toBe(false);
  });

  it('rejects leadScore below the 0-100 range (-1)', () => {
    const result = agentDecisionSchema.safeParse(makeDecision({ leadScore: -1 }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['leadScore']);
    }
  });

  it('rejects leadScore above the 0-100 range (101)', () => {
    const result = agentDecisionSchema.safeParse(makeDecision({ leadScore: 101 }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['leadScore']);
    }
  });

  it('accepts leadScore at the boundaries (0 and 100) and null', () => {
    expect(agentDecisionSchema.parse(makeDecision({ leadScore: 0 })).leadScore).toBe(0);
    expect(agentDecisionSchema.parse(makeDecision({ leadScore: 100 })).leadScore).toBe(100);
    expect(agentDecisionSchema.parse(makeDecision({ leadScore: null })).leadScore).toBeNull();
  });

  it('accepts reply: null (deliberate non-response)', () => {
    const parsed = agentDecisionSchema.parse(makeDecision({ reply: null }));
    expect(parsed.reply).toBeNull();
  });

  it('accepts leadUpdate: null', () => {
    const parsed = agentDecisionSchema.parse(makeDecision({ leadUpdate: null }));
    expect(parsed.leadUpdate).toBeNull();
  });

  it('accepts a fully populated leadUpdate object', () => {
    const leadUpdate = {
      name: 'Bob',
      phone: null,
      email: 'bob@example.com',
      requestedService: null,
      category: 'BC',
      purpose: null,
      budget: '1000 USD',
      location: null,
      timeline: 'ASAP',
    };
    const parsed = agentDecisionSchema.parse(makeDecision({ leadUpdate }));
    expect(parsed.leadUpdate).toEqual(leadUpdate);
  });

  it('rejects a leadUpdate object missing its required nullable keys', () => {
    const result = agentDecisionSchema.safeParse({
      ...makeDecision(),
      leadUpdate: { name: 'Bob' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.every((issue) => issue.path[0] === 'leadUpdate')).toBe(true);
    }
  });

  it('strips an unknown extra top-level property (zod object default)', () => {
    const withExtra = { ...makeDecision(), hackedField: 'ignore me' };
    const result = agentDecisionSchema.safeParse(withExtra);
    expect(result.success).toBe(true);
    if (result.success) {
      expect('hackedField' in result.data).toBe(false);
      expect(Object.keys(result.data).sort()).toEqual(Object.keys(makeDecision()).sort());
    }
  });

  it('rejects tags containing non-string elements', () => {
    const result = agentDecisionSchema.safeParse({ ...makeDecision(), tags: ['ok', 42] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['tags', 1]);
    }
  });

  it('rejects tags given as a plain string instead of an array', () => {
    const result = agentDecisionSchema.safeParse({ ...makeDecision(), tags: 'pricing' });
    expect(result.success).toBe(false);
  });

  it('accepts an empty tags array and a populated string array', () => {
    expect(agentDecisionSchema.parse(makeDecision({ tags: [] })).tags).toEqual([]);
    expect(agentDecisionSchema.parse(makeDecision({ tags: ['a', 'b'] })).tags).toEqual(['a', 'b']);
  });

  it('accepts all valid leadStatusSuggestion values and null', () => {
    for (const status of ['OPEN', 'QUALIFIED', 'LOST', 'SPAM'] as const) {
      expect(
        agentDecisionSchema.parse(makeDecision({ leadStatusSuggestion: status }))
          .leadStatusSuggestion,
      ).toBe(status);
    }
    expect(
      agentDecisionSchema.parse(makeDecision({ leadStatusSuggestion: null })).leadStatusSuggestion,
    ).toBeNull();
    expect(
      agentDecisionSchema.safeParse({ ...makeDecision(), leadStatusSuggestion: 'NEW' }).success,
    ).toBe(false);
  });

  it('rejects non-boolean isSpamOrIrrelevant and undefined reply', () => {
    expect(
      agentDecisionSchema.safeParse({ ...makeDecision(), isSpamOrIrrelevant: 'no' }).success,
    ).toBe(false);
    expect(agentDecisionSchema.safeParse({ ...makeDecision(), reply: undefined }).success).toBe(
      false,
    );
  });
});
