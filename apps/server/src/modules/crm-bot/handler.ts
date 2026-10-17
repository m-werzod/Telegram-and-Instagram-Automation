import { getPrisma } from '../../db/client.js';
import { childLogger } from '../../lib/logger.js';
import { REGISTRATION_STATUSES } from '../crm/registrations.js';
import type { RegistrationStatus } from '@prisma/client';
import type { TelegramClient, TgUpdate } from '../channels/telegram/client.js';
import {
  MAIN_MENU,
  attemptLogin,
  applyStatusChange,
  describeSender,
  formatRegistration,
  isAuthenticated,
  loadSession,
  renderList,
  renderStats,
  signOut,
  statusKeyboard,
  touchSession,
  welcomeText,
} from './service.js';

/**
 * One Telegram update for the CRM bot.
 *
 * Every path begins by checking the session, because every path exposes
 * customer names and phone numbers. There is no read that is safe to serve to
 * an unauthenticated chat, so there is no branch that skips the check.
 */
export async function handleCrmBotUpdate(params: {
  tenantId: string;
  client: TelegramClient;
  update: TgUpdate;
}): Promise<void> {
  const { tenantId, client, update } = params;
  const log = childLogger({ module: 'crm-bot', tenantId });

  if (update.callback_query) return handleCallback(params);
  const message = update.message;
  if (!message?.from || message.chat.type !== 'private') return;

  const telegramUserId = String(message.from.id);
  const chatId = String(message.chat.id);
  const text = (message.text ?? '').trim();
  const session = await loadSession(telegramUserId);

  if (text === '/logout' || text.toLowerCase() === 'chiqish') {
    await signOut(telegramUserId);
    await client.sendMessage(chatId, 'Chiqdingiz. Qayta kirish uchun login va parolni yuboring.');
    return;
  }

  if (!isAuthenticated(session)) {
    if (text === '/start') {
      await client.sendMessage(
        chatId,
        'Assalomu alaykum! Bu — Turon Avtomaktab CRM boti.\n\n' +
          'Davom etish uchun platformaga kiradigan login va parolingizni bitta qatorda yuboring:\n\n' +
          '<login> <parol>\n\n' +
          'Xavfsizlik uchun parolingiz tekshirilgach, xabaringiz avtomatik o‘chiriladi.',
      );
      return;
    }

    const result = await attemptLogin({
      tenantId,
      telegramUserId,
      telegramChatId: chatId,
      telegramName: describeSender(message.from),
      text,
    });

    // Delete the password from the chat as soon as it has been checked —
    // right or wrong, it should not stay in the history. Best effort: a bot
    // may delete incoming private messages, but not indefinitely.
    await client.deleteMessage(chatId, message.message_id).catch(() => undefined);

    if (!result.ok) {
      await client.sendMessage(chatId, result.message);
      return;
    }
    await client.sendMessage(chatId, welcomeText(result.userName ?? 'hamkasb'), {
      replyMarkup: MAIN_MENU,
    });
    log.info('crm bot session opened');
    return;
  }

  await touchSession(telegramUserId);

  // Signed in: anything typed just reopens the menu. A search box here would
  // be a second way to read customer data, and the lists already cover it.
  await client.sendMessage(chatId, welcomeText(session!.telegramName ?? 'hamkasb'), {
    replyMarkup: MAIN_MENU,
  });
}

async function handleCallback(params: {
  tenantId: string;
  client: TelegramClient;
  update: TgUpdate;
}): Promise<void> {
  const { tenantId, client, update } = params;
  const cb = update.callback_query!;
  const telegramUserId = String(cb.from.id);
  const chatId = cb.message ? String(cb.message.chat.id) : telegramUserId;
  const messageId = cb.message?.message_id;
  const data = cb.data ?? '';
  const log = childLogger({ module: 'crm-bot', tenantId });

  const session = await loadSession(telegramUserId);
  if (!isAuthenticated(session)) {
    // A button can be pressed long after a session was revoked; the payload
    // carries a registration id, so this must be refused like any other read.
    await client.answerCallbackQuery(cb.id, {
      text: 'Sessiya tugagan. Qaytadan kiring.',
      showAlert: true,
    });
    return;
  }
  await touchSession(telegramUserId);

  const show = async (text: string, keyboard: Parameters<typeof client.editMessageText>[3]) => {
    if (messageId) {
      await client
        .editMessageText(chatId, messageId, text, keyboard ?? {})
        .catch(async () => {
          await client.sendMessage(chatId, text, keyboard ?? {});
        });
    } else {
      await client.sendMessage(chatId, text, keyboard ?? {});
    }
  };

  try {
    if (data === 'menu') {
      await show(welcomeText(session!.telegramName ?? 'hamkasb'), { replyMarkup: MAIN_MENU });
    } else if (data === 'stats') {
      const page = await renderStats(tenantId);
      await show(page.text, { replyMarkup: page.keyboard });
    } else if (data.startsWith('list:')) {
      const [, filter, pageStr] = data.split(':');
      const page = await renderList(tenantId, filter ?? 'ALL', Number(pageStr) || 0);
      await show(page.text, { replyMarkup: page.keyboard });
    } else if (data.startsWith('open:')) {
      const id = data.slice('open:'.length);
      const r = await getPrisma().courseRegistration.findFirst({ where: { id, tenantId } });
      if (!r) {
        await client.answerCallbackQuery(cb.id, { text: 'Ariza topilmadi.' });
        return;
      }
      await show(formatRegistration(r), { replyMarkup: statusKeyboard(r) });
    } else if (data.startsWith('set:')) {
      const [, id, status] = data.split(':');
      if (!id || !REGISTRATION_STATUSES.includes(status as RegistrationStatus)) {
        await client.answerCallbackQuery(cb.id, { text: 'Noto‘g‘ri amal.' });
        return;
      }
      const updated = await applyStatusChange({
        tenantId,
        registrationId: id,
        toStatus: status as RegistrationStatus,
        session: session!,
      });
      await client.answerCallbackQuery(cb.id, { text: 'Holat yangilandi ✅' });
      await show(formatRegistration(updated), { replyMarkup: statusKeyboard(updated) });
      log.info({ registrationId: id, status }, 'registration status changed from crm bot');
      return;
    }
    await client.answerCallbackQuery(cb.id);
  } catch (err) {
    log.warn({ err: String(err), data }, 'crm bot callback failed');
    await client.answerCallbackQuery(cb.id, { text: 'Xatolik. Qayta urinib ko‘ring.' }).catch(() => undefined);
  }
}
