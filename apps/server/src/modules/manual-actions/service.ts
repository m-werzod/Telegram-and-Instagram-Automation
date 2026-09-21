import { getPrisma } from '../../db/client.js';

/**
 * Manual Action Engine (spec §28): whenever the platform hits something it
 * cannot automate (Meta dashboard steps, DNS, HTTPS exposure, App Review), it
 * records a structured task with the official URL and exact steps. The
 * dashboard surfaces these so the operator always knows exactly what remains.
 */

export interface ManualActionInput {
  dedupKey: string;
  platform: string;
  title: string;
  officialUrl: string;
  steps: string[];
  expectedResult: string;
  whatToReturn: string;
}

export async function upsertManualAction(tenantId: string, input: ManualActionInput): Promise<void> {
  const prisma = getPrisma();
  await prisma.manualAction.upsert({
    where: { tenantId_dedupKey: { tenantId, dedupKey: input.dedupKey } },
    create: {
      tenantId,
      dedupKey: input.dedupKey,
      platform: input.platform,
      title: input.title,
      officialUrl: input.officialUrl,
      steps: input.steps,
      expectedResult: input.expectedResult,
      whatToReturn: input.whatToReturn,
      status: 'PENDING',
    },
    update: {
      platform: input.platform,
      title: input.title,
      officialUrl: input.officialUrl,
      steps: input.steps,
      expectedResult: input.expectedResult,
      whatToReturn: input.whatToReturn,
      // Re-open if it regressed after being marked done.
      status: 'PENDING',
    },
  });
}

/** Mark a manual action DONE when the platform detects the condition is now met. */
export async function resolveManualAction(tenantId: string, dedupKey: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.manualAction.updateMany({
    where: { tenantId, dedupKey, status: 'PENDING' },
    data: { status: 'DONE' },
  });
}
