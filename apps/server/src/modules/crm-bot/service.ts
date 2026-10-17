import type { CourseRegistration, CrmBotSession, RegistrationStatus } from '@prisma/client';
import { getPrisma } from '../../db/client.js';
import { verifyPassword } from '../../lib/crypto.js';
import { childLogger } from '../../lib/logger.js';
import {
  REGISTRATION_STATUSES,
  REGISTRATION_STATUS_LABEL,
  changeRegistrationStatus,
} from '../crm/registrations.js';
import type { InlineKeyboard, TelegramClient, TgUser } from '../channels/telegram/client.js';

/**
 * The CRM bot: course registrations in Telegram, for the people who work them.
 *
 * Two deliberate narrowings.
 *
 * It shows COURSE REGISTRATIONS ONLY — never the message firehose. Every
 * inbound DM creates a Lead, and a salesperson scrolling those would never
 * find the people who actually asked to enrol. A registration exists only once
 * a name, a phone and a course have all been given, so every row here is
 * someone who can be called.
 *
 * And it has NO password of its own. It asks for the same login and password
 * as the dashboard and checks them against the User table, so there is no
 * second secret to rotate, nothing to hardcode, and revoking someone in the
 * dashboard revokes them here. Their dashboard role decides what they may do.
 *
 * A password typed into a chat is still a password sitting in a chat log, so
 * the message carrying it is deleted the moment it has been checked, and
 * repeated guesses from one Telegram account lock that account out.
 */

const LOCK_AFTER_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const PAGE_SIZE = 5;

export interface BotContext {
  tenantId: string;
  client: TelegramClient;
}

// ── Session ──────────────────────────────────────────────────────────────────

export function isAuthenticated(session: CrmBotSession | null): boolean {
  return Boolean(session?.userId && !session.revokedAt);
}

export async function loadSession(telegramUserId: string): Promise<CrmBotSession | null> {
  return getPrisma().crmBotSession.findUnique({ where: { telegramUserId } });
}

export async function touchSession(telegramUserId: string): Promise<void> {
  await getPrisma()
    .crmBotSession.updateMany({ where: { telegramUserId }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);
}

export interface AuthResult {
  ok: boolean;
  /** Message to show the person, already in Uzbek. */
  message: string;
  userName?: string;
}

/**
 * Check a "login password" line against the dashboard's own user records.
 *
 * Wrong login and wrong password give the SAME answer: telling someone which
 * half they got right turns a password guess into a username check.
 */
export async function attemptLogin(params: {
  tenantId: string;
  telegramUserId: string;
  telegramChatId: string;
  telegramName: string | null;
  text: string;
}): Promise<AuthResult> {
  const prisma = getPrisma();
  const log = childLogger({ module: 'crm-bot', tenantId: params.tenantId });

  const session = await prisma.crmBotSession.upsert({
    where: { telegramUserId: params.telegramUserId },
    create: {
      tenantId: params.tenantId,
      telegramUserId: params.telegramUserId,
      telegramChatId: params.telegramChatId,
      telegramName: params.telegramName,
    },
    update: { telegramChatId: params.telegramChatId, telegramName: params.telegramName },
  });

  if (session.lockedUntil && session.lockedUntil > new Date()) {
    const mins = Math.ceil((session.lockedUntil.getTime() - Date.now()) / 60000);
    return {
      ok: false,
      message: `Juda ko'p noto'g'ri urinish. ${mins} daqiqadan keyin qayta urinib ko'ring.`,
    };
  }

  // "Admin Admin3737" or "Admin:Admin3737" on one line.
  const parts = params.text.trim().split(/[\s:]+/).filter(Boolean);
  const [login, ...rest] = parts;
  const password = rest.join(' ');
  const generic =
    "Login yoki parol noto'g'ri. Qaytadan yuboring:\n\n<login> <parol>\n\nMasalan: Admin ParolingizNi";

  if (!login || !password) {
    return {
      ok: false,
      message:
        "Kirish uchun login va parolni bitta qatorda yuboring:\n\n<login> <parol>\n\nBular platformaga kiradigan login va parolingiz bilan bir xil.",
    };
  }

  const user = await prisma.user.findUnique({ where: { username: login } });
  const passwordOk = user ? await verifyPassword(password, user.passwordHash) : false;

  if (!user || !passwordOk || user.tenantId !== params.tenantId) {
    const failed = session.failedAttempts + 1;
    await prisma.crmBotSession.update({
      where: { id: session.id },
      data: {
        failedAttempts: failed,
        ...(failed >= LOCK_AFTER_ATTEMPTS
          ? { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) }
          : {}),
      },
    });
    log.warn({ telegramUserId: params.telegramUserId, failed }, 'crm bot login failed');
    return {
      ok: false,
      message:
        failed >= LOCK_AFTER_ATTEMPTS
          ? `Juda ko'p noto'g'ri urinish. ${LOCK_MINUTES} daqiqaga bloklandi.`
          : generic,
    };
  }

  await prisma.crmBotSession.update({
    where: { id: session.id },
    data: {
      userId: user.id,
      authenticatedAt: new Date(),
      revokedAt: null,
      failedAttempts: 0,
      lockedUntil: null,
    },
  });
  await prisma.auditLog
    .create({
      data: {
        tenantId: params.tenantId,
        userId: user.id,
        action: 'crm_bot.login',
        resource: 'crm_bot_session',
        resourceId: session.id,
        detail: { telegramUserId: params.telegramUserId, telegramName: params.telegramName },
      },
    })
    .catch(() => undefined);
  log.info({ user: user.username }, 'crm bot login succeeded');

  return { ok: true, message: '', userName: user.name || user.username };
}

