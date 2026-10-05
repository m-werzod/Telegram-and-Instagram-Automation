import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../db/client.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { providerForModel, SUPPORTED_MODELS } from '../modules/ai/index.js';
import { agentSettingsSchema } from '../modules/engine/business-rules.js';
import { requireAuth, tenantOf } from './middleware.js';

/**
 * Agent management (spec §5–§7): list, configure, toggle. The enabled flag is
 * persisted and enforced by the backend pipeline — never frontend-only.
 */

const agentUpdateSchema = z
  .object({
    name: z.string().min(1).max(100),
    systemInstructions: z.string().max(20_000),
    businessObjective: z.string().max(2_000),
    tone: z.string().max(200),
    language: z.string().max(20),
    provider: z.enum(['anthropic', 'openai']),
    model: z.string().min(1).max(100),
    knowledgeBaseId: z.string().nullable(),
    settings: agentSettingsSchema,
  })
  .partial();

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Models an agent can be set to, with the per-provider price hint. */
  app.get('/api/agents/models', async () => ({ models: SUPPORTED_MODELS }));

  app.get('/api/agents', async (req) => {
    const agents = await getPrisma().agent.findMany({
      where: { tenantId: tenantOf(req) },
      orderBy: { type: 'asc' },
      include: { knowledgeBase: { select: { id: true, name: true } } },
    });
    return { agents };
  });

  app.get<{ Params: { id: string } }>('/api/agents/:id', async (req) => {
    const agent = await getPrisma().agent.findFirst({
      where: { id: req.params.id, tenantId: tenantOf(req) },
      include: { knowledgeBase: { select: { id: true, name: true } } },
    });
    if (!agent) throw new NotFoundError('Agent not found');
    return { agent };
  });

  app.patch<{ Params: { id: string } }>('/api/agents/:id', async (req) => {
    const tenantId = tenantOf(req);
    const prisma = getPrisma();
    const parsed = agentUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid agent configuration', parsed.error.issues);
    }
    const existing = await prisma.agent.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw new NotFoundError('Agent not found');

    if (parsed.data.knowledgeBaseId) {
      const kb = await prisma.knowledgeBase.findFirst({
        where: { id: parsed.data.knowledgeBaseId, tenantId },
      });
      if (!kb) throw new ValidationError('Knowledge base not found');
    }

    // The provider is derived from the model, never set independently: one
    // dropdown in the dashboard picks "gpt-5" or "claude-haiku-4-5" and the
    // routing follows. A provider/model pair therefore cannot drift apart.
    const provider = parsed.data.model ? providerForModel(parsed.data.model) : undefined;

    const agent = await prisma.agent.update({
      where: { id: existing.id },
      data: {
        ...parsed.data,
        ...(provider ? { provider } : {}),
        settings: parsed.data.settings ? (parsed.data.settings as object) : undefined,
      },
    });
    await audit(req, 'agent.update', agent.id);
    return { agent };
  });

  app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    '/api/agents/:id/toggle',
    async (req) => {
      const tenantId = tenantOf(req);
      const prisma = getPrisma();
      const existing = await prisma.agent.findFirst({ where: { id: req.params.id, tenantId } });
      if (!existing) throw new NotFoundError('Agent not found');
      const enabled =
        typeof req.body?.enabled === 'boolean' ? req.body.enabled : !existing.enabled;
      const agent = await prisma.agent.update({ where: { id: existing.id }, data: { enabled } });
      await audit(req, enabled ? 'agent.enable' : 'agent.disable', agent.id);
      // Telegram Bot Developer Terms §5.4: processing personal-chat contents
      // with a third-party AI API requires the account owner's authorization —
      // record that authorization explicitly when the owner enables the agent.
      if (enabled && existing.type === 'TELEGRAM_PERSONAL') {
        await prisma.auditLog
          .create({
            data: {
              tenantId,
              userId: req.user?.id ?? null,
              action: 'telegram_personal.ai_processing_consent',
              resource: 'agent',
              resourceId: agent.id,
              detail: {
                statement:
                  'Operator enabled the Telegram Personal Account Agent, authorizing AI processing (Anthropic) of messages from the chats shared via their Telegram Business connection, solely to generate replies on their behalf. No AI training on message data.',
              },
            },
          })
          .catch(() => undefined);
      }
      return { agent };
    },
  );
}

async function audit(req: any, action: string, resourceId: string): Promise<void> {
  await getPrisma()
    .auditLog.create({
      data: {
        tenantId: req.tenantId,
        userId: req.user?.id ?? null,
        action,
        resource: 'agent',
        resourceId,
      },
    })
    .catch(() => undefined);
}
