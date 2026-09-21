import type { Env } from '../config/env.js';
import { getLogger } from '../lib/logger.js';
import { InlineQueue } from './inline-queue.js';
import type { JobQueue } from './types.js';

export * from './types.js';
export { InlineQueue } from './inline-queue.js';

let queue: JobQueue | null = null;

export async function createQueue(env: Env): Promise<JobQueue> {
  if (env.REDIS_URL) {
    const { BullMqQueue } = await import('./bullmq-queue.js');
    getLogger().info('queue driver: bullmq (redis)');
    queue = new BullMqQueue(env.REDIS_URL);
  } else {
    // Production state must not live in process memory: pending retries on the
    // inline queue die with the process (the sweep is only a coarse backstop).
    if (env.NODE_ENV === 'production' && !env.ALLOW_INLINE_QUEUE) {
      throw new Error(
        'REDIS_URL is required in production (durable queue state). ' +
          'Set REDIS_URL, or set ALLOW_INLINE_QUEUE=true to knowingly run without Redis.',
      );
    }
    getLogger().info('queue driver: inline (no REDIS_URL configured)');
    queue = new InlineQueue();
  }
  return queue;
}

export function getQueue(): JobQueue {
  if (!queue) throw new Error('Queue not initialized');
  return queue;
}

export function setQueueForTesting(q: JobQueue): void {
  queue = q;
}
