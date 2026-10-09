import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../db/client.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { adminOnly, requireAdmin, requireAuth, tenantOf } from './middleware.js';

/**
 * Management of PERSONAL Telegram accounts connected to the bot via Telegram
 * Business (Settings → Chat Automation). Each connected account has its own
 * admin controls: enable toggle, instructions, knowledge base — everything the
 * admin configures for the default personal agent can be set per account.
 */

const accountPatchSchema = z
  .object({
    enabled: z.boolean(),
    displayName: z.string().max(120),
    instructions: z.string().max(20_000).nullable(),
    knowledgeBaseId: z.string().nullable(),
  })
  .partial();

const PUBLIC_SELECT = {
  id: true,
  businessConnectionId: true,
  ownerUserId: true,
  ownerName: true,
  ownerUsername: true,
  isEnabled: true,
  canReply: true,
  canReadMessages: true,
  connectedAt: true,
  enabled: true,
  displayName: true,
  instructions: true,
  knowledgeBaseId: true,
  knowledgeBase: { select: { id: true, name: true } },
  createdAt: true,
  updatedAt: true,
} as const;

export async function telegramPersonalRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', adminOnly);

  app.get('/api/telegram-personal-accounts', async (req) => {
    const accounts = await getPrisma().telegramPersonalAccount.findMany({
      where: { tenantId: tenantOf(req) },
      orderBy: { createdAt: 'asc' },
      select: PUBLIC_SELECT,
    });
    return { accounts };
  });

  app.patch<{ Params: { id: string } }>('/api/telegram-personal-accounts/:id', async (req) => {
    requireAdmin(req);
    const tenantId = tenantOf(req);
    const prisma = getPrisma();
    const parsed = accountPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid account update', parsed.error.issues);

    const existing = await prisma.telegramPersonalAccount.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!existing) throw new NotFoundError('Personal account not found');

    if (parsed.data.knowledgeBaseId) {
      const kb = await prisma.knowledgeBase.findFirst({
        where: { id: parsed.data.knowledgeBaseId, tenantId },
      });
      if (!kb) throw new ValidationError('Knowledge base not found');
    }

    const account = await prisma.telegramPersonalAccount.update({
      where: { id: existing.id },
      data: parsed.data,
      select: PUBLIC_SELECT,
    });

    // Telegram Bot Developer Terms §5.4: record the owner-authorized consent
    // for AI processing of this account's shared chats when enabling.
    if (parsed.data.enabled === true && !existing.enabled) {
      await prisma.auditLog
        .create({
          data: {
            tenantId,
            userId: req.user?.id ?? null,
            action: 'telegram_personal.account_ai_processing_consent',
            resource: 'telegram_personal_account',
            resourceId: existing.id,
            detail: {
              businessConnectionId: existing.businessConnectionId,
              owner: existing.ownerUsername ?? existing.ownerName,
              statement:
                'Operator enabled automation for this connected personal Telegram account, authorizing AI processing (Anthropic) of messages from the chats its owner shared via Telegram Business, solely to generate replies on their behalf. No AI training on message data.',
            },
          },
        })
        .catch(() => undefined);
    }
    return { account };
  });

  app.delete<{ Params: { id: string } }>('/api/telegram-personal-accounts/:id', async (req) => {
    requireAdmin(req);
    const prisma = getPrisma();
    const existing = await prisma.telegramPersonalAccount.findFirst({
      where: { id: req.params.id, tenantId: tenantOf(req) },
    });
    if (!existing) throw new NotFoundError('Personal account not found');
    await prisma.telegramPersonalAccount.delete({ where: { id: existing.id } });
    return {
      ok: true,
      note: 'Removed from the platform. The owner should also disconnect the bot in Telegram: Settings → Chat Automation.',
    };
  });
}
