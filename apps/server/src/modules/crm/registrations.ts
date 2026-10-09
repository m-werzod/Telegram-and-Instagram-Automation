import { Prisma, type Channel, type CourseRegistration, type RegistrationStatus } from '@prisma/client';
import { getPrisma } from '../../db/client.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { childLogger } from '../../lib/logger.js';

/**
 * Course registrations — the people who actually asked to enrol.
 *
 * Kept apart from Lead on purpose. Every inbound message creates a lead, so
 * that list is a firehose; this one is the queue a salesperson works through,
 * and it only grows when someone states an intent to register and gives the
 * details to act on. Each row keeps its own lifecycle and an event trail of
 * who moved it where.
 */

/** A registration is only filed once these are all known. */
export interface RegistrationDraft {
  fullName: string | null;
  phone: string | null;
  course: string | null;
  preferredTime?: string | null;
}

export interface RegistrationContext {
  tenantId: string;
  leadId: string;
  conversationId: string | null;
  sourceChannel: Channel;
  /** Which connected account took it — survives a later account switch. */
  sourceAccount: string | null;
}

/** Status order as the sales team works it, used for the UI and the bot. */
export const REGISTRATION_STATUSES = [
  'NEW',
  'CONTACT_NEEDED',
  'CONTACTED',
  'TRIAL_BOOKED',
  'ENROLLED',
  'COMPLETED',
  'CANCELLED',
] as const satisfies readonly RegistrationStatus[];

export const REGISTRATION_STATUS_LABEL: Record<RegistrationStatus, string> = {
  NEW: 'Yangi ariza',
  CONTACT_NEEDED: "Bog'lanish kerak",
  CONTACTED: "Mijoz bilan bog'lanildi",
  TRIAL_BOOKED: 'Sinov darsi belgilandi',
  ENROLLED: 'Kursga yozildi',
  COMPLETED: 'Yakunlandi',
  CANCELLED: 'Bekor qilindi',
};

/**
 * Uzbek mobile numbers as customers actually type them: +998 90 123 45 67,
 * 998901234567, 90 123 45 67, 901234567. Normalised to +998XXXXXXXXX so the
 * same person typing it two ways does not become two registrations.
 *
 * Returns null for anything that is not a plausible number — a registration
 * with an unreachable phone is worse than one held back for a missing field,
 * because nobody discovers the problem until they try to call.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;
  // 9 digits = local mobile without the country code.
  if (digits.length === 9) return `+998${digits}`;
  if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`;
  // Someone typed 8 90 ... (old domestic prefix).
  if (digits.length === 10 && digits.startsWith('8')) return `+998${digits.slice(1)}`;
  // Any other international number: keep it if it is a believable length.
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** Everything present and plausible? */
export function isComplete(draft: RegistrationDraft): boolean {
  return Boolean(
    draft.fullName?.trim() && normalizePhone(draft.phone) && draft.course?.trim(),
  );
}

/** What the agent still has to ask for, in Uzbek, for the reply prompt. */
export function missingFields(draft: RegistrationDraft): string[] {
  const missing: string[] = [];
  if (!draft.fullName?.trim()) missing.push('ism familiya');
  if (!normalizePhone(draft.phone)) missing.push('telefon raqam');
  if (!draft.course?.trim()) missing.push('qaysi kurs');
  return missing;
}

/**
 * File a registration, or enrich the one this person already has for the same
 * course. Returns null when the draft is still incomplete — the caller leaves
 * the agent to ask for the rest rather than creating a half-filled row that a
 * salesperson cannot act on.
 */
export async function recordRegistration(
  ctx: RegistrationContext,
  draft: RegistrationDraft,
): Promise<CourseRegistration | null> {
  if (!isComplete(draft)) return null;

  const prisma = getPrisma();
  const log = childLogger({ module: 'registrations', tenantId: ctx.tenantId });
  const phone = normalizePhone(draft.phone)!;
  const course = draft.course!.trim();
  const fullName = draft.fullName!.trim();

  // The unique key is (tenant, lead, course): the agent re-reads intent on
  // every message, so a customer repeating themselves must not file twice.
  try {
    const created = await prisma.courseRegistration.create({
      data: {
        tenantId: ctx.tenantId,
        leadId: ctx.leadId,
        conversationId: ctx.conversationId,
        fullName,
        phone,
        course,
        preferredTime: draft.preferredTime?.trim() || null,
        sourceChannel: ctx.sourceChannel,
        sourceAccount: ctx.sourceAccount,
        status: 'NEW',
        events: { create: { toStatus: 'NEW', note: 'AI suhbatdan yaratildi' } },
      },
    });
    log.info({ registrationId: created.id, course }, 'course registration created');
    return created;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
  }

  // Already exists. Fill blanks the customer has since provided, but never
  // overwrite what a human has already corrected by hand.
  const existing = await prisma.courseRegistration.findUnique({
    where: { tenantId_leadId_course: { tenantId: ctx.tenantId, leadId: ctx.leadId, course } },
  });
  if (!existing) return null;

  const patch: Prisma.CourseRegistrationUpdateInput = {};
  if (!existing.preferredTime && draft.preferredTime?.trim()) {
    patch.preferredTime = draft.preferredTime.trim();
  }
  if (!existing.conversationId && ctx.conversationId) {
    patch.conversation = { connect: { id: ctx.conversationId } };
  }
  if (Object.keys(patch).length === 0) return existing;
  return prisma.courseRegistration.update({ where: { id: existing.id }, data: patch });
}

/** Move a registration to a new status, recording who did it. */
export async function changeRegistrationStatus(params: {
  tenantId: string;
  registrationId: string;
  toStatus: RegistrationStatus;
  note?: string | null;
  byUserId?: string | null;
  byTelegramId?: string | null;
}): Promise<CourseRegistration> {
  const prisma = getPrisma();
  const existing = await prisma.courseRegistration.findFirst({
    where: { id: params.registrationId, tenantId: params.tenantId },
  });
  if (!existing) throw new NotFoundError('Registration not found');
  if (!REGISTRATION_STATUSES.includes(params.toStatus)) {
    throw new ValidationError('Unknown registration status');
  }

  // The write and its audit row go together: a status with no record of who
  // changed it is exactly what the history is meant to prevent.
  const [updated] = await prisma.$transaction([
    prisma.courseRegistration.update({
      where: { id: existing.id },
      data: { status: params.toStatus },
    }),
    prisma.registrationEvent.create({
      data: {
        registrationId: existing.id,
        fromStatus: existing.status,
        toStatus: params.toStatus,
        note: params.note?.trim() || null,
        byUserId: params.byUserId ?? null,
        byTelegramId: params.byTelegramId ?? null,
      },
    }),
  ]);
  return updated;
}
