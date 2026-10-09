import { beforeEach, describe, expect, it, type Mock } from 'vitest';
import type { Agent } from '@prisma/client';
import {
  applyBusinessRules,
  parseAgentSettings,
  truncateAtBoundary,
  type AgentSettings,
} from '../../src/modules/engine/business-rules.js';
import { makeTestEnv } from '../helpers/test-env.js';
import { mockPrisma, type MockModel } from '../helpers/mock-prisma.js';
import { makeDecision } from '../helpers/stub-ai.js';
import { initLogger } from '../../src/lib/logger.js';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    tenantId: 'tenant-1',
    type: 'INSTAGRAM_DM',
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

const defaultSettings = (): AgentSettings => parseAgentSettings(makeAgent());

describe('truncateAtBoundary', () => {
  it('returns short text unchanged (no ellipsis)', () => {
    expect(truncateAtBoundary('hello world', 50)).toBe('hello world');
  });

  it('returns text exactly at the limit unchanged', () => {
    const text = 'x'.repeat(40);
    expect(truncateAtBoundary(text, 40)).toBe(text);
  });

  it('truncates long text at a word boundary and appends an ellipsis', () => {
    const text = 'The quick brown fox jumps over the lazy dog again and again forever';
    const out = truncateAtBoundary(text, 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.endsWith('…')).toBe(true);
    // Cut at a word boundary: the part before the ellipsis is a prefix of the
    // original ending on a full word (no trailing partial word or space).
    const body = out.slice(0, -1);
    expect(text.startsWith(body)).toBe(true);
    expect(body).not.toMatch(/\s$/);
    expect(text[body.length]).toBe(' ');
  });

  it('falls back to a hard cut when there is no usable space', () => {
    const text = 'a'.repeat(100);
    const out = truncateAtBoundary(text, 20);
    expect(out).toBe(`${'a'.repeat(19)}…`);
    expect(out.length).toBe(20);
  });

  it('never exceeds max for a variety of inputs', () => {
    const samples = [
      'word '.repeat(200),
      'supercalifragilisticexpialidocious '.repeat(30),
      'a b c d e f g h i j k l m n o p q r s t u v w x y z '.repeat(10),
    ];
    for (const s of samples) {
      for (const max of [10, 50, 900]) {
        expect(truncateAtBoundary(s, max).length).toBeLessThanOrEqual(max);
      }
    }
  });
});

describe('parseAgentSettings', () => {
  it('returns defaults for an empty settings object', () => {
    const settings = parseAgentSettings(makeAgent({ settings: {} }));
    expect(settings).toEqual({
      bannedPhrases: [],
      maxRepliesPerHour: 20,
      pauseOnEscalation: true,
      publicReplyOnPrivate: true,
      skipTrivialComments: true,
      welcomeImageMediaId: null,
      contactFallback: null,
      stickers: { priceInquiry: null, greeting: null, thanks: null },
    });
  });

  it('falls back to defaults when the settings json is invalid', () => {
    const settings = parseAgentSettings(
      makeAgent({ settings: { maxRepliesPerHour: 'lots', bannedPhrases: 'nope' } as never }),
    );
    expect(settings.maxRepliesPerHour).toBe(20);
    expect(settings.bannedPhrases).toEqual([]);
    expect(settings.pauseOnEscalation).toBe(true);
  });

  it('falls back to defaults when settings is null', () => {
    const settings = parseAgentSettings(makeAgent({ settings: null as never }));
    expect(settings.maxRepliesPerHour).toBe(20);
  });

  it('respects explicit values', () => {
    const settings = parseAgentSettings(
      makeAgent({
        settings: {
          bannedPhrases: ['Guarantee', 'refund'],
          maxRepliesPerHour: 3,
          pauseOnEscalation: false,
          publicReplyOnPrivate: false,
          skipTrivialComments: false,
          welcomeImageMediaId: 'media-9',
          contactFallback: '+998 55 252 37 37',
        } as never,
      }),
    );
    expect(settings).toEqual({
      bannedPhrases: ['Guarantee', 'refund'],
      maxRepliesPerHour: 3,
      pauseOnEscalation: false,
      publicReplyOnPrivate: false,
      skipTrivialComments: false,
      welcomeImageMediaId: 'media-9',
      contactFallback: '+998 55 252 37 37',
      stickers: { priceInquiry: null, greeting: null, thanks: null },
    });
  });
});

