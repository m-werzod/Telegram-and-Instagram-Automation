import { Prisma, type ScheduledMessage as DbScheduledMessage } from '@prisma/client';
import { getPrisma } from '../../db/client.js';
import { getTelegramClient } from '../channels/telegram/service.js';
import { childLogger } from '../../lib/logger.js';
import parser from 'cron-parser';

const log = childLogger({ module: 'telegram-scheduled' });

/**
 * Send a scheduled message to a Telegram channel (or chat).
 * Updates the next run time based on the cron expression.
 */
export async function sendScheduledMessage(scheduledMessageId: string): Promise<void> {
  const prisma = getPrisma();
  const scheduled = await prisma.scheduledMessage.findUnique({ where: { id: scheduledMessageId } });

  if (!scheduled || !scheduled.enabled) {
    log.debug(`Scheduled message ${scheduledMessageId} not found or disabled`);
    return;
  }

  const connection = await prisma.channelConnection.findUnique({
    where: { tenantId_channel: { tenantId: scheduled.tenantId, channel: 'TELEGRAM' } },
  });

  if (!connection || connection.status !== 'connected') {
    log.error(`Telegram connection not found for tenant ${scheduled.tenantId}`);
    return;
  }

  try {
    const client = getTelegramClient(connection);
    const chatId = scheduled.channelId;
    const messageText = scheduled.messageTemplate;

    // Send message to Telegram
    await client.sendMessage(chatId, messageText);
    log.info(`Scheduled message sent to chat ${chatId}: ${messageText}`);

    // Update last run time and calculate next run
    const nextRun = calculateNextRun(scheduled.cronExpression);
    await prisma.scheduledMessage.update({
      where: { id: scheduledMessageId },
      data: {
        lastRunAt: new Date(),
        nextRunAt: nextRun,
        runsCount: { increment: 1 },
      },
    });
  } catch (err) {
    log.error(`Failed to send scheduled message ${scheduledMessageId}: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/**
 * Calculate the next run time for a cron expression.
 */
export function calculateNextRun(cronExpression: string): Date {
  try {
    const interval = parser.parseExpression(cronExpression);
    return interval.next().toDate();
  } catch (err) {
    log.error(`Invalid cron expression: ${cronExpression} - ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/**
 * Create a scheduled message (usually morning & evening greetings).
 */
export async function createScheduledMessage(
  tenantId: string,
  channel: string, // "telegram"
  channelId: string, // Telegram chat_id (can be negative for channels)
  messageTemplate: string,
  cronExpression: string, // "0 8 * * *" for 8 AM
  metadata?: Record<string, unknown>,
): Promise<DbScheduledMessage> {
  const prisma = getPrisma();
  const nextRun = calculateNextRun(cronExpression);

  return prisma.scheduledMessage.create({
    data: {
      tenantId,
      channel,
      channelId,
      messageTemplate,
      cronExpression,
      nextRunAt: nextRun,
      metadata: (metadata || {}) as Prisma.InputJsonObject,
      enabled: true,
    },
  });
}

/**
 * List all scheduled messages for a tenant.
 */
export async function listScheduledMessages(tenantId: string, channel?: string): Promise<DbScheduledMessage[]> {
  const prisma = getPrisma();
  return prisma.scheduledMessage.findMany({
    where: {
      tenantId,
      ...(channel ? { channel } : {}),
    },
    orderBy: { nextRunAt: 'asc' },
  });
}

/**
 * Update a scheduled message.
 */
export async function updateScheduledMessage(
  id: string,
  updates: Partial<{
    messageTemplate: string;
    cronExpression: string;
    enabled: boolean;
    metadata: Record<string, unknown>;
  }>,
): Promise<DbScheduledMessage> {
  const prisma = getPrisma();
  const { metadata, ...rest } = updates;
  
  // If cron expression changed, recalculate next run
  const nextRunAt =
    updates.cronExpression
      ? calculateNextRun(updates.cronExpression)
      : undefined;

  return prisma.scheduledMessage.update({
    where: { id },
    data: {
      ...rest,
      ...(metadata ? { metadata: metadata as Prisma.InputJsonObject } : {}),
      ...(nextRunAt ? { nextRunAt } : {}),
    },
  });
}

/**
 * Delete a scheduled message.
 */
export async function deleteScheduledMessage(id: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.scheduledMessage.delete({ where: { id } });
}

/**
 * Find all messages that are due to run now (or overdue).
 * Called by the housekeeping loop.
 */
export async function findDueScheduledMessages(): Promise<DbScheduledMessage[]> {
  const prisma = getPrisma();
  const now = new Date();
  
  return prisma.scheduledMessage.findMany({
    where: {
      enabled: true,
      nextRunAt: {
        lte: now, // Due now or in the past
      },
    },
    orderBy: { nextRunAt: 'asc' },
  });
}
