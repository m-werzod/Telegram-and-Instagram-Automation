import type { Agent, Lead, LeadStatus } from '@prisma/client';
import { getPrisma } from '../../db/client.js';
import { errorMessage } from '../../lib/errors.js';
import { childLogger } from '../../lib/logger.js';
import { getAIProvider } from '../ai/index.js';
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
}

export interface PipelineOutcome {
  status: 'replied' | 'silent' | 'skipped' | 'failed';
  decision: AgentDecision | null;
  verdict: RuleVerdict | null;
  settings: AgentSettings;
  escalated: boolean;
  aiExecutionId?: string;
  error?: string;
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

  const provider = getAIProvider(input.agent.provider);
  if (!provider) {
    return {
      status: 'failed',
      decision: null,
      verdict: null,
      settings,
      escalated: false,
      error: `AI provider "${input.agent.provider}" is not configured (missing API key)`,
    };
  }

  const system = buildSystemPrompt(input.agent, input.tenantName, input.channelKey);
  const messages = buildMessages(history, {
    lead: input.lead,
    knowledge,
    channelKey: input.channelKey,
    inboundText: input.inboundText,
    username: input.username,
    extraContext: input.extraContext,
  });

  const started = Date.now();
  const exec = await prisma.aIExecution.create({
    data: {
      tenantId: input.tenantId,
      agentId: input.agent.id,
      conversationId: conversation.id,
      requestId: input.requestId,
      model: input.agent.model,
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
      model: input.agent.model,
      maxTokens: 2048,
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
  });

  // Controlled tool executions from the validated decision (spec §21).
  const toolCtx = { tenantId: input.tenantId, aiExecutionId: exec.id, requestId: input.requestId };

  if (input.lead) {
    const statusSuggestion = guardStatusTransition(input.lead.status, decision.leadStatusSuggestion);
    const hasLeadChange =
      decision.leadUpdate ||
      decision.tags.length > 0 ||
      decision.leadScore !== null ||
      statusSuggestion ||
      decision.intent ||
      decision.detectedLanguage;
    if (hasLeadChange) {
      await executeTool(
        'updateLead',
        {
          leadId: input.lead.id,
          fields: {
            name: decision.leadUpdate?.name ?? undefined,
            phone: decision.leadUpdate?.phone ?? undefined,
            email: decision.leadUpdate?.email ?? undefined,
            language: decision.detectedLanguage ?? undefined,
            intent: decision.intent,
            status: statusSuggestion ?? undefined,
            score: decision.leadScore ?? undefined,
            addTags: decision.tags,
            qualification: pickQualification(decision),
          },
        },
        toolCtx,
      );
    }
    if (decision.internalNote) {
      await executeTool('createCRMNote', { leadId: input.lead.id, content: decision.internalNote }, toolCtx);
    }
  }

  let escalated = false;
  if (decision.shouldEscalate || verdict.forceEscalate) {
    const reason =
      decision.escalationReason ??
      (verdict.forceEscalate ? `blocked by business rules (${verdict.suppressedReason})` : 'agent requested escalation');
    await escalate(input, conversation.id, reason, settings);
    escalated = true;
  }

  const status: PipelineOutcome['status'] = verdict.allowSend ? 'replied' : 'silent';
  log.info(
    { status, intent: decision.intent, escalated, suppressed: verdict.suppressedReason },
    'pipeline completed',
  );
  return { status, decision, verdict, settings, escalated, aiExecutionId: exec.id };
}

async function escalate(
  input: PipelineInput,
  conversationId: string,
  reason: string,
  settings: AgentSettings,
): Promise<void> {
  await executeTool(
    'escalateToHuman',
    {
      conversationId,
      leadId: input.lead?.id ?? null,
      reason,
      pauseAgent: settings.pauseOnEscalation,
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

function pickQualification(decision: AgentDecision): Record<string, unknown> | undefined {
  const q = decision.leadUpdate;
  if (!q) return undefined;
  const out: Record<string, unknown> = {};
  if (q.requestedService) out.requestedService = q.requestedService;
  if (q.budget) out.budget = q.budget;
  if (q.location) out.location = q.location;
  if (q.timeline) out.timeline = q.timeline;
  return Object.keys(out).length ? out : undefined;
}
