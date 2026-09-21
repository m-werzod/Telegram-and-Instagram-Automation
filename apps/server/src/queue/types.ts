/**
 * Queue abstraction. Webhooks persist events first, then enqueue a job and
 * acknowledge immediately; workers do the expensive AI/external-API work.
 *
 * Drivers:
 *  - BullMQ (Redis)  — production: durable, distributed, delayed retries.
 *  - Inline          — development/tests: in-process with the same retry semantics.
 *
 * Either way, inbound events are durable in Postgres (WebhookEvent) before any
 * job runs, and a startup recovery sweep re-enqueues stuck events, so a crash
 * never loses data.
 */

export interface JobPayloads {
  'webhook:process': { webhookEventId: string };
  'knowledge:ingest': { documentId: string; tenantId: string };
}

export type JobName = keyof JobPayloads;

export type JobHandler<N extends JobName> = (payload: JobPayloads[N]) => Promise<void>;

export interface EnqueueOptions {
  /** Delay before first attempt, in ms. */
  delayMs?: number;
  /** Stable id — enqueueing the same id twice while pending is a no-op (queue-level dedup). */
  jobId?: string;
}

export interface JobQueue {
  enqueue<N extends JobName>(name: N, payload: JobPayloads[N], opts?: EnqueueOptions): Promise<void>;
  registerHandler<N extends JobName>(name: N, handler: JobHandler<N>): void;
  /** Begin processing jobs (after all handlers are registered). */
  start(): Promise<void>;
  /** Graceful shutdown: stop accepting, wait for in-flight jobs. */
  stop(): Promise<void>;
}

export const RETRY_ATTEMPTS = 5;
export const RETRY_BACKOFF_MS = 3_000; // exponential base: 3s, 6s, 12s, 24s, 48s
