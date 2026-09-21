import { Prisma, type Channel, type Lead, type LeadStatus } from '@prisma/client';
import { getPrisma } from '../../db/client.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { childLogger } from '../../lib/logger.js';

/**
 * CRM: unified leads across channels with identity resolution (spec §9–10).
 *
 * - One person, one lead: lookups go through LeadIdentity (tenantId, channel,
 *   externalId) so repeated messages never create duplicates.
 * - Cross-channel linking is conservative: exact-identifier candidates are
 *   *suggested* for manual merge; nothing is auto-merged on fuzzy evidence.
 */

export interface IdentityRef {
  channel: Channel;
  externalId: string;
  username?: string | null;
}

export async function findOrCreateLead(
  tenantId: string,
  identity: IdentityRef,
  defaults: { name?: string | null; source: Channel },
): Promise<Lead> {
  const prisma = getPrisma();

  const existing = await prisma.leadIdentity.findUnique({
    where: {
      tenantId_channel_externalId: {
        tenantId,
        channel: identity.channel,
        externalId: identity.externalId,
      },
    },
    include: { lead: true },
  });
  if (existing) {
    const lead = await resolveMergedLead(existing.lead);
    if (identity.username && identity.username !== existing.username) {
      await prisma.leadIdentity.update({
        where: { id: existing.id },
        data: { username: identity.username },
      });
    }
    return lead;
  }

  try {
    return await prisma.lead.create({
      data: {
        tenantId,
        source: defaults.source,
        name: defaults.name ?? null,
        username: identity.username ?? null,
        status: 'NEW',
        lastInteractionAt: new Date(),
        identities: {
          create: {
            tenantId,
            channel: identity.channel,
            externalId: identity.externalId,
            username: identity.username ?? null,
          },
        },
      },
    });
  } catch (err) {
    // Unique-constraint race: another worker created the identity concurrently.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const retry = await prisma.leadIdentity.findUnique({
        where: {
          tenantId_channel_externalId: {
            tenantId,
            channel: identity.channel,
            externalId: identity.externalId,
          },
        },
        include: { lead: true },
      });
      if (retry) return resolveMergedLead(retry.lead);
    }
    throw err;
  }
}

/** Follow the merge chain to the surviving lead. */
async function resolveMergedLead(lead: Lead): Promise<Lead> {
  const prisma = getPrisma();
  let current = lead;
  let hops = 0;
  while (current.mergedIntoId && hops < 10) {
    const next = await prisma.lead.findUnique({ where: { id: current.mergedIntoId } });
    if (!next) break;
    current = next;
    hops += 1;
  }
  return current;
}

export interface LeadUpdateFields {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  language?: string | null;
  intent?: string | null;
  status?: LeadStatus;
  score?: number;
  addTags?: string[];
  qualification?: Record<string, unknown>;
}

/**
 * Apply agent-collected fields. Fills blanks and updates contact info; never
 * clears data (an empty model field must not erase operator-entered values).
 */
export async function updateLeadFields(
  tenantId: string,
  leadId: string,
  update: LeadUpdateFields,
): Promise<Lead> {
  const prisma = getPrisma();
  const lead = await prisma.lead.findFirst({ where: { id: leadId, tenantId } });
  if (!lead) throw new NotFoundError(`Lead ${leadId} not found`);

  const data: Prisma.LeadUpdateInput = { lastInteractionAt: new Date() };
  if (update.name && !lead.name) data.name = update.name;
  if (update.phone) data.phone = update.phone;
  if (update.email) data.email = update.email;
  if (update.language) data.language = update.language;
  if (update.intent) data.intent = update.intent;
  if (update.status) data.status = update.status;
  if (typeof update.score === 'number') data.score = Math.max(0, Math.min(100, update.score));
  if (update.addTags?.length) {
    data.tags = Array.from(new Set([...lead.tags, ...update.addTags.map((t) => t.trim()).filter(Boolean)]));
  }
  if (update.qualification && Object.keys(update.qualification).length > 0) {
    data.qualification = {
      ...(lead.qualification as Record<string, unknown>),
      ...update.qualification,
    } as Prisma.InputJsonValue;
  }

  return prisma.lead.update({ where: { id: lead.id }, data });
}

