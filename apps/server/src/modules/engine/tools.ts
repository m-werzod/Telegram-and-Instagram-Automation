import { z } from 'zod';
import { getPrisma } from '../../db/client.js';
import { errorMessage } from '../../lib/errors.js';
import { childLogger } from '../../lib/logger.js';

/**
 * Controlled tool layer (spec §21). Every side effect an agent decision can
 * cause goes through here: strict input schema, tenant authorization, timeout,
 * logging to ToolExecution. The AI never gets arbitrary DB or HTTP access.
 */

export interface ToolContext {
  tenantId: string;
  aiExecutionId?: string;
  requestId: string;
}

interface ToolDef<I> {
  name: string;
  schema: z.ZodType<I>;
  timeoutMs: number;
  run: (input: I, ctx: ToolContext) => Promise<unknown>;
}

const registry = new Map<string, ToolDef<any>>();

export function registerTool<I>(def: ToolDef<I>): void {
  registry.set(def.name, def);
}

export async function executeTool<I>(
  name: string,
  rawInput: I,
  ctx: ToolContext,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  const prisma = getPrisma();
  const started = Date.now();
  const def = registry.get(name);
  const log = childLogger({ module: 'tools', tool: name, requestId: ctx.requestId, tenantId: ctx.tenantId });

  const record = await prisma.toolExecution.create({
    data: {
      tenantId: ctx.tenantId,
      aiExecutionId: ctx.aiExecutionId ?? null,
      name,
      input: JSON.parse(JSON.stringify(rawInput ?? {})),
      status: 'RUNNING',
    },
  });

  const finish = async (status: 'SUCCEEDED' | 'FAILED', output?: unknown, error?: string) => {
    await prisma.toolExecution
      .update({
        where: { id: record.id },
        data: {
          status,
          output: output === undefined ? undefined : JSON.parse(JSON.stringify(output)),
          error: error?.slice(0, 1000),
          latencyMs: Date.now() - started,
        },
      })
      .catch(() => undefined);
  };

  if (!def) {
    await finish('FAILED', undefined, `Unknown tool: ${name}`);
    return { ok: false, error: `Unknown tool: ${name}` };
  }

  const parsed = def.schema.safeParse(rawInput);
  if (!parsed.success) {
    const msg = `Invalid input: ${parsed.error.issues.map((i) => i.message).join('; ')}`;
    await finish('FAILED', undefined, msg);
    return { ok: false, error: msg };
  }

  try {
    const output = await withTimeout(def.run(parsed.data, ctx), def.timeoutMs, name);
    await finish('SUCCEEDED', output);
    return { ok: true, output };
  } catch (err) {
    const msg = errorMessage(err);
    log.warn({ err: msg }, 'tool execution failed');
    await finish('FAILED', undefined, msg);
    return { ok: false, error: msg };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Tool ${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Built-in CRM tools ─────────────────────────────────────────────────────────

registerTool({
  name: 'updateLead',
  timeoutMs: 10_000,
  schema: z.object({
    leadId: z.string().min(1),
    fields: z.object({
      name: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      language: z.string().nullable().optional(),
      intent: z.string().nullable().optional(),
      status: z.enum(['NEW', 'OPEN', 'QUALIFIED', 'CONVERTED', 'LOST', 'SPAM']).optional(),
      score: z.number().min(0).max(100).optional(),
      addTags: z.array(z.string().max(50)).max(20).optional(),
      qualification: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  run: async (input, ctx) => {
    const { updateLeadFields } = await import('../crm/service.js');
    const lead = await updateLeadFields(ctx.tenantId, input.leadId, {
      name: input.fields.name ?? undefined,
      phone: input.fields.phone ?? undefined,
      email: input.fields.email ?? undefined,
      language: input.fields.language ?? undefined,
      intent: input.fields.intent ?? undefined,
      status: input.fields.status,
      score: input.fields.score,
      addTags: input.fields.addTags,
      qualification: input.fields.qualification as Record<string, unknown> | undefined,
    });
    return { leadId: lead.id, status: lead.status, score: lead.score };
  },
});

registerTool({
  name: 'createCRMNote',
  timeoutMs: 10_000,
  schema: z.object({
    leadId: z.string().min(1),
    content: z.string().min(1).max(4000),
  }),
  run: async (input, ctx) => {
    const { addNote } = await import('../crm/service.js');
    await addNote(ctx.tenantId, input.leadId, input.content, { type: 'AGENT' });
    return { created: true };
  },
});

registerTool({
  name: 'escalateToHuman',
  timeoutMs: 10_000,
  schema: z.object({
    conversationId: z.string().min(1),
    leadId: z.string().nullable(),
    reason: z.string().min(1).max(1000),
    pauseAgent: z.boolean(),
  }),
  run: async (input, ctx) => {
    const prisma = getPrisma();
    const conversation = await prisma.conversation.findFirst({
      where: { id: input.conversationId, tenantId: ctx.tenantId },
    });
    if (!conversation) throw new Error('Conversation not found');

    const existing = await prisma.humanHandoff.findFirst({
      where: { conversationId: conversation.id, status: 'OPEN' },
    });
    if (existing) return { handoffId: existing.id, alreadyOpen: true };

    const handoff = await prisma.humanHandoff.create({
      data: {
        tenantId: ctx.tenantId,
        conversationId: conversation.id,
        leadId: input.leadId,
        reason: input.reason,
      },
    });
    if (input.pauseAgent) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: 'HANDED_OFF', handedOffAt: new Date() },
      });
    }
    return { handoffId: handoff.id, paused: input.pauseAgent };
  },
});

registerTool({
  name: 'searchKnowledge',
  timeoutMs: 20_000,
  schema: z.object({
    knowledgeBaseId: z.string().min(1),
    query: z.string().min(1).max(2000),
  }),
  run: async (input, ctx) => {
    const { searchKnowledge } = await import('../knowledge/service.js');
    const chunks = await searchKnowledge(ctx.tenantId, input.knowledgeBaseId, input.query);
    return chunks.map((c) => ({ source: c.documentTitle, content: c.content, score: c.score }));
  },
});
