import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lead, LeadIdentity } from '@prisma/client';
import {
  findOrCreateLead,
  mergeLeads,
  updateLeadFields,
} from '../../src/modules/crm/service.js';
import { NotFoundError, ValidationError } from '../../src/lib/errors.js';
import { makeTestEnv } from '../helpers/test-env.js';
import { mockPrisma, uniqueConstraintError } from '../helpers/mock-prisma.js';
import { initLogger } from '../../src/lib/logger.js';

type MockFn = ReturnType<typeof vi.fn>;

/** Typed view of the mockPrisma proxy for the models the CRM service touches. */
interface CrmMocks {
  leadIdentity: { findUnique: MockFn; update: MockFn; updateMany: MockFn };
  lead: { findUnique: MockFn; findFirst: MockFn; create: MockFn; update: MockFn };
  conversation: { updateMany: MockFn };
  crmNote: { updateMany: MockFn };
  humanHandoff: { updateMany: MockFn };
}

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1',
    tenantId: 'tenant-1',
    source: 'TELEGRAM',
    name: null,
    username: 'testuser',
    phone: null,
    email: null,
    language: null,
    intent: null,
    status: 'NEW',
    score: 0,
    tags: [],
    assignedToUserId: null,
    qualification: {},
    mergedIntoId: null,
    lastInteractionAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as Lead;
}

function makeIdentity(
  lead: Lead,
  overrides: Partial<LeadIdentity> = {},
): LeadIdentity & { lead: Lead } {
  return {
    id: 'identity-1',
    tenantId: lead.tenantId,
    leadId: lead.id,
    channel: 'TELEGRAM',
    externalId: 'ext-1',
    username: 'testuser',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
    lead,
  } as LeadIdentity & { lead: Lead };
}

const identityRef = { channel: 'TELEGRAM' as const, externalId: 'ext-1', username: 'testuser' };

/** First positional argument of the nth call to a mock. */
function callArg(fn: MockFn, n = 0): Record<string, any> {
  const call = fn.mock.calls[n];
  expect(call).toBeDefined();
  return call![0] as Record<string, any>;
}

