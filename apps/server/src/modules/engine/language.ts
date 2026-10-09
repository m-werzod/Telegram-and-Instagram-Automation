/**
 * Uzbek-only policy for the Telegram agents.
 *
 * The rule the owner wants is simple — answer in Uzbek, and ask anyone writing
 * in another language to switch — but applying it naively is worse than not
 * applying it at all. Two failure modes matter:
 *
 *   Nagging a customer who actually wrote Uzbek. "Ok", "+998901234567",
 *   "👍", a bare course name: none of these carry enough signal to call a
 *   language, and a reminder in reply to them reads as a broken bot.
 *
 *   Staying silent on a real question. If the verdict is anything short of
 *   confident, the agent answers normally.
 *
 * So this returns three outcomes, not two, and `undetermined` behaves exactly
 * like Uzbek: the reminder is only sent when a message is confidently NOT
 * Uzbek. Detection is deterministic and runs before the model is called —
 * asking the model to police its own language costs a generation and is not
 * reliably obeyed.
 *
 * Note Uzbek is written in both Latin and Cyrillic, so Cyrillic script alone
 * says nothing; it is the words that separate Uzbek Cyrillic from Russian.
 */

export type LanguageVerdict = 'uzbek' | 'other' | 'undetermined';

export interface LanguageCheck {
  verdict: LanguageVerdict;
  /** Short machine-readable reason, for logs and tests. */
  reason: string;
}

/** Function words that are common in Uzbek and rare elsewhere. */
const UZBEK_WORDS = new Set([
  'va', 'bilan', 'uchun', 'ham', 'yoki', 'lekin', 'ammo', 'chunki', 'agar',
  'qanday', 'qancha', 'qayer', 'qayerda', 'qachon', 'nima', 'nechta', 'kim',
  'bor', 'yoq', "yo'q", 'kerak', 'mumkin', 'bormi', 'boladi', "bo'ladi",
  'men', 'siz', 'sizda', 'sizning', 'mening', 'bizda', 'bizning',
  'salom', 'assalomu', 'alaykum', 'rahmat', 'xayr', 'iltimos', 'marhamat',
  'narx', 'narxi', 'narxlari', 'kurs', 'kurslar', 'kursga', 'haqida',
  'yozilmoqchi', 'yozilish', 'olmoqchi', 'kelmoqchi', 'bermoqchi',
  'toifa', 'haydovchilik', 'guvohnoma', 'oyda', 'kunda', 'soat',
  'yaxshi', 'zor', 'juda', 'katta', 'kichik', 'yangi', 'eski',
  'telefon', 'raqam', 'raqami', 'ism', 'ismim', 'familiya',
  'bugun', 'ertaga', 'kecha', 'hozir', 'keyin', 'avval',
  // Cyrillic Uzbek
  'ва', 'билан', 'учун', 'қанча', 'қандай', 'нима', 'керак', 'бор', 'йўқ',
  'салом', 'раҳмат', 'курс', 'нарх', 'нархи', 'мен', 'сиз', 'ҳам',
]);

/** Markers that strongly indicate a language that is NOT Uzbek. */
const FOREIGN_WORDS = new Set([
  // English
  'the', 'and', 'is', 'are', 'was', 'were', 'you', 'your', 'how', 'what',
  'when', 'where', 'which', 'please', 'hello', 'hi', 'thanks', 'thank',
  'price', 'cost', 'much', 'course', 'want', 'need', 'can', 'could', 'would',
  'about', 'with', 'for', 'have', 'does', 'do', 'tell', 'me', 'info',
  // Russian
  'что', 'как', 'сколько', 'где', 'когда', 'здравствуйте', 'привет',
  'спасибо', 'пожалуйста', 'цена', 'стоимость', 'курс', 'хочу', 'нужно',
  'можно', 'есть', 'вы', 'вас', 'ваш', 'мне', 'это', 'для', 'или',
  // Turkish (close enough to Uzbek to be worth separating explicitly)
  'merhaba', 'nasıl', 'teşekkür', 'fiyat', 'için', 'nedir',
]);

