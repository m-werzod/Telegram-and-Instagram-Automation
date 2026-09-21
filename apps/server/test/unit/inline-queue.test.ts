import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineQueue } from '../../src/queue/inline-queue.js';
import { RETRY_ATTEMPTS, RETRY_BACKOFF_MS } from '../../src/queue/types.js';
import { ValidationError } from '../../src/lib/errors.js';
import { initLogger } from '../../src/lib/logger.js';

type WebhookPayload = { webhookEventId: string };

/** Sleep on the (fake) clock — resolves once timers advance past `ms`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('InlineQueue', () => {
  beforeEach(() => {
    initLogger('silent', false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs the handler for a job enqueued after start()', async () => {
    const queue = new InlineQueue();
    const handler = vi.fn(async (_p: WebhookPayload) => {});
    queue.registerHandler('webhook:process', handler);
    await queue.start();

    await queue.enqueue('webhook:process', { webhookEventId: 'evt-1' });
    await queue.drain();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ webhookEventId: 'evt-1' });
  });

  it('jobs enqueued before start() only run once start() is called', async () => {
    const queue = new InlineQueue();
    const handler = vi.fn(async (_p: WebhookPayload) => {});
    queue.registerHandler('webhook:process', handler);

    await queue.enqueue('webhook:process', { webhookEventId: 'evt-early' });
    // Flush any microtasks/timers — nothing may run before start().
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handler).not.toHaveBeenCalled();

    await queue.start();
    await queue.drain();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ webhookEventId: 'evt-early' });
  });

  it('drain() resolves immediately when the queue is idle', async () => {
    const queue = new InlineQueue();
    // Never started, nothing enqueued — must not hang.
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it('dedups by jobId: enqueueing the same id twice while pending runs the handler once', async () => {
    const queue = new InlineQueue();
    const handler = vi.fn(async (_p: WebhookPayload) => {});
    queue.registerHandler('webhook:process', handler);

    // Both enqueued before start() — the job is pending for the whole window.
    await queue.enqueue('webhook:process', { webhookEventId: 'evt-1' }, { jobId: 'job-1' });
    await queue.enqueue('webhook:process', { webhookEventId: 'evt-1-dup' }, { jobId: 'job-1' });

    await queue.start();
    await queue.drain();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ webhookEventId: 'evt-1' });
  });

  it('dedups by jobId while the job is actively running', async () => {
    const queue = new InlineQueue();
    const handler = vi.fn(async (_p: WebhookPayload) => {
      await sleep(50);
    });
    queue.registerHandler('webhook:process', handler);
    await queue.start();

    await queue.enqueue('webhook:process', { webhookEventId: 'evt-1' }, { jobId: 'job-1' });
    await vi.advanceTimersByTimeAsync(0); // handler has started, is mid-flight
    expect(handler).toHaveBeenCalledTimes(1);

    await queue.enqueue('webhook:process', { webhookEventId: 'evt-dup' }, { jobId: 'job-1' });
    await vi.advanceTimersByTimeAsync(100);
    await queue.drain();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('allows re-enqueueing the same jobId after the job completed', async () => {
    const queue = new InlineQueue();
    const handler = vi.fn(async (_p: WebhookPayload) => {});
    queue.registerHandler('webhook:process', handler);
    await queue.start();

    await queue.enqueue('webhook:process', { webhookEventId: 'evt-1' }, { jobId: 'job-1' });
    await queue.drain();
    expect(handler).toHaveBeenCalledTimes(1);

    await queue.enqueue('webhook:process', { webhookEventId: 'evt-2' }, { jobId: 'job-1' });
    await queue.drain();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith({ webhookEventId: 'evt-2' });
  });

  it('honors delayMs: the job does not run until the delay elapses', async () => {
    const queue = new InlineQueue();
    const handler = vi.fn(async (_p: WebhookPayload) => {});
    queue.registerHandler('webhook:process', handler);
    await queue.start();

    await queue.enqueue('webhook:process', { webhookEventId: 'evt-1' }, { delayMs: 5_000 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await queue.drain();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure after the backoff, then succeeds', async () => {
    const queue = new InlineQueue();
    const handler = vi
      .fn(async (_p: WebhookPayload) => {})
      .mockRejectedValueOnce(new Error('transient network blip'));
    queue.registerHandler('webhook:process', handler);
    await queue.start();

    await queue.enqueue('webhook:process', { webhookEventId: 'evt-1' });
    await vi.advanceTimersByTimeAsync(0); // first attempt fails
    expect(handler).toHaveBeenCalledTimes(1);

    // Not retried before the backoff window (3s base) elapses.
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS - 1);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await queue.drain();
    expect(handler).toHaveBeenCalledTimes(2);
    // Same payload on the retry.
    expect(handler).toHaveBeenNthCalledWith(2, { webhookEventId: 'evt-1' });
  });

  it('backs off exponentially: the second retry waits twice the base delay', async () => {
    const queue = new InlineQueue();
    const handler = vi
      .fn(async (_p: WebhookPayload) => {})
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'));
    queue.registerHandler('webhook:process', handler);
    await queue.start();

    await queue.enqueue('webhook:process', { webhookEventId: 'evt-1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS); // attempt 2 fires and fails
    expect(handler).toHaveBeenCalledTimes(2);

    // Second retry is scheduled at 2x base — not fired at 2x-1ms after attempt 2.
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS * 2 - 1);
    expect(handler).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await queue.drain();
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-retryable AppError (ValidationError)', async () => {
    const queue = new InlineQueue();
    const handler = vi
      .fn(async (_p: WebhookPayload) => {})
      .mockRejectedValue(new ValidationError('bad payload'));
    queue.registerHandler('webhook:process', handler);
    await queue.start();

    await queue.enqueue('webhook:process', { webhookEventId: 'evt-1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);

    // Even far beyond every possible backoff window, no retry happens.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it('drops the job after RETRY_ATTEMPTS retryable failures (dead-letter)', async () => {
    const queue = new InlineQueue();
    const handler = vi
      .fn(async (_p: WebhookPayload) => {})
      .mockRejectedValue(new Error('always failing'));
    queue.registerHandler('webhook:process', handler);
    await queue.start();

    await queue.enqueue('webhook:process', { webhookEventId: 'evt-1' });
    // Total backoff: 3s + 6s + 12s + 24s = 45s; advance well past it.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await queue.drain();

    expect(handler).toHaveBeenCalledTimes(RETRY_ATTEMPTS);
  });

  it('frees the jobId after a permanent failure so the job can be enqueued again', async () => {
    const queue = new InlineQueue();
    const handler = vi
      .fn(async (_p: WebhookPayload) => {})
      .mockRejectedValueOnce(new ValidationError('bad payload'));
    queue.registerHandler('webhook:process', handler);
    await queue.start();

    await queue.enqueue('webhook:process', { webhookEventId: 'evt-1' }, { jobId: 'job-1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);

    // Dead-lettered → id released → a fresh enqueue with the same id runs.
    await queue.enqueue('webhook:process', { webhookEventId: 'evt-1-again' }, { jobId: 'job-1' });
    await queue.drain();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith({ webhookEventId: 'evt-1-again' });
  });

  it('respects concurrency 1: two slow jobs run strictly sequentially', async () => {
    const queue = new InlineQueue(1);
    const log: string[] = [];
    queue.registerHandler('webhook:process', async (p: WebhookPayload) => {
      log.push(`${p.webhookEventId}:start`);
      await sleep(50);
      log.push(`${p.webhookEventId}:end`);
    });
    await queue.start();

    await queue.enqueue('webhook:process', { webhookEventId: 'a' });
    await queue.enqueue('webhook:process', { webhookEventId: 'b' });

    await vi.advanceTimersByTimeAsync(0);
    // Only the first job may have started.
    expect(log).toEqual(['a:start']);

    await vi.advanceTimersByTimeAsync(200);
    await queue.drain();
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('runs jobs in parallel up to the concurrency limit', async () => {
    const queue = new InlineQueue(2);
    const log: string[] = [];
    queue.registerHandler('webhook:process', async (p: WebhookPayload) => {
      log.push(`${p.webhookEventId}:start`);
      await sleep(50);
      log.push(`${p.webhookEventId}:end`);
    });
    await queue.start();

    await queue.enqueue('webhook:process', { webhookEventId: 'a' });
    await queue.enqueue('webhook:process', { webhookEventId: 'b' });
    await queue.enqueue('webhook:process', { webhookEventId: 'c' });

    await vi.advanceTimersByTimeAsync(0);
    // Both slots busy; the third job waits.
    expect(log).toEqual(['a:start', 'b:start']);

    await vi.advanceTimersByTimeAsync(200);
    await queue.drain();
    expect(log).toHaveLength(6);
    // a and b ran in parallel; c only started once a slot freed up (after a:end).
    expect(log.slice(0, 2)).toEqual(['a:start', 'b:start']);
    expect(log.indexOf('c:start')).toBeGreaterThan(log.indexOf('a:end'));
    expect(log.indexOf('c:end')).toBeGreaterThan(log.indexOf('c:start'));
  });

  it('enqueue after stop() is a no-op', async () => {
    const queue = new InlineQueue();
    const handler = vi.fn(async (_p: WebhookPayload) => {});
    queue.registerHandler('webhook:process', handler);
    await queue.start();
    await queue.stop();

    await queue.enqueue('webhook:process', { webhookEventId: 'evt-late' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handler).not.toHaveBeenCalled();
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it('stop() cancels pending delayed jobs', async () => {
    const queue = new InlineQueue();
    const handler = vi.fn(async (_p: WebhookPayload) => {});
    queue.registerHandler('webhook:process', handler);
    await queue.start();

    await queue.enqueue('webhook:process', { webhookEventId: 'evt-1' }, { delayMs: 5_000 });
    await queue.stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler).not.toHaveBeenCalled();
  });

  it('a job with no registered handler completes (drain does not wedge)', async () => {
    const queue = new InlineQueue();
    await queue.start();
    await queue.enqueue('webhook:process', { webhookEventId: 'evt-orphan' });
    // Must resolve rather than hang, even though no handler exists.
    await expect(queue.drain()).resolves.toBeUndefined();
  });
});
