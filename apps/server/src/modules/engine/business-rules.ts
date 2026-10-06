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
    /** Telegram bot: media asset sent as a photo when a user sends /start. */
    welcomeImageMediaId: z.string().nullable().default(null),
    /**
     * How a customer can reach a human when the agent genuinely does not know
     * a business fact (phone number, working hours, …). Offering this beats
     * both silence and invention — the two failure modes an unknown question
     * otherwise produces.
     */
    contactFallback: z.string().max(300).nullable().default(null),
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
  /** Validated media asset id to send with the reply (image channels only). */
  imageId: string | null;
  suppressedReason?: string;
  forceEscalate?: boolean;
}

/** Channels that can carry an image alongside the reply. */
const IMAGE_CHANNELS: ReadonlySet<keyof typeof CHANNEL_RULES> = new Set([
  'instagram_dm',
  'telegram',
  'telegram_personal',
] as const);

export async function applyBusinessRules(params: {
  agent: Agent;
  settings: AgentSettings;
  decision: AgentDecision;
  conversationId: string;
  channelKey: keyof typeof CHANNEL_RULES;
  /** Ids of media assets that exist for this tenant — anything else is dropped. */
  availableImageIds?: string[];
}): Promise<RuleVerdict> {
  const { agent, settings, decision, conversationId, channelKey } = params;
  const rules = CHANNEL_RULES[channelKey];

  let reply = decision.reply?.trim() || null;
  let privateReplyText = decision.privateReplyText?.trim() || null;

  // Image gate: must be a real asset id AND a channel that supports images.
  let imageId: string | null = null;
  if (
    decision.sendImageId &&
    IMAGE_CHANNELS.has(channelKey) &&
    (params.availableImageIds ?? []).includes(decision.sendImageId)
  ) {
    imageId = decision.sendImageId;
  }

  // 1. Spam/irrelevant → stay silent.
  if (decision.isSpamOrIrrelevant) {
    return {
      allowSend: false,
      reply: null,
      privateReplyText: null,
      imageId: null,
      suppressedReason: 'spam_or_irrelevant',
    };
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
      imageId: null,
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
        imageId: null,
        suppressedReason: 'rate_cooldown',
      };
    }

    // 5. Duplicate-response guard: never send the same text twice in a row,
    //    and never the same image twice in a row.
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
          imageId: null,
          suppressedReason: 'duplicate_reply',
        };
      }
    }
    if (imageId) {
      const lastImage = await prisma.conversationMessage.findFirst({
        where: {
          conversationId,
          direction: 'OUTBOUND',
          role: 'AGENT',
          metadata: { path: ['imageAssetId'], equals: imageId },
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      if (lastImage && Date.now() - lastImage.createdAt.getTime() < 6 * 3600_000) {
        imageId = null; // already sent this image recently — keep the text only
      }
    }
  }

  // An image always accompanies a text reply; never image-only sends.
  if (!reply) imageId = null;

  void agent;
  return { allowSend: !!(reply || privateReplyText), reply, privateReplyText, imageId };
}

/**
 * True when a comment carries no answerable content: empty, or only
 * @mentions, emoji, punctuation and whitespace (spec: skipTrivialComments).
 */
export function isTrivialComment(text: string): boolean {
  const stripped = text
    .replace(/@[\w.]+/g, '')
    // Emoji_Component covers ZWJ, variation selectors, keycaps and modifiers.
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\p{Emoji_Component}/gu, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  return stripped.length === 0;
}

export function truncateAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(' ');
  return `${slice.slice(0, lastSpace > max * 0.6 ? lastSpace : max - 1).trimEnd()}…`;
}
