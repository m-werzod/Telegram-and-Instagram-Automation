import { z } from 'zod';

/**
 * The structured decision every agent produces (spec §34). The model NEVER
 * executes anything directly — it emits this validated object and the pipeline
 * maps it onto controlled, logged tool executions (spec §21).
 *
 * All fields are required/nullable (not optional) so the schema works with
 * strict structured outputs.
 */
export const agentDecisionSchema = z.object({
  /** Message to send back to the user. null = deliberately do not respond. */
  reply: z.string().nullable(),
  /** BCP-47 / ISO-639-1 code of the language detected in the user's message. */
  detectedLanguage: z.string().nullable(),
  intent: z.enum([
    'price_inquiry',
    'product_interest',
    'question',
    'purchase_intent',
    'complaint',
    'support_request',
    'greeting',
    'spam',
    'irrelevant',
    'other',
  ]),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  /** True for spam/bot/abusive content — suppresses reply unless instructed otherwise. */
  isSpamOrIrrelevant: z.boolean(),
  /** Newly learned lead facts. Only include values the user actually provided. */
  leadUpdate: z
    .object({
      name: z.string().nullable(),
      phone: z.string().nullable(),
      email: z.string().nullable(),
      requestedService: z.string().nullable(),
      budget: z.string().nullable(),
      location: z.string().nullable(),
      timeline: z.string().nullable(),
    })
    .nullable(),
  /** Suggested pipeline status; the platform applies guarded transitions. */
  leadStatusSuggestion: z.enum(['OPEN', 'QUALIFIED', 'LOST', 'SPAM']).nullable(),
  /** 0–100 interest/quality score. */
  leadScore: z.number().min(0).max(100).nullable(),
  /** CRM tags to add (short, lowercase). */
  tags: z.array(z.string()),
  shouldEscalate: z.boolean(),
  escalationReason: z.string().nullable(),
  /** Internal CRM note (never shown to the user). */
  internalNote: z.string().nullable(),
  /**
   * Instagram Comment agent only: send the single allowed private reply (DM)
   * for this comment. Ignored on other channels.
   */
  sendPrivateReply: z.boolean(),
  privateReplyText: z.string().nullable(),
});

export type AgentDecision = z.infer<typeof agentDecisionSchema>;