describe('applyBusinessRules', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  // The mock proxy creates delegates/methods lazily, so they always exist;
  // grab typed handles once to satisfy noUncheckedIndexedAccess.
  let countMessages: Mock;
  let findFirstMessage: Mock;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
    const conversationMessage = prisma.conversationMessage as MockModel;
    countMessages = conversationMessage.count as Mock;
    findFirstMessage = conversationMessage.findFirst as Mock;
    countMessages.mockResolvedValue(0);
    findFirstMessage.mockResolvedValue(null);
  });

  const baseParams = () => ({
    agent: makeAgent(),
    settings: defaultSettings(),
    decision: makeDecision(),
    conversationId: 'conv-1',
    channelKey: 'instagram_dm' as const,
  });

  it('spam/irrelevant is suppressed without touching the database', async () => {
    const verdict = await applyBusinessRules({
      ...baseParams(),
      decision: makeDecision({ reply: 'should not go out', isSpamOrIrrelevant: true }),
    });
    expect(verdict).toEqual({
      allowSend: false,
      stickerId: null,
      reply: null,
      privateReplyText: null,
      imageId: null,
      suppressedReason: 'spam_or_irrelevant',
    });
    expect(countMessages).not.toHaveBeenCalled();
  });

  it('clamps an over-long reply to the channel limit (instagram_dm = 900)', async () => {
    const longReply = 'word '.repeat(400).trim(); // ~2000 chars
    const verdict = await applyBusinessRules({
      ...baseParams(),
      decision: makeDecision({ reply: longReply }),
    });
    expect(verdict.allowSend).toBe(true);
    expect(verdict.reply).not.toBeNull();
    expect(verdict.reply!.length).toBeLessThanOrEqual(900);
    expect(verdict.reply!.endsWith('…')).toBe(true);
  });

  it('clamps an over-long privateReplyText to 900', async () => {
    const verdict = await applyBusinessRules({
      ...baseParams(),
      decision: makeDecision({
        reply: 'ok',
        sendPrivateReply: true,
        privateReplyText: 'dm '.repeat(500).trim(),
      }),
    });
    expect(verdict.allowSend).toBe(true);
    expect(verdict.privateReplyText!.length).toBeLessThanOrEqual(900);
    expect(verdict.privateReplyText!.endsWith('…')).toBe(true);
  });

  it('banned phrase in the reply blocks everything and forces escalation', async () => {
    const verdict = await applyBusinessRules({
      ...baseParams(),
      settings: { ...defaultSettings(), bannedPhrases: ['Guarantee'] },
      decision: makeDecision({
        reply: 'We GUARANTEE a full refund!',
        privateReplyText: 'a perfectly clean private message',
      }),
    });
    expect(verdict).toEqual({
      allowSend: false,
      stickerId: null,
      reply: null,
      privateReplyText: null,
      imageId: null,
      suppressedReason: 'banned_phrase',
      forceEscalate: true,
    });
  });

  it('banned phrase in privateReplyText alone also blocks both texts', async () => {
    const verdict = await applyBusinessRules({
      ...baseParams(),
      settings: { ...defaultSettings(), bannedPhrases: ['secret discount'] },
      decision: makeDecision({
        reply: 'A clean public reply.',
        privateReplyText: 'Here is a SECRET DISCOUNT just for you',
      }),
    });
    expect(verdict.allowSend).toBe(false);
    expect(verdict.reply).toBeNull();
    expect(verdict.privateReplyText).toBeNull();
    expect(verdict.suppressedReason).toBe('banned_phrase');
    expect(verdict.forceEscalate).toBe(true);
  });

  it('suppresses with rate_cooldown when recent outbound count reaches maxRepliesPerHour', async () => {
    countMessages.mockResolvedValue(3);
    const verdict = await applyBusinessRules({
      ...baseParams(),
      settings: { ...defaultSettings(), maxRepliesPerHour: 3 },
    });
    expect(verdict).toEqual({
      allowSend: false,
      stickerId: null,
      reply: null,
      privateReplyText: null,
      imageId: null,
      suppressedReason: 'rate_cooldown',
    });
    expect(countMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          conversationId: 'conv-1',
          direction: 'OUTBOUND',
          role: 'AGENT',
        }),
      }),
    );
    // Suppressed before the duplicate guard runs.
    expect(findFirstMessage).not.toHaveBeenCalled();
  });

  it('allows sending when the recent outbound count is below the limit', async () => {
    countMessages.mockResolvedValue(2);
    const verdict = await applyBusinessRules({
      ...baseParams(),
      settings: { ...defaultSettings(), maxRepliesPerHour: 3 },
    });
    expect(verdict.allowSend).toBe(true);
    expect(verdict.suppressedReason).toBeUndefined();
  });

  it('suppresses a duplicate of the last outbound message', async () => {
    findFirstMessage.mockResolvedValue({
      id: 'msg-1',
      conversationId: 'conv-1',
      direction: 'OUTBOUND',
      role: 'AGENT',
      content: '  Hello! How can I help?  ',
      createdAt: new Date(),
    });
    const verdict = await applyBusinessRules({
      ...baseParams(),
      decision: makeDecision({ reply: 'Hello! How can I help?' }),
    });
    expect(verdict).toEqual({
      allowSend: false,
      stickerId: null,
      reply: null,
      privateReplyText: null,
      imageId: null,
      suppressedReason: 'duplicate_reply',
    });
  });

  it('a different last outbound message does not trip the duplicate guard', async () => {
    findFirstMessage.mockResolvedValue({
      id: 'msg-1',
      content: 'Something else entirely',
      createdAt: new Date(),
    });
    const verdict = await applyBusinessRules({
      ...baseParams(),
      decision: makeDecision({ reply: 'Hello! How can I help?' }),
    });
    expect(verdict.allowSend).toBe(true);
    expect(verdict.reply).toBe('Hello! How can I help?');
  });

  it('normal reply passes with allowSend true and trimmed text', async () => {
    const verdict = await applyBusinessRules({
      ...baseParams(),
      decision: makeDecision({ reply: '  Delivery costs $5.  ' }),
    });
    expect(verdict).toEqual({
      allowSend: true,
      stickerId: null,
      reply: 'Delivery costs $5.',
      privateReplyText: null,
      imageId: null,
    });
  });

  it('no reply and no private text → allowSend false without DB checks', async () => {
    const verdict = await applyBusinessRules({
      ...baseParams(),
      decision: makeDecision({ reply: null, privateReplyText: null }),
    });
    expect(verdict.allowSend).toBe(false);
    expect(verdict.suppressedReason).toBeUndefined();
    expect(countMessages).not.toHaveBeenCalled();
  });

  it('a whitespace-only reply is treated as no reply', async () => {
    const verdict = await applyBusinessRules({
      ...baseParams(),
      decision: makeDecision({ reply: '   ' }),
    });
    expect(verdict.allowSend).toBe(false);
    expect(verdict.reply).toBeNull();
  });

  it('a valid sendImageId on an image channel passes through as imageId', async () => {
    const verdict = await applyBusinessRules({
      ...baseParams(),
      decision: makeDecision({ reply: 'Mana narxlar jadvali:', sendImageId: 'img-1' }),
      availableImageIds: ['img-1', 'img-2'],
    });
    expect(verdict.allowSend).toBe(true);
    expect(verdict.imageId).toBe('img-1');
  });

  it('an unknown sendImageId is dropped (hallucinated id)', async () => {
    const verdict = await applyBusinessRules({
      ...baseParams(),
      decision: makeDecision({ reply: 'Here you go', sendImageId: 'made-up' }),
      availableImageIds: ['img-1'],
    });
    expect(verdict.allowSend).toBe(true);
    expect(verdict.imageId).toBeNull();
  });

  it('sendImageId is dropped on the public comment channel', async () => {
    const verdict = await applyBusinessRules({
      ...baseParams(),
      channelKey: 'instagram_comment' as const,
      decision: makeDecision({ reply: 'public answer', sendImageId: 'img-1' }),
      availableImageIds: ['img-1'],
    });
    expect(verdict.imageId).toBeNull();
  });

  it('an image without a text reply is dropped (no image-only sends)', async () => {
    const verdict = await applyBusinessRules({
      ...baseParams(),
      decision: makeDecision({ reply: null, sendImageId: 'img-1' }),
      availableImageIds: ['img-1'],
    });
    expect(verdict.allowSend).toBe(false);
    expect(verdict.imageId).toBeNull();
  });

  it('the same image sent recently in this conversation is not repeated', async () => {
    findFirstMessage.mockImplementation(async (args: { where?: { metadata?: unknown } }) =>
      args?.where && 'metadata' in args.where
        ? { id: 'msg-img', content: '[rasm: Narxlar]', createdAt: new Date() }
        : null,
    );
    const verdict = await applyBusinessRules({
      ...baseParams(),
      decision: makeDecision({ reply: 'Yana bir bor jadval:', sendImageId: 'img-1' }),
      availableImageIds: ['img-1'],
    });
    expect(verdict.allowSend).toBe(true);
    expect(verdict.imageId).toBeNull();
  });

  it('private-reply-only decision still passes rate/duplicate gates and is sendable', async () => {
    const verdict = await applyBusinessRules({
      ...baseParams(),
      channelKey: 'instagram_comment' as const,
      decision: makeDecision({
        reply: null,
        sendPrivateReply: true,
        privateReplyText: 'Hi! Sent you the details.',
      }),
    });
    expect(verdict.allowSend).toBe(true);
    expect(verdict.reply).toBeNull();
    expect(verdict.privateReplyText).toBe('Hi! Sent you the details.');
    expect(countMessages).toHaveBeenCalled();
    // No public reply → duplicate guard (which only applies to `reply`) is skipped.
    expect(findFirstMessage).not.toHaveBeenCalled();
  });
});
