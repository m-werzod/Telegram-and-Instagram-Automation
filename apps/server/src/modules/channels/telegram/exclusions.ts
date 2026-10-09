import { getPrisma } from '../../../db/client.js';
import { childLogger } from '../../../lib/logger.js';

/**
 * Per-chat exclusion for the personal Telegram agent.
 *
 * WHY THIS IS NOT PINNED-CHAT DETECTION
 * -------------------------------------
 * The requirement is "never auto-reply in a chat the owner has pinned". That
 * cannot be implemented against the Telegram **Bot API**, which is what this
 * platform uses (Business connections: `business_connection`, `business_message`).
 * A pinned conversation is a property of the user's own dialog list, exposed
 * only through MTProto — `messages.getPinnedDialogs` — on an authorized user
 * session. The Bot API has no equivalent method and no field for it; `Chat`
 * carries `pinned_message`, which is a pinned MESSAGE inside a chat and a
 * different thing entirely. Business connections grant message access, not
 * dialog-list or folder access.
 *
 * Claiming pinned coverage here would therefore be a lie that fails silently:
 * the owner would pin a chat, believe it was excluded, and the agent would
 * keep answering. So the platform implements the strongest supported
 * equivalent instead — an explicit exclusion the owner sets per chat, from
 * inside Telegram itself:
 *
 *     the owner types  /stop   in the chat  → agent stops replying there
 *     the owner types  /start  in the chat  → agent resumes
 *
 * It is one gesture in the same place they would pin the chat, it needs no
 * dashboard, and unlike a pin it is unambiguous. The dashboard can toggle the
 * same flag.
 *
 * FAIL CLOSED
 * -----------
 * The flag is checked twice: before the model is called, and again immediately
 * before the send. The second check is what stops a job that was queued before
 * the owner excluded the chat from delivering afterwards — the window this
 * requirement exists to close. If the state cannot be read at send time, the
 * send is abandoned rather than risked.
 */

/** Commands the owner can type in a chat to control the agent there. */
export const EXCLUDE_COMMANDS = ['/stop', '/stopai', '/off'] as const;
export const RESUME_COMMANDS = ['/start', '/startai', '/on'] as const;

export type OwnerCommand = 'exclude' | 'resume' | null;

export function parseOwnerCommand(text: string | undefined): OwnerCommand {
  const t = (text ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  if (!t.startsWith('/')) return null;
  // Strip a @botusername suffix, which Telegram appends in some clients.
  const cmd = t.split('@')[0]!;
  if ((EXCLUDE_COMMANDS as readonly string[]).includes(cmd)) return 'exclude';
  if ((RESUME_COMMANDS as readonly string[]).includes(cmd)) return 'resume';
  return null;
}

interface ConversationMetadata {
  aiExcluded?: boolean;
  aiExcludedAt?: string;
  aiExcludedBy?: 'owner_command' | 'dashboard';
  languageReminderAt?: string;
  [key: string]: unknown;
}

export function readConversationMetadata(metadata: unknown): ConversationMetadata {
  return (metadata ?? {}) as ConversationMetadata;
}

export function isExcluded(metadata: unknown): boolean {
  return readConversationMetadata(metadata).aiExcluded === true;
}

/** Set or clear the exclusion on one conversation. */
export async function setConversationExcluded(params: {
  tenantId: string;
  conversationId: string;
  excluded: boolean;
  by: 'owner_command' | 'dashboard';
}): Promise<void> {
  const prisma = getPrisma();
  const conversation = await prisma.conversation.findFirst({
    where: { id: params.conversationId, tenantId: params.tenantId },
  });
  if (!conversation) return;
  const metadata = readConversationMetadata(conversation.metadata);
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      metadata: {
        ...metadata,
        aiExcluded: params.excluded,
        aiExcludedAt: params.excluded ? new Date().toISOString() : undefined,
        aiExcludedBy: params.excluded ? params.by : undefined,
      } as never,
    },
  });
  childLogger({ module: 'telegram-personal', tenantId: params.tenantId }).info(
    { conversationId: conversation.id, excluded: params.excluded, by: params.by },
    'conversation AI exclusion changed',
  );
}

/**
 * The second gate, run immediately before a send. Re-reads the row rather
 * than trusting anything loaded earlier in the turn, because the whole point
 * is to catch a change made while the model was generating.
 *
 * Returns true when sending is allowed. A read failure returns false: for an
 * exclusion whose purpose is "never message these people", silence on error
 * is the safe direction.
 */
export async function sendStillAllowed(conversationId: string): Promise<boolean> {
  try {
    const row = await getPrisma().conversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    });
    if (!row) return false;
    return !isExcluded(row.metadata);
  } catch (err) {
    childLogger({ module: 'telegram-personal' }).warn(
      { conversationId, err: String(err) },
      'could not verify chat exclusion before sending — holding the message back',
    );
    return false;
  }
}

/** Record that the Uzbek-only reminder was just sent, for the cooldown. */
export async function markLanguageReminderSent(conversationId: string): Promise<void> {
  const prisma = getPrisma();
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { metadata: true },
  });
  if (!row) return;
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      metadata: {
        ...readConversationMetadata(row.metadata),
        languageReminderAt: new Date().toISOString(),
      } as never,
    },
  });
}
