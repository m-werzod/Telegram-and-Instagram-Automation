import { getPrisma } from '../db/client.js';
import { errorMessage, isRetryable } from '../lib/errors.js';
import { childLogger } from '../lib/logger.js';
import type { JobQueue } from '../queue/types.js';

/**
 * Queue workers. `webhook:process` routes persisted events to the channel
 * handlers; `knowledge:ingest` runs the document pipeline. Failures follow the
 * queue retry policy; exhausted/non-retryable events land in DEAD_LETTER with
 * the error preserved (spec §33).
 */
export function registerWorkers(queue: JobQueue): void {
  queue.registerHandler('webhook:process', async ({ webhookEventId }) => {
    const prisma = getPrisma();
    const event = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
    if (!event) return;
    if (event.status === 'PROCESSED' || event.status === 'SKIPPED' || event.status === 'DEAD_LETTER') {
      return; // already handled (retry-safe)
    }

    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { attempts: { increment: 1 } },
    });

    try {
      if (event.channel === 'TELEGRAM') {
        const { processTelegramEvent } = await import('../modules/channels/telegram/handler.js');
        await processTelegramEvent(event);
      } else {
        const { processInstagramEvent } = await import('../modules/channels/instagram/handler.js');
        await processInstagramEvent(event);
      }
    } catch (err) {
      const attempts = event.attempts + 1;
      const final = !isRetryable(err) || attempts >= 5;
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          status: final ? 'DEAD_LETTER' : 'FAILED',
          error: errorMessage(err).slice(0, 1000),
          processedAt: final ? new Date() : null,
        },
      });
      childLogger({ module: 'worker', webhookEventId }).error(
        { err: errorMessage(err), attempts, final },
        'webhook event processing failed',
      );
      if (!final) throw err; // let the queue retry with backoff
    }
  });

  queue.registerHandler('knowledge:ingest', async ({ documentId, tenantId }) => {
    const { ingestDocument } = await import('../modules/knowledge/service.js');
    await ingestDocument(documentId, tenantId);
  });
}
