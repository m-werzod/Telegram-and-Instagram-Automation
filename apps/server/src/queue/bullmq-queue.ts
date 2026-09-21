import { Queue, Worker, UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { getLogger } from '../lib/logger.js';
import { isRetryable, errorMessage } from '../lib/errors.js';
import {
  type EnqueueOptions,
  type JobHandler,
  type JobName,
  type JobPayloads,
  type JobQueue,
  RETRY_ATTEMPTS,
  RETRY_BACKOFF_MS,
} from './types.js';

const QUEUE_NAME = 'platform-jobs';

/**
 * BullMQ driver (Redis). Durable jobs, exponential backoff, dead-letter via
 * BullMQ's failed set. Non-retryable application errors are converted to
 * UnrecoverableError so BullMQ fails them immediately instead of retrying.
 */
export class BullMqQueue implements JobQueue {
  private readonly connection: Redis;
  private readonly queue: Queue;
  private worker: Worker | null = null;
  private handlers = new Map<JobName, JobHandler<JobName>>();

  constructor(redisUrl: string) {
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: RETRY_ATTEMPTS,
        backoff: { type: 'exponential', delay: RETRY_BACKOFF_MS },
        removeOnComplete: { age: 24 * 3600, count: 5000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }

  registerHandler<N extends JobName>(name: N, handler: JobHandler<N>): void {
    this.handlers.set(name, handler as JobHandler<JobName>);
  }

  async enqueue<N extends JobName>(
    name: N,
    payload: JobPayloads[N],
    opts?: EnqueueOptions,
  ): Promise<void> {
    await this.queue.add(name, payload, {
      delay: opts?.delayMs,
      ...(opts?.jobId ? { jobId: opts.jobId } : {}),
    });
  }

  async start(): Promise<void> {
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const handler = this.handlers.get(job.name as JobName);
        if (!handler) {
          getLogger().error({ jobName: job.name }, 'no handler registered for job');
          return;
        }
        try {
          await handler(job.data as never);
        } catch (err) {
          if (!isRetryable(err)) {
            throw new UnrecoverableError(errorMessage(err));
          }
          throw err;
        }
      },
      { connection: this.connection, concurrency: 8 },
    );
    this.worker.on('failed', (job, err) => {
      getLogger().error(
        { jobName: job?.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message },
        'job failed',
      );
    });
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    this.connection.disconnect();
  }
}
