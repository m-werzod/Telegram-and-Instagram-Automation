import { Prisma } from '@prisma/client';
import { getPrisma } from '../../../db/client.js';

/**
 * One-shot side-effect claims backed by the IdempotencyKey unique constraint
 * (spec §23). Claim BEFORE an unrepeatable send; release ONLY when the send
 * failed with a retryable error so a queue retry can attempt it again.
 */

export async function claimIdempotency(tenantId: string, key: string): Promise<boolean> {
  try {
    await getPrisma().idempotencyKey.create({ data: { tenantId, key } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
    throw err;
  }
}

export async function releaseIdempotency(tenantId: string, key: string): Promise<void> {
  await getPrisma()
    .idempotencyKey.deleteMany({ where: { tenantId, key } })
    .catch(() => undefined);
}
