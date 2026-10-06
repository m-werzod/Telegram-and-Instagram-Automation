/**
 * The failures these pin are the ones a customer actually experiences: an
 * account that stays silent, an agent that refuses anything off-script, and a
 * conversation that dies permanently after one "I don't know".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Agent } from '@prisma/client';
import { buildSystemPrompt, CHANNEL_RULES } from '../../src/modules/engine/prompt.js';
import { parseAgentSettings } from '../../src/modules/engine/business-rules.js';
import { initLogger } from '../../src/lib/logger.js';

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a1', tenantId: 't1', type: 'TELEGRAM_PERSONAL', name: 'Test', enabled: true,
    systemInstructions: 'Be helpful.', businessObjective: 'Qualify leads', tone: 'friendly',
    language: 'uz', provider: 'openai', model: 'gpt-5-mini', knowledgeBaseId: null,
    escalationRules: {}, settings: {}, createdAt: new Date(), updatedAt: new Date(), ...over,
  } as Agent;
}

describe('system prompt — two knowledge layers', () => {
  beforeEach(() => initLogger('silent', false));

  it('permits general-knowledge answers instead of only business ones', () => {
    const p = buildSystemPrompt(agent(), 'Turon', 'telegram');
    expect(p).toContain('GENERAL KNOWLEDGE');
    expect(p).toContain('BUSINESS KNOWLEDGE');
    // A general question must be answerable, not refused.
    expect(p).toMatch(/General question unrelated to this business → just answer it/);
  });

  it('forbids inventing live data rather than inventing an answer', () => {
    const p = buildSystemPrompt(agent(), 'Turon', 'telegram');
    expect(p).toMatch(/cannot check that right now/);
    expect(p).toMatch(/Never invent a current value/);
  });

  // The complaint was "nothing happens" — silence is the one unacceptable reply.
  it('states that silence is not an acceptable answer to an unfamiliar question', () => {
    const p = buildSystemPrompt(agent(), 'Turon', 'telegram');
    expect(p).toMatch(/Never return an empty reply because a question is unfamiliar/);
  });

  it('treats a greeting as something to answer, never to escalate', () => {
    const p = buildSystemPrompt(agent(), 'Turon', 'telegram');
    expect(p).toMatch(/A greeting is never a reason to stay silent or escalate/);
  });
});

describe('system prompt — configured fallback contact', () => {
  beforeEach(() => initLogger('silent', false));

  it('offers the operator-configured contact verbatim when a fact is unknown', () => {
    const p = buildSystemPrompt(agent(), 'Turon', 'telegram', '+998 55 252 37 37');
    expect(p).toContain('offer this contact verbatim: "+998 55 252 37 37"');
  });

  // Never invent a phone number — that is the fabrication the prompt forbids.
  it('promises no contact at all when none is configured', () => {
    const p = buildSystemPrompt(agent(), 'Turon', 'telegram');
    expect(p).not.toContain('offer this contact verbatim');
    expect(p).toMatch(/do not have that detail, and set shouldEscalate=true/);
  });

  it('reads the contact from agent settings', () => {
    const s = parseAgentSettings(agent({ settings: { contactFallback: '+998 90 000 00 00' } as object }));
    expect(s.contactFallback).toBe('+998 90 000 00 00');
    expect(parseAgentSettings(agent()).contactFallback).toBeNull();
  });
});

describe('personal-account channel rules', () => {
  it('no longer tells the agent to stay silent on anything not clearly business', () => {
    const extra = CHANNEL_RULES.telegram_personal.extra.join(' ');
    expect(extra).not.toMatch(/reply only when the message is clearly business-related/);
    expect(extra).toMatch(/silence reads as being ignored/);
  });

  // Privacy is still protected — just scoped to genuinely private matters.
  it('still keeps the agent out of the owner\u2019s private life', () => {
    const extra = CHANNEL_RULES.telegram_personal.extra.join(' ');
    expect(extra).toMatch(/family, health, money owed, relationships/);
    expect(extra).toMatch(/Never claim to be the owner in person/);
  });
});
