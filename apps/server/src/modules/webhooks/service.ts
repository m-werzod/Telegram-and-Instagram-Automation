import { Prisma, type Channel, type WebhookEvent } from '@prisma/client';
import { getPrisma } from '../../db/client.js';
import { getQueue } from '../../queue/index.js';

/**
 * Durable inbound events (spec §23, §54): every webhook is persisted BEFORE any
 * processing, deduplicated on (channel, eventKey), then processed async. A
 * crash between persist and process is recovered by the startup sweep.
 */

export async function recordAndEnqueueEvent(params: {
  channel: Channel;
  eventKey: string;
  tenantId: string | null;
  payload: unknown;
}): Promise<{ event: WebhookEvent | null; duplicate: boolean }> {
  const prisma = getPrisma();
  let event: WebhookEvent;
  try {
    event = await prisma.webhookEvent.create({
      data: {
        channel: params.channel,
        eventKey: params.eventKey,
        tenantId: params.tenantId,
        payload: params.payload as Prisma.InputJsonValue,
        status: 'RECEIVED',
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { event: null, duplicate: true }; // webhook retry — already handled
    }
    throw err;
  }

  // Mark ENQUEUED before enqueueing: the inline queue may process the job
  // synchronously-fast, and a late status write would clobber PROCESSED.
  await prisma.webhookEvent.update({ where: { id: event.id }, data: { status: 'ENQUEUED' } });
  await getQueue().enqueue('webhook:process', { webhookEventId: event.id }, { jobId: event.id });
  return { event, duplicate: false };
}

/**
 * Startup recovery sweep: re-enqueue events that were persisted but never
 * finished (crash between persist and completion). Runs once at boot.
 */
export async function recoverStuckEvents(): Promise<number> {
  const prisma = getPrisma();
  const cutoff = new Date(Date.now() - 60_000);
  const stuck = await prisma.webhookEvent.findMany({
    where: { status: { in: ['RECEIVED', 'ENQUEUED'] }, receivedAt: { lt: cutoff } },
    select: { id: true },
    take: 500,
    orderBy: { receivedAt: 'asc' },
  });
  for (const e of stuck) {
    await getQueue().enqueue('webhook:process', { webhookEventId: e.id }, { jobId: e.id });
  }
  return stuck.length;
}
