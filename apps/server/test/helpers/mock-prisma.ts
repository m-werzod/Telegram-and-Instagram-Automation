import { vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { setPrismaForTesting } from '../../src/db/client.js';

/**
 * Lightweight Prisma mock: every model delegate is a Proxy whose methods are
 * lazily-created vi.fn()s (default resolve: null / [] / count 0). Tests
 * override the methods they care about:
 *
 *   const prisma = mockPrisma();
 *   prisma.agent.findUnique.mockResolvedValue({...});
 */

type AnyFn = ReturnType<typeof vi.fn>;

// Used as types below (finite key unions avoid `| undefined` under noUncheckedIndexedAccess).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const MODEL_METHODS = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
] as const;

export type MockModel = Record<(typeof MODEL_METHODS)[number], AnyFn> & Record<string, AnyFn>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const MODEL_NAMES = [
  'tenant',
  'user',
  'authSession',
  'agent',
  'knowledgeBase',
  'knowledgeDocument',
  'knowledgeChunk',
  'channelConnection',
  'lead',
  'leadIdentity',
  'conversation',
  'conversationMessage',
  'webhookEvent',
  'aIExecution',
  'toolExecution',
  'crmNote',
  'humanHandoff',
  'manualAction',
  'auditLog',
  'idempotencyKey',
] as const;

export type MockPrisma = Record<(typeof MODEL_NAMES)[number], MockModel> & {
  install(): void;
  $queryRaw: AnyFn;
  $executeRaw: AnyFn;
  $queryRawUnsafe: AnyFn;
};

export function mockPrisma(): MockPrisma {
  const models = new Map<string, MockModel>();

  const makeModel = (): MockModel =>
    new Proxy({} as MockModel, {
      get(target, prop: string) {
        if (!(prop in target)) {
          target[prop] = vi.fn().mockImplementation(async () => {
            if (prop === 'findMany') return [];
            if (prop === 'count') return 0;
            if (prop === 'aggregate') return { _avg: {} };
            if (prop.startsWith('update') || prop.startsWith('delete')) return { count: 0 };
            return null;
          });
        }
        return target[prop];
      },
    });

  const rawFns = new Map<string, AnyFn>();

  const root = new Proxy({} as MockPrisma, {
    get(_target, prop: string) {
      if (prop === 'install') {
        return () => setPrismaForTesting(root as unknown as PrismaClient);
      }
      if (prop === '$queryRaw' || prop === '$executeRaw' || prop === '$queryRawUnsafe') {
        if (!rawFns.has(prop)) {
          rawFns.set(prop, vi.fn().mockResolvedValue(prop === '$executeRaw' ? 0 : []));
        }
        return rawFns.get(prop);
      }
      if (prop === '$transaction') {
        return async (arg: unknown) => {
          if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(root);
          return Promise.all(arg as Promise<unknown>[]);
        };
      }
      if (prop === '$disconnect') return async () => undefined;
      if (!models.has(prop)) models.set(prop, makeModel());
      return models.get(prop);
    },
  });

  return root;
}

/** A real Prisma P2002 unique-constraint error (matches `instanceof` checks). */
export function uniqueConstraintError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}
