/**
 * Chat exclusion (the supported stand-in for "the owner pinned this chat")
 * and course registrations.
 *
 * The exclusion tests care about one thing above all: a reply must not go out
 * after the owner has said /stop, INCLUDING when the decision to reply was
 * taken before they said it. That race is the whole point of the feature, and
 * it is invisible in manual testing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initLogger } from '../../src/lib/logger.js';
import { makeTestEnv } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';
import {
  isExcluded,
  parseOwnerCommand,
  sendStillAllowed,
  setConversationExcluded,
} from '../../src/modules/channels/telegram/exclusions.js';
import {
  isComplete,
  missingFields,
  normalizePhone,
  recordRegistration,
  changeRegistrationStatus,
} from '../../src/modules/crm/registrations.js';

describe('owner commands', () => {
  it.each([
    ['/stop', 'exclude'],
    ['/stopai', 'exclude'],
    ['/off', 'exclude'],
    ['/start', 'resume'],
    ['/on', 'resume'],
    ['/STOP', 'exclude'],
    ['/stop@turon_bot', 'exclude'],
    ['/stop please', 'exclude'],
  ])('reads %j as %s', (text, expected) => {
    expect(parseOwnerCommand(text)).toBe(expected);
  });

  it.each(['stop', 'hello', '', '/other', 'I will /stop later'])(
    'treats %j as an ordinary message',
    (text) => {
      expect(parseOwnerCommand(text)).toBeNull();
    },
  );
});

describe('exclusion state', () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
  });

  it('reads the flag off conversation metadata', () => {
    expect(isExcluded({ aiExcluded: true })).toBe(true);
    expect(isExcluded({ aiExcluded: false })).toBe(false);
    expect(isExcluded({})).toBe(false);
    expect(isExcluded(null)).toBe(false);
  });

  it('sets the flag without discarding other metadata', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'c-1',
      tenantId: 't-1',
      metadata: { businessConnectionId: 'bc-1', personalAccount: '@owner' },
    });

    await setConversationExcluded({
      tenantId: 't-1',
      conversationId: 'c-1',
      excluded: true,
      by: 'owner_command',
    });

    const data = (prisma.conversation.update.mock.calls[0]![0] as {
      data: { metadata: Record<string, unknown> };
    }).data;
    expect(data.metadata.aiExcluded).toBe(true);
    expect(data.metadata.aiExcludedBy).toBe('owner_command');
    // The routing metadata must survive — losing it would orphan the chat.
    expect(data.metadata.businessConnectionId).toBe('bc-1');
  });

  // THE race this feature exists for.
  it('withholds a send when the chat was excluded during generation', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ metadata: { aiExcluded: true } });
    expect(await sendStillAllowed('c-1')).toBe(false);
  });

  it('allows a send for a chat that is not excluded', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ metadata: {} });
    expect(await sendStillAllowed('c-1')).toBe(true);
  });

  // Fail closed: for a rule whose purpose is "never message these people",
  // an unreadable state must mean silence, not a gamble.
  it('withholds a send when the state cannot be read at all', async () => {
    prisma.conversation.findUnique.mockRejectedValue(new Error('db down'));
    expect(await sendStillAllowed('c-1')).toBe(false);
  });

  it('withholds a send when the conversation has vanished', async () => {
    prisma.conversation.findUnique.mockResolvedValue(null);
    expect(await sendStillAllowed('gone')).toBe(false);
  });
});

describe('phone normalisation', () => {
  it.each([
    ['+998 90 123 45 67', '+998901234567'],
    ['998901234567', '+998901234567'],
    ['901234567', '+998901234567'],
    ['90 123 45 67', '+998901234567'],
    ['8901234567', '+998901234567'],
    ['+998(90)123-45-67', '+998901234567'],
  ])('normalises %j to %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  // A registration exists so somebody can call it; an undialable number is
  // worse than a missing one because nobody finds out until they try.
  it.each([null, undefined, '', 'salom', '12', 'abc-def'])('rejects %j', (input) => {
    expect(normalizePhone(input as string | null)).toBeNull();
  });
});

describe('registration completeness', () => {
  const full = { fullName: 'Akobir', phone: '901234567', course: 'B toifa' };

  it('is complete only with a name, a dialable phone and a course', () => {
    expect(isComplete(full)).toBe(true);
    expect(isComplete({ ...full, fullName: '  ' })).toBe(false);
    expect(isComplete({ ...full, phone: 'yes' })).toBe(false);
    expect(isComplete({ ...full, course: null })).toBe(false);
  });

  it('names what is still missing, in Uzbek, for the agent to ask', () => {
    expect(missingFields({ fullName: null, phone: null, course: null })).toEqual([
      'ism familiya',
      'telefon raqam',
      'qaysi kurs',
    ]);
    expect(missingFields(full)).toEqual([]);
  });
});

describe('recordRegistration', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  const ctx = {
    tenantId: 't-1',
    leadId: 'lead-1',
    conversationId: 'c-1',
    sourceChannel: 'TELEGRAM' as const,
    sourceAccount: '@turon',
  };

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
  });

  it('files nothing while the draft is incomplete', async () => {
    const out = await recordRegistration(ctx, { fullName: 'Akobir', phone: null, course: 'B' });
    expect(out).toBeNull();
    expect(prisma.courseRegistration.create).not.toHaveBeenCalled();
  });

  it('files a complete one with a normalised phone and an opening event', async () => {
    prisma.courseRegistration.create.mockResolvedValue({ id: 'reg-1', course: 'B toifa' });

    const out = await recordRegistration(ctx, {
      fullName: '  Akobir  ',
      phone: '90 123 45 67',
      course: ' B toifa ',
    });

    expect(out).toMatchObject({ id: 'reg-1' });
    const data = (prisma.courseRegistration.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    }).data;
    expect(data).toMatchObject({
      fullName: 'Akobir',
      phone: '+998901234567',
      course: 'B toifa',
      sourceChannel: 'TELEGRAM',
      sourceAccount: '@turon',
      status: 'NEW',
    });
    // The trail starts at creation, not at the first human edit.
    expect(data.events).toBeDefined();
  });

  // The agent re-reads intent on every message, so this is the common case.
  it('does not file a second registration when the customer repeats themselves', async () => {
    const { Prisma } = await import('@prisma/client');
    prisma.courseRegistration.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
    );
    prisma.courseRegistration.findUnique.mockResolvedValue({
      id: 'reg-1',
      preferredTime: 'ertalab',
      conversationId: 'c-1',
    });

    const out = await recordRegistration(ctx, {
      fullName: 'Akobir',
      phone: '901234567',
      course: 'B toifa',
    });

    expect(out).toMatchObject({ id: 'reg-1' });
    expect(prisma.courseRegistration.update).not.toHaveBeenCalled();
  });

  it('fills a blank the customer has since provided, without overwriting', async () => {
    const { Prisma } = await import('@prisma/client');
    prisma.courseRegistration.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
    );
    prisma.courseRegistration.findUnique.mockResolvedValue({
      id: 'reg-1',
      preferredTime: null,
      conversationId: 'c-1',
    });
    prisma.courseRegistration.update.mockResolvedValue({ id: 'reg-1', preferredTime: 'kechqurun' });

    await recordRegistration(ctx, {
      fullName: 'Akobir',
      phone: '901234567',
      course: 'B toifa',
      preferredTime: 'kechqurun',
    });

    const data = (prisma.courseRegistration.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    }).data;
    expect(data).toEqual({ preferredTime: 'kechqurun' });
  });
});

describe('changeRegistrationStatus', () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
  });

  it('records who moved it and from where', async () => {
    prisma.courseRegistration.findFirst.mockResolvedValue({ id: 'reg-1', status: 'NEW' });
    prisma.courseRegistration.update.mockResolvedValue({ id: 'reg-1', status: 'CONTACTED' });
    prisma.registrationEvent.create.mockResolvedValue({ id: 'ev-1' });

    await changeRegistrationStatus({
      tenantId: 't-1',
      registrationId: 'reg-1',
      toStatus: 'CONTACTED',
      note: 'telefon qildim',
      byUserId: 'user-9',
    });

    const event = (prisma.registrationEvent.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    }).data;
    expect(event).toMatchObject({
      fromStatus: 'NEW',
      toStatus: 'CONTACTED',
      note: 'telefon qildim',
      byUserId: 'user-9',
    });
  });

  it('refuses a registration belonging to another tenant', async () => {
    prisma.courseRegistration.findFirst.mockResolvedValue(null);
    await expect(
      changeRegistrationStatus({ tenantId: 't-1', registrationId: 'other', toStatus: 'ENROLLED' }),
    ).rejects.toThrow(/not found/i);
  });
});