/** Letters that appear in Russian but never in Uzbek Cyrillic. */
const RUSSIAN_ONLY_LETTERS = /[ыэёъ]/i;
/** Letters that appear in Uzbek Cyrillic but never in Russian. */
const UZBEK_ONLY_LETTERS = /[ўқғҳ]/i;

/**
 * Strip everything that carries no language signal: links, mentions, numbers,
 * emoji and punctuation. A message made only of these is `undetermined`.
 */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#]\S+/g, ' ')
    .replace(/[\d+()\-_.,!?;:"«»/\\]/g, ' ')
    // Keep the apostrophe forms Uzbek uses for oʻ/gʻ.
    .replace(/[''ʻʼ]/g, "'")
    .split(/\s+/)
    .filter((w) => w.length > 1 && /[a-zа-яёЀ-ӿ]/i.test(w));
}

export function detectLanguage(text: string): LanguageCheck {
  const raw = (text ?? '').trim();
  if (!raw) return { verdict: 'undetermined', reason: 'empty' };

  const words = wordsOf(raw);
  // Too little to judge. A greeting, a phone number, "ok", an emoji — all of
  // these must flow through to the agent untouched.
  if (words.length < 3) return { verdict: 'undetermined', reason: 'too-short' };

  let uz = 0;
  let foreign = 0;
  for (const w of words) {
    if (UZBEK_WORDS.has(w)) uz++;
    else if (FOREIGN_WORDS.has(w)) foreign++;
  }

  // Script evidence, which beats single word hits in Cyrillic text.
  if (UZBEK_ONLY_LETTERS.test(raw)) uz += 2;
  if (RUSSIAN_ONLY_LETTERS.test(raw)) foreign += 2;

  // Morphology: Uzbek agglutinative suffixes are a strong Latin-script signal
  // that a word list alone would miss on unfamiliar vocabulary.
  const suffixes = words.filter((w) =>
    /(lar|ning|dan|ga|da|ni|miz|ngiz|moqchi|yapti|gan|mas)$/.test(w) && w.length > 4,
  ).length;
  if (suffixes >= 2) uz += 1;
  // Uzbek's distinctive oʻ / gʻ digraphs.
  if (/\b\w*[og]'\w*/.test(raw.toLowerCase().replace(/[''ʻʼ]/g, "'"))) uz += 1;

  if (foreign > uz && foreign >= 2) return { verdict: 'other', reason: `foreign=${foreign} uz=${uz}` };
  if (uz > 0) return { verdict: 'uzbek', reason: `uz=${uz} foreign=${foreign}` };
  // Latin text with no marker either way — could be a name, a model, an
  // address. Not confident enough to interrupt.
  return { verdict: 'undetermined', reason: `uz=${uz} foreign=${foreign}` };
}

/** The reply sent to someone writing in another language. */
export const UZBEK_ONLY_REPLY =
  "Assalomu alaykum! Iltimos, sizga to'g'ri va aniq yordam berishimiz uchun xabaringizni " +
  "o'zbek tilida yozib yuboring. Rahmat!";

/** The reply sent for a voice note or other audio we have not transcribed. */
export const VOICE_NOT_SUPPORTED_REPLY =
  "Assalomu alaykum! Iltimos, savolingizni o'zbek tilida matn ko'rinishida yozib yuboring. " +
  "Shunda sizga aniqroq yordam bera olamiz.";

/**
 * Don't repeat the same reminder at someone who is mid-conversation. One per
 * this many hours per conversation is enough to make the point.
 */
export const REMINDER_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export function reminderIsDue(lastSentIso: string | null | undefined, now = Date.now()): boolean {
  if (!lastSentIso) return true;
  const last = Date.parse(lastSentIso);
  if (Number.isNaN(last)) return true;
  return now - last >= REMINDER_COOLDOWN_MS;
}
