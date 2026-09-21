import type { Agent } from '@prisma/client';
import { z } from 'zod';
import { getPrisma } from '../../db/client.js';
import type { AgentDecision } from './decision.js';
import { CHANNEL_RULES } from './prompt.js';

/**
 * Post-generation business & safety rules (spec §20, §23, §52). The validated
 * model decision passes through these deterministic gates before any send.
 */

export const agentSettingsSchema = z
  .object({
    /** Phrases that must never appear in an outbound reply (case-insensitive). */
    bannedPhrases: z.array(z.string()).default([]),
    /** Max autonomous outbound messages per conversation per hour. */
    maxRepliesPerHour: z.number().int().positive().max(200).default(20),
    /** Pause autonomous replies for a conversation after escalation. */
    pauseOnEscalation: z.boolean().default(true),
    /** Comment agent: also reply publicly when a private reply is sent. */
    publicReplyOnPrivate: z.boolean().default(true),
    /** Skip replying to comments that only contain mentions/emoji. */
    skipTrivialComments: z.boolean().default(true),
  });

export type AgentSettings = z.infer<typeof agentSettingsSchema>;

export function parseAgentSettings(agent: Agent): AgentSettings {
  const parsed = agentSettingsSchema.safeParse(agent.settings ?? {});
  return parsed.success ? parsed.data : agentSettingsSchema.parse({});
}

export interface RuleVerdict {
  allowSend: boolean;
  reply: string | null;
  privateReplyText: string | null;
  suppressedReason?: string;
  forceEscalate?: boolean;
}

export async function applyBusinessRules(params: {
  agent: Agent;
  settings: AgentSettings;
  decision: AgentDecision;
  conversationId: string;
  channelKey: keyof typeof CHANNEL_RULES;
}): Promise<RuleVerdict> {
  const { agent, settings, decision, conversationId, channelKey } = params;
  const rules = CHANNEL_RULES[channelKey];

  let reply = decision.reply?.trim() || null;
  let privateReplyText = decision.privateReplyText?.trim() || null;

  // 1. Spam/irrelevant → stay silent.
  if (decision.isSpamOrIrrelevant) {
    return { allowSend: false, reply: null, privateReplyText: null, suppressedReason: 'spam_or_irrelevant' };
  }

  // 2. Length clamps (hard platform limits are enforced again in channel clients).
  if (reply && reply.length > rules.maxReplyChars) {
    reply = truncateAtBoundary(reply, rules.maxReplyChars);
  }
  if (privateReplyText && privateReplyText.length > 900) {
    privateReplyText = truncateAtBoundary(privateReplyText, 900);
  }

  // 3. Banned phrases → never send; escalate for human review.
  const banned = settings.bannedPhrases.map((p) => p.toLowerCase()).filter(Boolean);
  const violates = (text: string | null) =>
    !!text && banned.some((p) => text.toLowerCase().includes(p));
  if (violates(reply) || violates(privateReplyText)) {
    return {
      allowSend: false,
      reply: null,
      privateReplyText: null,
      suppressedReason: 'banned_phrase',
      forceEscalate: true,
    };
  }

  // 4. Rate cooldown per conversation.
  if (reply || privateReplyText) {
    const prisma = getPrisma();
    const oneHourAgo = new Date(Date.now() - 3600_000);
    const recentOutbound = await prisma.conversationMessage.count({
      where: {
        conversationId,
        direction: 'OUTBOUND',
        role: 'AGENT',
        createdAt: { gte: oneHourAgo },
      },
    });
    if (recentOutbound >= settings.maxRepliesPerHour) {
      return {
        allowSend: false,
        reply: null,
        privateReplyText: null,
        suppressedReason: 'rate_cooldown',
      };
    }

    // 5. Duplicate-response guard: never send the same text twice in a row.
    if (reply) {
      const lastOutbound = await prisma.conversationMessage.findFirst({
        where: { conversationId, direction: 'OUTBOUND', role: 'AGENT' },
        orderBy: { createdAt: 'desc' },
      });
      if (lastOutbound && lastOutbound.content.trim() === reply) {
        return {
          allowSend: false,
          reply: null,
          privateReplyText: null,
          suppressedReason: 'duplicate_reply',
        };
      }
    }
  }

  void agent;
  return { allowSend: !!(reply || privateReplyText), reply, privateReplyText };
}

export function truncateAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(' ');
  return `${slice.slice(0, lastSpace > max * 0.6 ? lastSpace : max - 1).trimEnd()}…`;
}