describe('crm service', () => {
  let db: CrmMocks;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    const prisma = mockPrisma();
    prisma.install();
    db = prisma as unknown as CrmMocks;
  });

  describe('findOrCreateLead', () => {
    it('returns the existing lead when the identity is already known', async () => {
      const lead = makeLead();
      db.leadIdentity.findUnique.mockResolvedValue(makeIdentity(lead));

      const result = await findOrCreateLead('tenant-1', identityRef, { source: 'TELEGRAM' });

      expect(result).toEqual(lead);
      expect(db.leadIdentity.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId_channel_externalId: {
              tenantId: 'tenant-1',
              channel: 'TELEGRAM',
              externalId: 'ext-1',
            },
          },
        }),
      );
      expect(db.lead.create).not.toHaveBeenCalled();
      expect(db.leadIdentity.update).not.toHaveBeenCalled();
    });

    it('updates the stored username when the incoming one differs', async () => {
      const lead = makeLead();
      db.leadIdentity.findUnique.mockResolvedValue(makeIdentity(lead, { username: 'old-name' }));

      const result = await findOrCreateLead(
        'tenant-1',
        { ...identityRef, username: 'new-name' },
        { source: 'TELEGRAM' },
      );

      expect(result).toEqual(lead);
      expect(db.leadIdentity.update).toHaveBeenCalledWith({
        where: { id: 'identity-1' },
        data: { username: 'new-name' },
      });
    });

    it('follows the merge chain to the surviving lead', async () => {
      const mergedAway = makeLead({ id: 'lead-old', mergedIntoId: 'lead-survivor' });
      const survivor = makeLead({ id: 'lead-survivor' });
      db.leadIdentity.findUnique.mockResolvedValue(makeIdentity(mergedAway));
      db.lead.findUnique.mockResolvedValue(survivor);

      const result = await findOrCreateLead('tenant-1', identityRef, { source: 'TELEGRAM' });

      expect(result).toEqual(survivor);
      expect(db.lead.findUnique).toHaveBeenCalledWith({ where: { id: 'lead-survivor' } });
    });

    it('creates a new lead with a nested identity when nothing exists', async () => {
      const created = makeLead({ id: 'lead-new', name: 'Alice' });
      db.leadIdentity.findUnique.mockResolvedValue(null);
      db.lead.create.mockResolvedValue(created);

      const result = await findOrCreateLead('tenant-1', identityRef, {
        name: 'Alice',
        source: 'TELEGRAM',
      });

      expect(result).toEqual(created);
      expect(db.lead.create).toHaveBeenCalledTimes(1);
      const args = callArg(db.lead.create);
      expect(args.data).toMatchObject({
        tenantId: 'tenant-1',
        source: 'TELEGRAM',
        name: 'Alice',
        username: 'testuser',
        status: 'NEW',
        identities: {
          create: {
            tenantId: 'tenant-1',
            channel: 'TELEGRAM',
            externalId: 'ext-1',
            username: 'testuser',
          },
        },
      });
      expect(args.data.lastInteractionAt).toBeInstanceOf(Date);
    });

    it('recovers from a unique-constraint race by re-reading the identity', async () => {
      const raceWinner = makeLead({ id: 'lead-race' });
      db.leadIdentity.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeIdentity(raceWinner, { leadId: raceWinner.id }));
      db.lead.create.mockRejectedValue(uniqueConstraintError());

      const result = await findOrCreateLead('tenant-1', identityRef, { source: 'TELEGRAM' });

      expect(result).toEqual(raceWinner);
      expect(db.leadIdentity.findUnique).toHaveBeenCalledTimes(2);
    });

    it('rethrows a P2002 race when the retry lookup still finds nothing', async () => {
      db.leadIdentity.findUnique.mockResolvedValue(null);
      db.lead.create.mockRejectedValue(uniqueConstraintError());

      await expect(
        findOrCreateLead('tenant-1', identityRef, { source: 'TELEGRAM' }),
      ).rejects.toThrow('Unique constraint failed');
    });

    it('rethrows non-P2002 create failures without retrying', async () => {
      db.leadIdentity.findUnique.mockResolvedValue(null);
      db.lead.create.mockRejectedValue(new Error('db down'));

      await expect(
        findOrCreateLead('tenant-1', identityRef, { source: 'TELEGRAM' }),
      ).rejects.toThrow('db down');
      expect(db.leadIdentity.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateLeadFields', () => {
    it('throws NotFoundError when the lead does not exist for the tenant', async () => {
      db.lead.findFirst.mockResolvedValue(null);

      await expect(updateLeadFields('tenant-1', 'missing', { name: 'X' })).rejects.toThrow(
        NotFoundError,
      );
      expect(db.lead.update).not.toHaveBeenCalled();
    });

    it('fills name only when the lead has none', async () => {
      const lead = makeLead({ name: null });
      db.lead.findFirst.mockResolvedValue(lead);
      db.lead.update.mockResolvedValue(lead);

      await updateLeadFields('tenant-1', 'lead-1', { name: 'Alice' });

      const args = callArg(db.lead.update);
      expect(args.where).toEqual({ id: 'lead-1' });
      expect(args.data.name).toBe('Alice');
    });

    it('never overwrites an existing name', async () => {
      const lead = makeLead({ name: 'Operator-set name' });
      db.lead.findFirst.mockResolvedValue(lead);
      db.lead.update.mockResolvedValue(lead);

      await updateLeadFields('tenant-1', 'lead-1', { name: 'Model guess' });

      expect(callArg(db.lead.update).data).not.toHaveProperty('name');
    });

    it('always updates phone and email when provided', async () => {
      const lead = makeLead({ phone: '+100', email: 'old@example.com' });
      db.lead.findFirst.mockResolvedValue(lead);
      db.lead.update.mockResolvedValue(lead);

      await updateLeadFields('tenant-1', 'lead-1', {
        phone: '+200',
        email: 'new@example.com',
      });

      const args = callArg(db.lead.update);
      expect(args.data.phone).toBe('+200');
      expect(args.data.email).toBe('new@example.com');
    });

    it('merges and deduplicates tags, trimming and dropping empty ones', async () => {
      const lead = makeLead({ tags: ['vip', 'warm'] });
      db.lead.findFirst.mockResolvedValue(lead);
      db.lead.update.mockResolvedValue(lead);

      await updateLeadFields('tenant-1', 'lead-1', {
        addTags: ['warm', 'hot', '  ', 'hot'],
      });

      expect(callArg(db.lead.update).data.tags).toEqual(['vip', 'warm', 'hot']);
    });

    it('clamps score into the 0..100 range', async () => {
      const lead = makeLead();
      db.lead.findFirst.mockResolvedValue(lead);
      db.lead.update.mockResolvedValue(lead);

      await updateLeadFields('tenant-1', 'lead-1', { score: 150 });
      expect(callArg(db.lead.update, 0).data.score).toBe(100);

      await updateLeadFields('tenant-1', 'lead-1', { score: -5 });
      expect(callArg(db.lead.update, 1).data.score).toBe(0);

      await updateLeadFields('tenant-1', 'lead-1', { score: 42 });
      expect(callArg(db.lead.update, 2).data.score).toBe(42);
    });

    it('merges qualification with existing keys, new values winning', async () => {
      const lead = makeLead({ qualification: { budget: 'low', region: 'EU' } });
      db.lead.findFirst.mockResolvedValue(lead);
      db.lead.update.mockResolvedValue(lead);

      await updateLeadFields('tenant-1', 'lead-1', {
        qualification: { budget: 'high', timeline: 'Q3' },
      });

      expect(callArg(db.lead.update).data.qualification).toEqual({
        budget: 'high',
        region: 'EU',
        timeline: 'Q3',
      });
    });

    it('an empty update only touches lastInteractionAt', async () => {
      const lead = makeLead();
      db.lead.findFirst.mockResolvedValue(lead);
      db.lead.update.mockResolvedValue(lead);

      await updateLeadFields('tenant-1', 'lead-1', {});

      const args = callArg(db.lead.update);
      expect(Object.keys(args.data)).toEqual(['lastInteractionAt']);
      expect(args.data.lastInteractionAt).toBeInstanceOf(Date);
    });
  });

  describe('mergeLeads', () => {
    it('rejects merging a lead into itself', async () => {
      await expect(mergeLeads('tenant-1', 'lead-1', 'lead-1')).rejects.toThrow(ValidationError);
      expect(db.lead.findFirst).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when either lead is missing', async () => {
      db.lead.findFirst.mockResolvedValue(null);

      await expect(mergeLeads('tenant-1', 'lead-a', 'lead-b')).rejects.toThrow(NotFoundError);
    });

    it('rejects a source that is already merged', async () => {
      const source = makeLead({ id: 'lead-a', mergedIntoId: 'lead-z' });
      const target = makeLead({ id: 'lead-b' });
      db.lead.findFirst.mockImplementation(async (args: unknown) =>
        (args as { where: { id: string } }).where.id === 'lead-a' ? source : target,
      );

      await expect(mergeLeads('tenant-1', 'lead-a', 'lead-b')).rejects.toThrow(
        'Source lead is already merged',
      );
      expect(db.leadIdentity.updateMany).not.toHaveBeenCalled();
    });

    it('moves related records, marks the source merged, and merges fields onto the target', async () => {
      const source = makeLead({
        id: 'lead-a',
        name: 'Alice',
        phone: '+100',
        score: 80,
        tags: ['telegram', 'vip'],
        qualification: { budget: 'low', region: 'EU' },
        lastInteractionAt: new Date('2026-02-01T00:00:00Z'),
      });
      const target = makeLead({
        id: 'lead-b',
        name: null,
        email: 'target@example.com',
        score: 30,
        tags: ['instagram', 'vip'],
        qualification: { budget: 'high' },
        lastInteractionAt: new Date('2026-01-15T00:00:00Z'),
      });
      db.lead.findFirst.mockImplementation(async (args: unknown) =>
        (args as { where: { id: string } }).where.id === 'lead-a' ? source : target,
      );
      const mergedTarget = makeLead({ id: 'lead-b', name: 'Alice' });
      db.lead.update.mockResolvedValue(mergedTarget);

      const result = await mergeLeads('tenant-1', 'lead-a', 'lead-b');

      expect(result).toEqual(mergedTarget);
      for (const model of [db.leadIdentity, db.conversation, db.crmNote, db.humanHandoff]) {
        expect(model.updateMany).toHaveBeenCalledWith({
          where: { leadId: 'lead-a' },
          data: { leadId: 'lead-b' },
        });
      }

      // Source is marked as merged into the target.
      expect(db.lead.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'lead-a' },
          data: expect.objectContaining({ mergedIntoId: 'lead-b' }),
        }),
      );

      // Target update: target values win, blanks fill from source, tags dedupe,
      // score takes the max, latest interaction wins.
      const targetCall = db.lead.update.mock.calls.find(
        (c) => (c[0] as { where: { id: string } }).where.id === 'lead-b',
      );
      expect(targetCall).toBeDefined();
      const data = (targetCall![0] as { data: Record<string, unknown> }).data;
      expect(data.name).toBe('Alice');
      expect(data.phone).toBe('+100');
      expect(data.email).toBe('target@example.com');
      expect(data.score).toBe(80);
      expect(data.tags).toEqual(['instagram', 'vip', 'telegram']);
      expect(data.qualification).toEqual({ budget: 'high', region: 'EU' });
      expect(data.lastInteractionAt).toEqual(new Date('2026-02-01T00:00:00Z'));
    });
  });
});
