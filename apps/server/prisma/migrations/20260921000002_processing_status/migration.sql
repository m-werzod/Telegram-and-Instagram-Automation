-- PROCESSING marks an event atomically claimed by a worker, so concurrent
-- deliveries (BullMQ at-least-once, recovery sweep) can never double-process.
ALTER TYPE "WebhookEventStatus" ADD VALUE 'PROCESSING' BEFORE 'PROCESSED';

-- Claim timestamp: lets the recovery sweep reset claims from crashed workers.
ALTER TABLE "WebhookEvent" ADD COLUMN "claimedAt" TIMESTAMP(3);
