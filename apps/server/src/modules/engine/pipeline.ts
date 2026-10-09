import type { Agent, Lead, LeadStatus } from '@prisma/client';
import { getPrisma } from '../../db/client.js';
import { errorMessage } from '../../lib/errors.js';
import { childLogger } from '../../lib/logger.js';
import { resolveProviderForModel } from '../ai/index.js';
import { searchKnowledge, type RetrievedChunk } from '../knowledge/service.js';
import {
  applyBusinessRules,
  parseAgentSettings,
  type AgentSettings,
  type RuleVerdict,
} from './business-rules.js';
import { agentDecisionSchema, type AgentDecision } from './decision.js';
import { buildMessages, buildSystemPrompt, CHANNEL_RULES } from './prompt.js';
import { executeTool } from './tools.js';

/**
 * Agent execution pipeline (spec §20):
 * event → [caller: verify/dedup/persist] → agent enabled? → instructions →
 * CRM context → history → knowledge → AI → validate → business rules →
 * controlled tools → [caller: send channel response + persist] → logs.
 */

export interface PipelineInput {
  tenantId: string;
  tenantName: string;
  agent: Agent;
  conversationId: string;
  lead: Lead | null;
  channelKey: keyof typeof CHANNEL_RULES;
  inboundText: string;
  username?: string | null;
  requestId: string;
  /** Extra channel context blocks (e.g. the media caption for a comment). */
  extraContext?: string[];
  /** Which connected account handled this — stamped onto any registration. */
  sourceAccount?: string | null;
}

export interface PipelineOutcome {
  status: 'replied' | 'silent' | 'skipped' | 'failed';
  decision: AgentDecision | null;
  verdict: RuleVerdict | null;
  settings: AgentSettings;
  escalated: boolean;
  aiExecutionId?: string;
  error?: string;
  /** Set when this turn filed a course registration. */
  registrationId?: string;
}

const HISTORY_LIMIT = 20;