export async function addNote(
  tenantId: string,
  leadId: string,
  content: string,
  author: { type: 'AGENT' | 'OPERATOR' | 'SYSTEM'; userId?: string },
): Promise<void> {
  const prisma = getPrisma();
  await prisma.crmNote.create({
    data: {
      tenantId,
      leadId,
      content,
      authorType: author.type,
      authorUserId: author.userId ?? null,
    },
  });
}

/**
 * Candidate duplicate leads by exact identifier match (phone/email/username).
 * Surfaced in the dashboard for manual merge — never auto-merged (spec §10).
 */
export async function findMergeCandidates(tenantId: string, leadId: string): Promise<Lead[]> {
  const prisma = getPrisma();
  const lead = await prisma.lead.findFirst({ where: { id: leadId, tenantId } });
  if (!lead) throw new NotFoundError(`Lead ${leadId} not found`);

  const or: Prisma.LeadWhereInput[] = [];
  if (lead.phone) or.push({ phone: lead.phone });
  if (lead.email) or.push({ email: lead.email });
  if (lead.username) or.push({ username: lead.username });
  if (or.length === 0) return [];

  return prisma.lead.findMany({
    where: { tenantId, id: { not: lead.id }, mergedIntoId: null, OR: or },
    take: 10,
  });
}

/** Manual merge: move identities/conversations/notes/handoffs onto the target. */
export async function mergeLeads(
  tenantId: string,
  sourceLeadId: string,
  targetLeadId: string,
): Promise<Lead> {
  const prisma = getPrisma();
  if (sourceLeadId === targetLeadId) throw new ValidationError('Cannot merge a lead into itself');
  const [source, target] = await Promise.all([
    prisma.lead.findFirst({ where: { id: sourceLeadId, tenantId } }),
    prisma.lead.findFirst({ where: { id: targetLeadId, tenantId } }),
  ]);
  if (!source || !target) throw new NotFoundError('Lead not found');
  if (source.mergedIntoId) throw new ValidationError('Source lead is already merged');

  const merged = await prisma.$transaction(async (tx) => {
    await tx.leadIdentity.updateMany({ where: { leadId: source.id }, data: { leadId: target.id } });
    await tx.conversation.updateMany({ where: { leadId: source.id }, data: { leadId: target.id } });
    await tx.crmNote.updateMany({ where: { leadId: source.id }, data: { leadId: target.id } });
    await tx.humanHandoff.updateMany({ where: { leadId: source.id }, data: { leadId: target.id } });
    await tx.lead.update({
      where: { id: source.id },
      data: { mergedIntoId: target.id, status: source.status === 'SPAM' ? 'SPAM' : source.status },
    });
    return tx.lead.update({
      where: { id: target.id },
      data: {
        name: target.name ?? source.name,
        phone: target.phone ?? source.phone,
        email: target.email ?? source.email,
        username: target.username ?? source.username,
        language: target.language ?? source.language,
        intent: target.intent ?? source.intent,
        score: Math.max(target.score, source.score),
        tags: Array.from(new Set([...target.tags, ...source.tags])),
        qualification: {
          ...(source.qualification as Record<string, unknown>),
          ...(target.qualification as Record<string, unknown>),
        } as Prisma.InputJsonValue,
        lastInteractionAt:
          (target.lastInteractionAt ?? new Date(0)) > (source.lastInteractionAt ?? new Date(0))
            ? target.lastInteractionAt
            : source.lastInteractionAt,
      },
    });
  });

  childLogger({ module: 'crm', tenantId }).info(
    { sourceLeadId, targetLeadId },
    'leads merged manually',
  );
  return merged;
}
