/**
 * Answering in groups and in channel comment threads.
 *
 * Three things are different from a private chat, and each one is invisible
 * when it is wrong — the bot looks like it simply ignored somebody:
 *
 *   A comment-thread reply sent without message_thread_id lands in the group's
 *   main view instead of under the post.
 *   Keying the conversation on the chat alone makes a whole group one
 *   conversation, so the per-chat hourly cap throttles every member together.
 *   The channel post Telegram copies into the discussion group is not a
 *   question; answering it comments on every post the channel publishes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TelegramClient,
  type TgMessage,
} from '../../src/modules/channels/telegram/client.js';
import { CHANNEL_RULES } from '../../src/modules/engine/prompt.js';
import { initLogger } from '../../src/lib/logger.js';
import { makeTestEnv } from '../helpers/test-env.js';

function message(overrides: Partial<TgMessage> = {}): TgMessage {
  return {
    message_id: 55,
    date: Math.floor(Date.now() / 1000),
    chat: { id: -100123, type: 'supergroup', title: 'Turon aloqa' },
    from: { id: 42, is_bot: false, first_name: 'Akobir', username: 'akobir' },
    text: 'Narx qancha?',
    ...overrides,
  } as TgMessage;
}

describe('sendMessage targeting', () => {
  const fetchMock = vi.fn();
  let client: TelegramClient;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    client = new TelegramClient('1:token');
  });
  afterEach(() => vi.unstubAllGlobals());

  const bodyOf = (call: number) => JSON.parse(String(fetchMock.mock.calls[call]![1]!.body));

  it('puts a comment-thread reply inside the thread, quoting the question', async () => {
    await client.sendMessage(-100123, 'Narxlar 1 500 000 so‘m.', {
      messageThreadId: 777,
      replyToMessageId: 55,
    });

    const body = bodyOf(0);
    expect(body.message_thread_id).toBe(777);
    expect(body.reply_parameters).toMatchObject({ message_id: 55 });
    // The question can be deleted while the model is thinking; losing the
    // answer to that would be worse than losing the quote.
    expect(body.reply_parameters.allow_sending_without_reply).toBe(true);
  });

  it('quotes the question once, not on every continuation of a long answer', async () => {
    await client.sendMessage(-100123, 'x'.repeat(5000), {
      messageThreadId: 777,
      replyToMessageId: 55,
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(bodyOf(0).reply_parameters).toBeDefined();
    expect(bodyOf(1).reply_parameters).toBeUndefined();
    // Every part still belongs to the thread.
    expect(bodyOf(1).message_thread_id).toBe(777);
  });

  it('adds neither field for an ordinary private chat', async () => {
    await client.sendMessage(12345, 'Salom');
    const body = bodyOf(0);
    expect(body.message_thread_id).toBeUndefined();
    expect(body.reply_parameters).toBeUndefined();
  });

  it('shows typing inside the thread rather than the main group view', async () => {
    await client.sendChatAction(-100123, 'typing', { messageThreadId: 777 });
    expect(bodyOf(0).message_thread_id).toBe(777);
  });
});

describe('group reply rules', () => {
  it('exist as their own channel, separate from a private Telegram chat', () => {
    expect(CHANNEL_RULES.telegram_group).toBeDefined();
    expect(CHANNEL_RULES.telegram_group.label).toMatch(/group|comment/i);
  });

  // The behaviour that makes it read as an admin rather than a chatbot.
  it('tell the agent to answer questions but stay out of member chatter', () => {
    const rules = CHANNEL_RULES.telegram_group.extra.join(' ').toLowerCase();
    expect(rules).toMatch(/answer/);
    expect(rules).toMatch(/silent|reply=null/);
    expect(rules).toMatch(/public/);
  });

  // A group answer is read by everyone in it.
  it('forbid repeating a customer’s personal details in public', () => {
    const rules = CHANNEL_RULES.telegram_group.extra.join(' ').toLowerCase();
    expect(rules).toMatch(/phone number|personal/);
  });

  it('keeps replies short enough for a group', () => {
    expect(CHANNEL_RULES.telegram_group.maxReplyChars).toBeLessThan(
      CHANNEL_RULES.telegram.maxReplyChars,
    );
  });
});

describe('privacy mode detection', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  // This is the field that separates "the AI is broken" from "Telegram never
  // delivered the question".
  it('reads can_read_all_group_messages off getMe', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: {
          id: 1,
          is_bot: true,
          first_name: 'Turon',
          username: 'turon_bot',
          can_join_groups: true,
          can_read_all_group_messages: false,
        },
      }),
    } as unknown as Response);

    const me = await new TelegramClient('1:token').getMe();
    expect(me.can_read_all_group_messages).toBe(false);
  });
});

describe('what counts as a question to answer', () => {
  it('ignores the channel post Telegram copies into the discussion group', () => {
    // Replying to this would comment on every post the channel publishes.
    const forwarded = message({
      is_automatic_forward: true,
      from: undefined,
      sender_chat: { id: -100999, type: 'channel', title: 'Turon Avtomaktab' },
      text: 'Yangi kurs boshlandi!',
    });
    expect(forwarded.is_automatic_forward).toBe(true);
  });

  it('carries the thread id on a real comment', () => {
    const comment = message({ message_thread_id: 777 });
    expect(comment.message_thread_id).toBe(777);
  });
});