export async function runAgentPipeline(input: PipelineInput): Promise<PipelineOutcome> {
  const prisma = getPrisma();
  const settings = parseAgentSettings(input.agent);
  const log = childLogger({
    module: 'engine',
    requestId: input.requestId,
    tenantId: input.tenantId,
    agentId: input.agent.id,
    conversationId: input.conversationId,
  });

  // Backend enforcement of the agent toggle (spec §5) — defense in depth even
  // though callers check before enqueueing work.
  if (!input.agent.enabled) {
    log.info('agent disabled — event recorded, no autonomous response');
    return { status: 'skipped', decision: null, verdict: null, settings, escalated: false };
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, tenantId: input.tenantId },
  });
  if (!conversation) {
    return {
      status: 'failed',
      decision: null,
      verdict: null,
      settings,
      escalated: false,
      error: 'conversation not found',
    };
  }
  if (conversation.status === 'HANDED_OFF') {
    log.info('conversation handed off to human — agent stays silent');
    return { status: 'skipped', decision: null, verdict: null, settings, escalated: false };
  }

  // Conversation memory: recent turns only (spec §49).
  const historyRows = await prisma.conversationMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_LIMIT,
  });
  const history = historyRows.reverse().map((m) => ({ role: m.role, content: m.content }));
  // Handlers persist the inbound message BEFORE running the pipeline, so the
  // newest history row is the current message — drop it here or the model
  // would see every message twice (history turn + <current_user_message>).
  const last = history[history.length - 1];
  if (last && last.role === 'USER' && last.content === input.inboundText) {
    history.pop();
  }

  // Knowledge retrieval — semantic, bounded, never the whole KB (spec §8).
  let knowledge: RetrievedChunk[] = [];
  if (input.agent.knowledgeBaseId) {
    try {
      knowledge = await searchKnowledge(
        input.tenantId,
        input.agent.knowledgeBaseId,
        input.inboundText,
      );
    } catch (err) {
      log.warn({ err: errorMessage(err) }, 'knowledge retrieval failed — continuing without it');
    }
  }

  // Media library the agent may reference via sendImageId (image channels only).
  let availableImages: Array<{ id: string; name: string; description: string }> = [];
  try {
    availableImages = await prisma.mediaAsset.findMany({
      where: { tenantId: input.tenantId },
      orderBy: { createdAt: 'asc' },
      take: 30,
      select: { id: true, name: true, description: true },
    });
  } catch (err) {
    log.warn({ err: errorMessage(err) }, 'media list failed — continuing without images');
  }

  // Provider is derived from the model (the single source of truth), with a
  // cross-provider fallback so a key configured for the OTHER provider still
  // keeps the agent answering instead of 401-ing on every message.
  const resolved = await resolveProviderForModel(input.tenantId, input.agent.model);
  if (!resolved) {
    return {
      status: 'failed',
      decision: null,
      verdict: null,
      settings,
      escalated: false,
      error: `No AI API key is configured — add one in Settings before agents can reply`,
    };
  }
  const { provider } = resolved;

  // Loaded per turn, so edits in the dashboard take effect on the next
  // message without a redeploy or a cache to invalidate.
  const ownerInstructions = await loadOwnerInstructions(input.tenantId, input.agent.type);
  const system = buildSystemPrompt(
    input.agent,
    input.tenantName,
    input.channelKey,
    settings.contactFallback,
    ownerInstructions,
  );
  const messages = buildMessages(history, {
    lead: input.lead,
    knowledge,
    channelKey: input.channelKey,
    inboundText: input.inboundText,
    username: input.username,
    extraContext: input.extraContext,
    availableImages,
  });

  const started = Date.now();
  const exec = await prisma.aIExecution.create({
    data: {
      tenantId: input.tenantId,
      agentId: input.agent.id,
      conversationId: conversation.id,
      requestId: input.requestId,
      model: resolved.model,
      status: 'RUNNING',
    },
  });

  let decision: AgentDecision;
  try {
    const result = await provider.generateStructured({
      system,
      messages,
      schema: agentDecisionSchema,
      schemaName: 'agent_decision',
      model: resolved.model,
      // Headroom, not a target: on every current Claude model thinking is on
      // by default, and those tokens come out of the same budget as the JSON
      // decision. A cap tight enough to truncate mid-object turns a good reply
      // into an unparseable response, so leave room — max_tokens is a ceiling,
      // not a reservation, and costs nothing when unused.
      maxTokens: 8192,
      // Measured on production traffic: at 'medium' a one-line greeting cost
      // ~1,400 reasoning tokens and 12–32 s end-to-end. On a chat channel the
      // wait IS the product — a customer reads 20 s of silence as "nobody is
      // there" — and this workload is short replies plus a small classification,
      // not deep reasoning. 'low' keeps that accuracy at a fraction of the wait.
      effort: 'low',
    });

    if (result.refused) {
      await prisma.aIExecution.update({
        where: { id: exec.id },
        data: {
          status: 'FAILED',
          error: `safety refusal: ${result.refusalReason ?? ''}`.slice(0, 500),
          latencyMs: Date.now() - started,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        },
      });
      // A refusal means the inbound content needs human eyes — escalate quietly.
      await escalate(input, conversation.id, 'AI safety refusal — human review needed', settings);
      return {
        status: 'silent',
        decision: null,
        verdict: null,
        settings,
        escalated: true,
        aiExecutionId: exec.id,
      };
    }

    decision = result.output;
    await prisma.aIExecution.update({
      where: { id: exec.id },
      data: {
        status: 'SUCCEEDED',
        decision: JSON.parse(JSON.stringify(decision)),
        latencyMs: Date.now() - started,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        model: result.model,
      },
    });
  } catch (err) {
    await prisma.aIExecution.update({
      where: { id: exec.id },
      data: { status: 'FAILED', error: errorMessage(err).slice(0, 1000), latencyMs: Date.now() - started },
    });
    throw err; // retryable errors propagate to the queue's retry policy
  }

  // Deterministic business/safety gates (spec §20, §23).
  const verdict = await applyBusinessRules({
    agent: input.agent,
    settings,
    decision,
    conversationId: conversation.id,
    channelKey: input.channelKey,
    availableImageIds: availableImages.map((img) => img.id),
  });

  // Controlled tool executions from the validated decision (spec §21).
  const toolCtx = { tenantId: input.tenantId, aiExecutionId: exec.id, requestId: input.requestId };
  let registrationId: string | undefined;

  if (input.lead) {
    const statusSuggestion = guardStatusTransition(input.lead.status, decision.leadStatusSuggestion);
    // Low-signal intents must not clobber a lead's stored classification
    // (e.g. 'purchase_intent' being overwritten by a later 'greeting').
    const meaningfulIntent = ['greeting', 'irrelevant', 'other', 'spam'].includes(decision.intent)
      ? undefined
      : decision.intent;
    // Clamp model-sourced tags to the tool contract (≤20 tags, ≤50 chars each)
    // so an overlong tag can never invalidate the whole lead update.
    const tags = decision.tags
      .map((t) => t.trim().slice(0, 50))
      .filter(Boolean)
      .slice(0, 20);
    const hasLeadChange =
      decision.leadUpdate ||
      tags.length > 0 ||
      decision.leadScore !== null ||
      statusSuggestion ||
      meaningfulIntent ||
      decision.detectedLanguage;
    if (hasLeadChange) {
      const result = await executeTool(
        'updateLead',
        {
          leadId: input.lead.id,
          fields: {
            name: decision.leadUpdate?.name ?? undefined,
            phone: decision.leadUpdate?.phone ?? undefined,
            email: decision.leadUpdate?.email ?? undefined,
            language: decision.detectedLanguage ?? undefined,
            intent: meaningfulIntent,
            status: statusSuggestion ?? undefined,
            score: decision.leadScore ?? undefined,
            addTags: tags,
            qualification: pickQualification(decision),
          },
        },
        toolCtx,
      );
      if (!result.ok) {
        log.warn({ error: result.error }, 'updateLead tool failed — lead fields not applied');
      }
    }
    if (decision.internalNote) {
      await executeTool('createCRMNote', { leadId: input.lead.id, content: decision.internalNote }, toolCtx);
    }

    // A stated intent to enrol, with the details to act on, becomes a course
    // registration. Incomplete drafts file nothing — the agent has been told
    // to ask for what is missing, and a row a salesperson cannot call is
    // worse than no row.
    if (decision.courseRegistration) {
      const result = await executeTool(
        'recordCourseRegistration',
        {
          leadId: input.lead.id,
          conversationId: conversation.id,
          sourceChannel: input.channelKey.startsWith('instagram') ? 'INSTAGRAM' : 'TELEGRAM',
          sourceAccount: input.sourceAccount ?? null,
          draft: {
            fullName: decision.courseRegistration.fullName,
            phone: decision.courseRegistration.phone,
            course: decision.courseRegistration.course,
            preferredTime: decision.courseRegistration.preferredTime,
          },
        },
        toolCtx,
      );
      if (result.ok) {
        const out = result.output as { registrationId?: string } | undefined;
        if (out?.registrationId) registrationId = out.registrationId;
      } else {
        log.warn({ error: result.error }, 'course registration not recorded');
      }
    }
  }

  let escalated = false;
  if (decision.shouldEscalate || verdict.forceEscalate) {
    const reason =
      decision.escalationReason ??
      (verdict.forceEscalate ? `blocked by business rules (${verdict.suppressedReason})` : 'agent requested escalation');
    // Pausing the agent is for conversations a human is taking OVER — not for
    // the common case where the agent answered and merely flagged something
    // for follow-up ("I'll check that and get back to you"). Pausing there
    // mutes the conversation permanently: every later message is skipped, so
    // one "I don't know" silently ends the relationship. Only a turn we did
    // NOT reply to is a real handover.
    await escalate(input, conversation.id, reason, settings, verdict.allowSend);
    escalated = true;
  }

  const status: PipelineOutcome['status'] = verdict.allowSend ? 'replied' : 'silent';
  log.info(
    { status, intent: decision.intent, escalated, suppressed: verdict.suppressedReason },
    'pipeline completed',
  );
  return { status, decision, verdict, settings, escalated, aiExecutionId: exec.id, registrationId };
}

