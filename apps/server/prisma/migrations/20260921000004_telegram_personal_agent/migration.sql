-- Dedicated agent + conversation kind for the owner's PERSONAL Telegram
-- account (Telegram Business connection), separate from the bot channel.
ALTER TYPE "AgentType" ADD VALUE 'TELEGRAM_PERSONAL';
ALTER TYPE "ConversationKind" ADD VALUE 'TELEGRAM_PERSONAL_CHAT';
