import { getLogger } from '../lib/logger.js';
import { isRetryable, errorMessage, RateLimitedError } from '../lib/errors.js';
import {
  type EnqueueOptions,
  type JobHandler,
  type JobName,
  type JobPayloads,
  type JobQueue,
  RETRY_ATTEMPTS,
  RETRY_BACKOFF_MS,
} from './types.js';

interface PendingJob {
  name: JobName;
  payload: unknown;
  attempt: number;
  jobId?: string;
}

/**
 * In-process queue with the same retry/backoff semantics as the BullMQ driver.
 * Used when REDIS_URL is not configured (development, small deployments, tests).
 * Durability relies on the Postgres event tables + the startup recovery sweep.
 */
export class InlineQueue implements JobQueue {
  private handlers = new Map<JobName, JobHandler<JobName>>();
  private queue: PendingJob[] = [];
  private pendingIds = new Set<string>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private running = 0;
  private started = false;
  private stopped = false;
  private readonly concurrency: number;
  private idleResolvers: Array<() => void> = [];

  constructor(concurrency = 4) {
    this.concurrency = concurrency;
  }

  registerHandler<N extends JobName>(name: N, handler: JobHandler<N>): void {
    this.handlers.set(name, handler as JobHandler<JobName>);
  }

  async enqueue<N extends JobName>(
    name: N,
    payload: JobPayloads[N],
    opts?: EnqueueOptions,
  ): Promise<void> {
    if (this.stopped) return;
    if (opts?.jobId) {
      if (this.pendingIds.has(opts.jobId)) return;
      this.pendingIds.add(opts.jobId);
    }
    const job: PendingJob = { name, payload, attempt: 0, jobId: opts?.jobId };
    if (opts?.delayMs && opts.delayMs > 0) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.queue.push(job);
        this.pump();
      }, opts.delayMs);
      // Do not hold the process open for a delayed retry alone.
      timer.unref?.();
      this.timers.add(timer);
    } else {
      this.queue.push(job);
      this.pump();
    }
  }

  async start(): Promise<void> {
    this.started = true;
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.queue = [];
    await this.drain();
  }

  /** Wait for all in-flight and queued jobs to finish (test helper). */
  async drain(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0 && this.timers.size === 0) return;
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  private pump(): void {
    if (!this.started || this.stopped) return;
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running += 1;
      void this.run(job).finally(() => {
        this.running -= 1;
        this.pump();
        this.notifyIfIdle();
      });
    }
    this.notifyIfIdle();
  }

  private notifyIfIdle(): void {
    if (this.running === 0 && this.queue.length === 0 && this.timers.size === 0) {
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      for (const r of resolvers) r();
    }
  }

  private async run(job: PendingJob): Promise<void> {
    const log = getLogger().child({ jobName: job.name, attempt: job.attempt + 1 });
    const handler = this.handlers.get(job.name);
    if (!handler) {
      log.error('no handler registered for job');
      return;
    }
    try {
      await handler(job.payload as never);
      if (job.jobId) this.pendingIds.delete(job.jobId);
    } catch (err) {
      const attempt = job.attempt + 1;
      if (attempt < RETRY_ATTEMPTS && isRetryable(err)) {
        // Honor the platform's flood-control hint (Telegram retry_after /
        // Instagram rate limits): retrying earlier is a guaranteed 429.
        const backoff = RETRY_BACKOFF_MS * 2 ** job.attempt;
        const hint = err instanceof RateLimitedError ? (err.retryAfterMs ?? 0) : 0;
        const delayMs = Math.max(backoff, hint);
        log.warn({ err: errorMessage(err), delayMs }, 'job failed; scheduling retry');
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          this.queue.push({ ...job, attempt });
          this.pump();
        }, delayMs);
        timer.unref?.();
        this.timers.add(timer);
      } else {
        if (job.jobId) this.pendingIds.delete(job.jobId);
        log.error({ err: errorMessage(err) }, 'job failed permanently (dead-letter)');
      }
    }
  }
}
