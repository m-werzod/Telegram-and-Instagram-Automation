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
 * Recovery sweep: re-enqueue events that were persisted but never finished —
 * crashes between persist and completion, retries stranded by a restart, or
 * an enqueue that failed after the row was created (P2002 on the platform's
 * webhook retry then ACKs without re-enqueueing). Runs at boot AND on the
 * periodic housekeeping interval, so stuck events recover without a restart.
 */
export async function recoverStuckEvents(): Promise<number> {
  const prisma = getPrisma();
  const now = Date.now();
  const cutoff = new Date(now - 60_000);
  const staleClaimCutoff = new Date(now - 15 * 60_000);

  // Claims from crashed workers: PROCESSING for >15 min is considered stale
  // and reset so it can be atomically re-claimed.
  await prisma.webhookEvent.updateMany({
    where: { status: 'PROCESSING', claimedAt: { lt: staleClaimCutoff } },
    data: { status: 'ENQUEUED' },
  });

  // FAILED is included: inline-queue retry timers are memory-only and a BullMQ
  // retry can be lost with Redis — the sweep is the durable backstop. A FAILED
  // event either succeeds on the re-run or dead-letters via the attempts cap.
  const stuck = await prisma.webhookEvent.findMany({
    where: {
      status: { in: ['RECEIVED', 'ENQUEUED', 'FAILED'] },
      receivedAt: { lt: cutoff },
    },
    select: { id: true },
    take: 500,
    orderBy: { receivedAt: 'asc' },
  });
  for (const e of stuck) {
    // Deliberately NO jobId: BullMQ retains completed/failed jobs by id (24h/7d)
    // and silently ignores an add() reusing one — the atomic PROCESSING claim
    // makes duplicate deliveries harmless instead.
    await getQueue().enqueue('webhook:process', { webhookEventId: e.id });
  }
  return stuck.length;
}

/**
 * Retention: terminal events and old idempotency keys are pruned once the
 * platforms' retry windows (Telegram ≤24h, Meta ≤36h) are far behind. Keeping
 * WebhookEvent bounded also protects the Telegram update_id dedup namespace
 * across the documented ≥1-week-idle id reset. DEAD_LETTER rows are kept for
 * operator visibility.
 */
export async function pruneOldRecords(): Promise<void> {
  const prisma = getPrisma();
  await prisma.webhookEvent.deleteMany({
    where: {
      status: { in: ['PROCESSED', 'SKIPPED'] },
      receivedAt: { lt: new Date(Date.now() - 7 * 24 * 3600_000) },
    },
  });
  await prisma.idempotencyKey.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - 30 * 24 * 3600_000) } },
  });
}