export async function signOut(telegramUserId: string): Promise<void> {
  await getPrisma()
    .crmBotSession.updateMany({
      where: { telegramUserId },
      data: { revokedAt: new Date(), userId: null },
    })
    .catch(() => undefined);
}

// ── Rendering ────────────────────────────────────────────────────────────────

export const MAIN_MENU: InlineKeyboard = {
  inline_keyboard: [
    [{ text: '📋 Yangi arizalar', callback_data: 'list:NEW:0' }],
    [
      { text: '📞 Bog‘lanish kerak', callback_data: 'list:CONTACT_NEEDED:0' },
      { text: '✅ Kursga yozildi', callback_data: 'list:ENROLLED:0' },
    ],
    [{ text: '👥 Barcha arizalar', callback_data: 'list:ALL:0' }],
    [{ text: '📊 Hisobot', callback_data: 'stats' }],
  ],
};

export function welcomeText(name: string): string {
  return (
    `Assalomu alaykum, ${name}!\n\n` +
    `Bu — Turon Avtomaktab CRM boti. Bu yerda faqat KURSGA YOZILISH arizalari ko‘rsatiladi: ` +
    `ism, telefon va kursni to‘liq bergan mijozlar. Oddiy savol-javob xabarlari bu yerga tushmaydi.\n\n` +
    `Quyidagidan tanlang:`
  );
}

