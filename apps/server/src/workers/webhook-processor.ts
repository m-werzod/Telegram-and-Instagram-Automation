import { getPrisma } from '../db/client.js';
import { errorMessage, isRetryable } from '../lib/errors.js';
import { childLogger } from '../lib/logger.js';
import { RETRY_ATTEMPTS, type JobQueue } from '../queue/types.js';

/**
 * Queue workers. `webhook:process` routes persisted events to the channel
 * handlers; `knowledge:ingest` runs the document pipeline. Failures follow the
 * queue retry policy; exhausted/non-retryable events land in DEAD_LETTER with
 * the error preserved (spec §33).
 *
 * Processing starts with an ATOMIC claim (status → PROCESSING via a guarded
 * updateMany), so at-least-once delivery (BullMQ redelivery, the recovery
 * sweep, concurrent workers) can never run the same event twice in parallel.
 */
export function registerWorkers(queue: JobQueue): void {
  queue.registerHandler('webhook:process', async ({ webhookEventId }) => {
    const prisma = getPrisma();

    const claimed = await prisma.webhookEvent.updateMany({
      where: { id: webhookEventId, status: { in: ['RECEIVED', 'ENQUEUED', 'FAILED'] } },
      data: { status: 'PROCESSING', claimedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return; // already processed, in flight, or dead-lettered

    const event = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
    if (!event) return;

    try {
      if (event.channel === 'TELEGRAM') {
        const { processTelegramEvent } = await import('../modules/channels/telegram/handler.js');
        await processTelegramEvent(event);
      } else {
        const { processInstagramEvent } = await import('../modules/channels/instagram/handler.js');
        await processInstagramEvent(event);
      }
    } catch (err) {
      // event.attempts is the post-claim (current) attempt count.
      const final = !isRetryable(err) || event.attempts >= RETRY_ATTEMPTS;
      await prisma.webhookEvent
        .update({
          where: { id: event.id },
          data: {
            status: final ? 'DEAD_LETTER' : 'FAILED',
            error: errorMessage(err).slice(0, 1000),
            processedAt: final ? new Date() : null,
          },
        })
        .catch(() => undefined);
      childLogger({ module: 'worker', webhookEventId }).error(
        { err: errorMessage(err), attempts: event.attempts, final },
        'webhook event processing failed',
      );
      if (!final) throw err; // let the queue retry with backoff (retry_after-aware)
    }
  });

  queue.registerHandler('knowledge:ingest', async ({ documentId, tenantId }) => {
    const { ingestDocument } = await import('../modules/knowledge/service.js');
    await ingestDocument(documentId, tenantId);
  });
}