async function escalate(
  input: PipelineInput,
  conversationId: string,
  reason: string,
  settings: AgentSettings,
  /** True when this turn still produced a reply — then it is a flag, not a handover. */
  replied = false,
): Promise<void> {
  await executeTool(
    'escalateToHuman',
    {
      conversationId,
      leadId: input.lead?.id ?? null,
      reason,
      pauseAgent: settings.pauseOnEscalation && !replied,
    },
    { tenantId: input.tenantId, requestId: input.requestId },
  );
}

/** Guarded status transitions — the model can suggest, never downgrade. */
export function guardStatusTransition(
  current: LeadStatus,
  suggested: AgentDecision['leadStatusSuggestion'],
): LeadStatus | null {
  if (!suggested) return null;
  if (current === 'CONVERTED') return null;
  if (current === 'QUALIFIED' && (suggested === 'OPEN' || suggested === 'SPAM')) return null;
  if (suggested === current) return null;
  return suggested;
}

/**
 * The owner's own rules for this agent: tenant-wide ones plus any scoped to
 * this agent type. Read fresh each turn — a rule the owner just saved must
 * apply to the very next message, and the list is tiny.
 *
 * Never throws: a failure here must degrade to "no extra rules", not kill a
 * reply the customer is waiting for.
 */
async function loadOwnerInstructions(tenantId: string, agentType: Agent['type']): Promise<string[]> {
  try {
    const rows = await getPrisma().ownerInstruction.findMany({
      where: { tenantId, enabled: true, OR: [{ appliesTo: null }, { appliesTo: agentType }] },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      take: 50,
      select: { text: true },
    });
    return rows.map((r) => r.text.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function pickQualification(decision: AgentDecision): Record<string, unknown> | undefined {
  const q = decision.leadUpdate;
  if (!q) return undefined;
  const out: Record<string, unknown> = {};
  if (q.requestedService) out.requestedService = q.requestedService;
  if (q.category) out.category = q.category;
  if (q.purpose) out.purpose = q.purpose;
  if (q.budget) out.budget = q.budget;
  if (q.location) out.location = q.location;
  if (q.timeline) out.timeline = q.timeline;
  return Object.keys(out).length ? out : undefined;
}