export function formatRegistration(r: CourseRegistration, index?: number): string {
  const when = new Date(r.createdAt).toLocaleString('uz-UZ');
  const source = r.sourceChannel === 'INSTAGRAM' ? 'Instagram' : 'Telegram';
  return [
    `${index !== undefined ? `${index}. ` : ''}👤 ${r.fullName}`,
    `📞 ${r.phone}`,
    `📚 ${r.course}`,
    r.preferredTime ? `🕒 ${r.preferredTime}` : '',
    `📍 ${source}${r.sourceAccount ? ` (${r.sourceAccount})` : ''}`,
    `🔖 ${REGISTRATION_STATUS_LABEL[r.status]}`,
    `🗓 ${when}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Buttons for one registration: every status except the one it already has. */
export function statusKeyboard(r: CourseRegistration): InlineKeyboard {
  const buttons = REGISTRATION_STATUSES.filter((s) => s !== r.status).map((s) => ({
    text: REGISTRATION_STATUS_LABEL[s],
    callback_data: `set:${r.id}:${s}`,
  }));
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: '⬅️ Orqaga', callback_data: 'menu' }]);
  return { inline_keyboard: rows };
}

export interface ListPage {
  text: string;
  keyboard: InlineKeyboard;
}

export async function renderList(
  tenantId: string,
  filter: string,
  page: number,
): Promise<ListPage> {
  const prisma = getPrisma();
  const where =
    filter === 'ALL'
      ? { tenantId }
      : { tenantId, status: filter as RegistrationStatus };

  const [rows, total] = await Promise.all([
    prisma.courseRegistration.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: page * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.courseRegistration.count({ where }),
  ]);

  const title =
    filter === 'ALL' ? 'Barcha arizalar' : REGISTRATION_STATUS_LABEL[filter as RegistrationStatus];

  if (total === 0) {
    return {
      text: `${title}\n\nHozircha ariza yo‘q.\n\nMijoz suhbatda ism, telefon va kursni bersa — ariza shu yerda o‘zi paydo bo‘ladi.`,
      keyboard: { inline_keyboard: [[{ text: '⬅️ Orqaga', callback_data: 'menu' }]] },
    };
  }

  const from = page * PAGE_SIZE + 1;
  const to = Math.min(total, from + rows.length - 1);
  const text = [
    `${title} — ${from}–${to} / ${total}`,
    '',
    ...rows.map((r, i) => formatRegistration(r, from + i)),
  ].join('\n\n');

  // One button per row shown, so a tap opens exactly the person being read.
  const rowButtons = rows.map((r, i) => [
    { text: `${from + i}. ${r.fullName} — ${r.phone}`, callback_data: `open:${r.id}` },
  ]);
  const nav: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) nav.push({ text: '⬅️ Oldingi', callback_data: `list:${filter}:${page - 1}` });
  if (to < total) nav.push({ text: 'Keyingi ➡️', callback_data: `list:${filter}:${page + 1}` });

  return {
    text,
    keyboard: {
      inline_keyboard: [
        ...rowButtons,
        ...(nav.length ? [nav] : []),
        [{ text: '🏠 Menyu', callback_data: 'menu' }],
      ],
    },
  };
}

export async function renderStats(tenantId: string): Promise<ListPage> {
  const prisma = getPrisma();
  const [byStatus, bySource, total] = await Promise.all([
    prisma.courseRegistration.groupBy({
      by: ['status'],
      where: { tenantId },
      _count: { _all: true },
    }),
    prisma.courseRegistration.groupBy({
      by: ['sourceChannel'],
      where: { tenantId },
      _count: { _all: true },
    }),
    prisma.courseRegistration.count({ where: { tenantId } }),
  ]);

  const lines = REGISTRATION_STATUSES.map((s) => {
    const n = byStatus.find((r) => r.status === s)?._count._all ?? 0;
    return `${REGISTRATION_STATUS_LABEL[s]}: ${n}`;
  });
  const sourceLines = bySource.map(
    (r) => `${r.sourceChannel === 'INSTAGRAM' ? 'Instagram' : 'Telegram'}: ${r._count._all}`,
  );

  return {
    text: [
      `📊 Hisobot`,
      '',
      `Jami arizalar: ${total}`,
      '',
      'Holat bo‘yicha:',
      ...lines,
      '',
      'Manba bo‘yicha:',
      ...(sourceLines.length ? sourceLines : ['—']),
    ].join('\n'),
    keyboard: { inline_keyboard: [[{ text: '🏠 Menyu', callback_data: 'menu' }]] },
  };
}

// ── Actions ──────────────────────────────────────────────────────────────────

export async function applyStatusChange(params: {
  tenantId: string;
  registrationId: string;
  toStatus: RegistrationStatus;
  session: CrmBotSession;
}): Promise<CourseRegistration> {
  return changeRegistrationStatus({
    tenantId: params.tenantId,
    registrationId: params.registrationId,
    toStatus: params.toStatus,
    byUserId: params.session.userId,
    byTelegramId: params.session.telegramUserId,
    note: 'CRM bot',
  });
}

/**
 * Tell everyone signed in that a new registration arrived.
 *
 * Best effort per recipient: one blocked bot must not stop the others, and a
 * notification is never worth failing the registration that triggered it.
 */
export async function notifyNewRegistration(
  ctx: BotContext,
  registration: CourseRegistration,
): Promise<void> {
  const prisma = getPrisma();
  const log = childLogger({ module: 'crm-bot', tenantId: ctx.tenantId });
  const sessions = await prisma.crmBotSession.findMany({
    where: { tenantId: ctx.tenantId, userId: { not: null }, revokedAt: null },
  });

  const text = `🆕 Yangi ariza!\n\n${formatRegistration(registration)}`;
  for (const s of sessions) {
    try {
      await ctx.client.sendMessage(s.telegramChatId, text, {
        replyMarkup: { inline_keyboard: [[{ text: 'Ochish', callback_data: `open:${registration.id}` }]] },
      });
    } catch (err) {
      log.warn({ telegramUserId: s.telegramUserId, err: String(err) }, 'crm bot notify failed');
    }
  }
}

export function describeSender(from: TgUser): string {
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Foydalanuvchi';
}
