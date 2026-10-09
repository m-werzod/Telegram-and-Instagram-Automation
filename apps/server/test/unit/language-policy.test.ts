/**
 * The Uzbek-only policy, and the two ways it can be wrong.
 *
 * Nagging someone who DID write Uzbek is the failure that makes the account
 * look broken, so most of these pin the cases that must NOT trigger a
 * reminder: short replies, phone numbers, emoji, a stray English word in an
 * otherwise Uzbek sentence.
 */
import { describe, expect, it } from 'vitest';
import {
  detectLanguage,
  reminderIsDue,
  REMINDER_COOLDOWN_MS,
  UZBEK_ONLY_REPLY,
  VOICE_NOT_SUPPORTED_REPLY,
} from '../../src/modules/engine/language.js';

describe('detectLanguage — confidently Uzbek', () => {
  it.each([
    ['Assalomu alaykum, kurs narxi qancha?', 'greeting + price question'],
    ['Men haydovchilik kursiga yozilmoqchiman', 'registration intent'],
    ["B toifa uchun narx qancha bo'ladi?", 'category question'],
    ['Salom, sizda qanday kurslar bor?', 'services question'],
    ['Ertaga kelsam bo‘ladimi, soat nechida ishlaysiz?', 'opening hours'],
    ['Қанча туради курс нархи?', 'Uzbek Cyrillic'],
  ])('treats %j as Uzbek (%s)', (text) => {
    expect(detectLanguage(text).verdict).toBe('uzbek');
  });
});

describe('detectLanguage — confidently not Uzbek', () => {
  it.each([
    ['Hello, how much does the course cost?', 'English'],
    ['Please tell me what the price is for your course', 'English'],
    ['Здравствуйте, сколько стоит курс?', 'Russian'],
    ['Что это такое и сколько это стоит для меня', 'Russian'],
  ])('treats %j as other (%s)', (text) => {
    expect(detectLanguage(text).verdict).toBe('other');
  });
});

describe('detectLanguage — not confident enough to interrupt', () => {
  // Every one of these would produce an absurd "please write in Uzbek" reply.
  it.each([
    ['ok', 'one word'],
    ['+998 90 123 45 67', 'a phone number'],
    ['👍👍', 'emoji only'],
    ['B', 'a bare category'],
    ['', 'empty'],
    ['https://example.com/page', 'a bare link'],
    ['Akobir', 'a name'],
  ])('leaves %j undetermined (%s)', (text) => {
    expect(detectLanguage(text).verdict).toBe('undetermined');
  });

  it('does not flag an Uzbek sentence containing an English loanword', () => {
    // "online" is in neither list; the Uzbek markers must still win.
    expect(detectLanguage("Salom, online kurs bormi va narxi qancha?").verdict).toBe('uzbek');
  });

  it('does not flag Uzbek written with the oʻ/gʻ digraphs the word list misses', () => {
    expect(detectLanguage("Bugun bo'sh o'rin bormi degan savolim bor edi").verdict).toBe('uzbek');
  });
});

describe('reminder cooldown', () => {
  it('sends the first reminder', () => {
    expect(reminderIsDue(null)).toBe(true);
    expect(reminderIsDue(undefined)).toBe(true);
  });

  it('does not repeat itself within the cooldown', () => {
    const justNow = new Date().toISOString();
    expect(reminderIsDue(justNow)).toBe(false);
  });

  it('allows another one after the cooldown', () => {
    const old = new Date(Date.now() - REMINDER_COOLDOWN_MS - 1000).toISOString();
    expect(reminderIsDue(old)).toBe(true);
  });

  it('sends rather than stays silent when the stored timestamp is unreadable', () => {
    expect(reminderIsDue('not-a-date')).toBe(true);
  });
});

describe('policy replies', () => {
  it('are written in Uzbek and ask for Uzbek text', () => {
    expect(UZBEK_ONLY_REPLY).toMatch(/o'zbek tilida/i);
    expect(VOICE_NOT_SUPPORTED_REPLY).toMatch(/matn/i);
    expect(VOICE_NOT_SUPPORTED_REPLY).toMatch(/o'zbek tilida/i);
  });

  it('never claims the voice message was understood', () => {
    expect(VOICE_NOT_SUPPORTED_REPLY.toLowerCase()).not.toMatch(/eshitdim|tushundim/);
  });
});
