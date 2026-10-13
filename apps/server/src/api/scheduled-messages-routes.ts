import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../db/client.js';
import { requireAuth, requireAdmin, tenantOf } from './middleware.js';
import {
  createScheduledMessage,
  deleteScheduledMessage,
  listScheduledMessages,
  updateScheduledMessage,
  calculateNextRun,
} from '../modules/telegram-scheduled/service.js';
import { ValidationError } from '../lib/errors.js';

/**
 * Scheduled message management (Telegram channel greetings, etc).
 * Spec §XX — Every morning/evening, automated messages to channel.
 */
export async function scheduledMessagesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // List scheduled messages for tenant
  app.get('/api/scheduled-messages', async (req) => {
    requireAdmin(req);
    const messages = await listScheduledMessages(tenantOf(req));
    return { messages };
  });

  // Get specific scheduled message
  app.get<{ Params: { id: string } }>('/api/scheduled-messages/:id', async (req) => {
    requireAdmin(req);
    const message = await getPrisma().scheduledMessage.findUnique({
      where: { id: req.params.id },
    });
    if (!message || message.tenantId !== tenantOf(req)) {
      throw new ValidationError('Scheduled message not found');
    }
    return { message };
  });

  // Create scheduled message
  app.post<{
    Body: {
      channel: string; // "telegram"
      channelId: string; // Telegram chat_id
      messageTemplate: string;
      cronExpression: string; // "0 8 * * *" for 8 AM daily
      metadata?: Record<string, unknown>;
    };
  }>('/api/scheduled-messages', async (req) => {
    requireAdmin(req);

    const body = z
      .object({
        channel: z.string().min(1),
        channelId: z.string().min(1),
        messageTemplate: z.string().min(1).max(4000),
        cronExpression: z.string().min(1).max(100),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .safeParse(req.body);

    if (!body.success) {
      throw new ValidationError(body.error.issues[0]?.message ?? 'Invalid request');
    }

    // Validate cron expression
    try {
      calculateNextRun(body.data.cronExpression);
    } catch {
      throw new ValidationError('Invalid cron expression (e.g., "0 8 * * *" for 8 AM daily)');
    }

    const message = await createScheduledMessage(
      tenantOf(req),
      body.data.channel,
      body.data.channelId,
      body.data.messageTemplate,
      body.data.cronExpression,
      body.data.metadata,
    );

    return { message };
  });

  // Update scheduled message
  app.put<{
    Params: { id: string };
    Body: {
      messageTemplate?: string;
      cronExpression?: string;
      enabled?: boolean;
      metadata?: Record<string, unknown>;
    };
  }>('/api/scheduled-messages/:id', async (req) => {
    requireAdmin(req);

    const existing = await getPrisma().scheduledMessage.findUnique({
      where: { id: req.params.id },
    });
    if (!existing || existing.tenantId !== tenantOf(req)) {
      throw new ValidationError('Scheduled message not found');
    }

    const body = z
      .object({
        messageTemplate: z.string().min(1).max(4000).optional(),
        cronExpression: z.string().min(1).max(100).optional(),
        enabled: z.boolean().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .safeParse(req.body);

    if (!body.success) {
      throw new ValidationError(body.error.issues[0]?.message ?? 'Invalid request');
    }

    // Validate new cron if provided
    if (body.data.cronExpression) {
      try {
        calculateNextRun(body.data.cronExpression);
      } catch {
        throw new ValidationError('Invalid cron expression');
      }
    }

    const message = await updateScheduledMessage(req.params.id, body.data);
    return { message };
  });

  // Delete scheduled message
  app.delete<{ Params: { id: string } }>('/api/scheduled-messages/:id', async (req) => {
    requireAdmin(req);

    const existing = await getPrisma().scheduledMessage.findUnique({
      where: { id: req.params.id },
    });
    if (!existing || existing.tenantId !== tenantOf(req)) {
      throw new ValidationError('Scheduled message not found');
    }

    await deleteScheduledMessage(req.params.id);
    return { success: true };
  });

  // Test send a scheduled message immediately
  app.post<{ Params: { id: string } }>('/api/scheduled-messages/:id/test-send', async (req) => {
    requireAdmin(req);

    const message = await getPrisma().scheduledMessage.findUnique({
      where: { id: req.params.id },
    });
    if (!message || message.tenantId !== tenantOf(req)) {
      throw new ValidationError('Scheduled message not found');
    }

    // Import and call the job queue directly
    const { getQueue } = await import('../queue/index.js');
    const queue = getQueue();
    await queue.enqueue('scheduled-message:send', { scheduledMessageId: req.params.id });

    return { success: true, message: 'Test send queued' };
  });
}
