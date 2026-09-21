# Telegram personal-account automation — investigation & decision

Researched against live official Telegram pages on 2026-09-21, every load-bearing
claim independently re-verified. This document separates **technical
feasibility** from **permission to operate**, as required.

## Decision

The platform automates the owner's **personal Telegram account** through a
**Telegram Business connected bot** ("Chat Automation") — Telegram's official,
purpose-built, consent-based mechanism — implemented over the plain Bot API.
Raw **MTProto user-session automation (a "userbot") is NOT implemented**: it is
materially restricted by Telegram's written terms and enforcement practice
(details below), and a compliant alternative with equivalent capability exists.

## The sanctioned mechanism: Telegram Business connected bots

Sources:
- https://core.telegram.org/api/bots/connected-business-bots
- https://core.telegram.org/api/business
- https://core.telegram.org/bots/features#business-bots
- https://core.telegram.org/bots/api (Bot API 10.3, 2026-08-24)
- https://telegram.org/blog/telegram-business ("connect Telegram bots that will
  process and answer messages on their behalf … or add AI assistants that
  manage their chats")
- https://telegram.org/blog/ai-bot-revolution-11-new-features (May 2026:
  "every Telegram user can connect a bot to their profile — and allow it to
  respond to messages on their behalf")

Verified facts the implementation is built on:

- The account owner connects **one** bot in **Settings → Chat Automation**
  (or Settings → Telegram Business → Chatbots). **No Premium required** since
  Bot API 10.0 (May 2026).
- The owner **scopes access**: include/exclude existing chats, new chats,
  contacts, non-contacts, specific users; per-chat pause and permanent
  per-chat disconnect. Only 1:1 private chats — never groups/channels.
- The owner grants granular **BusinessBotRights**; the platform needs only
  `can_reply` ("send and edit messages in the private chats that had incoming
  messages in the last 24 hours") — the profile/gifts/Stars rights are never
  requested.
- Bot side: **Business/Secretary Mode** must be enabled in @BotFather; updates
  (`business_connection`, `business_message`, `edited_business_message`,
  `deleted_business_messages`) arrive on the normal webhook and **must be named
  in an explicit `allowed_updates` list** (the platform does this);
  `getBusinessConnection` re-checks state; ~53 send/edit methods accept
  `business_connection_id`.
- Replies appear in the chat **as the personal account** (internally flagged
  `sender_business_bot`/`via_business_connection`).
- Constraints designed around: replies only within the 24h incoming-message
  window (enforced); **no initiating new conversations**; **no pre-connection
  history**; general bot rate limits apply.

### Binding conditions (Bot Developer Terms §5.4 — https://telegram.org/tos/bot-developers)

- Use business-chat contents **only** to provide the chatbot service.
- **No disclosure to third parties *including third-party APIs* without the
  user's authorization** — sending messages to the Anthropic API therefore
  requires the account owner's explicit authorization. The platform records
  this: the connection instructions state it, and enabling the Telegram
  Personal Account Agent writes a `telegram_personal.ai_processing_consent`
  audit-log entry.
- Never conceal bot activity from the account owner; disclose retention.
- Message data is **never used for AI training** (also prohibited by API ToS 1.5).

## The rejected mechanism: MTProto user-session automation ("userbot")

Technically feasible — the Telegram API is open for building full clients, and
maintained TS libraries exist (GramJS is archived; its fork `teleproto` and
`mtcute` are current). **Not implemented**, because permission to operate is
absent or worse (all verified verbatim on live pages):

- https://core.telegram.org/api/obtaining_api_id — *"If you use the Telegram
  API for flooding, spamming, faking subscriber and view counters of channels,
  you will be banned forever"*, and *"all accounts that log in using unofficial
  Telegram API clients are automatically put under observation."*
- **API ToS 1.4** (https://core.telegram.org/api/terms) forbids *"making
  actions on behalf of the user without the user's knowledge and consent"* as
  interference with basic functionality.
- **API ToS 1.5** prohibits using data obtained from the platform *"to train,
  fine-tune or otherwise engage in the development, enhancement or deployment
  of artificial intelligence"* — wording broad enough to cover an AI
  auto-responder built on scraped user-session data.
- Enforcement is report-driven and severe for user accounts: reported accounts
  are limited to messaging saved contacts (https://telegram.org/faq), repeat
  offenders lose non-contact messaging *"forever"*
  (https://telegram.org/faq_spam); ban thresholds are undocumented-but-enforced.
- Onboarding would require the account owner's live login code + 2FA password;
  Telegram's own docs treat login-code sharing as an attack signal (codes are
  auto-invalidated if forwarded in chat; the FAQ says codes must never be
  shared "with other services or apps") — a SaaS collecting them operates
  directly against official guidance, risking the customer's personal account.

**Conclusion**: userbot automation would put the owner's personal account at
ban risk and the platform in breach of written terms, for zero capability gain
over the sanctioned route. If Telegram ever changes this posture, the agent
layer (TELEGRAM_PERSONAL) is transport-agnostic and only the delivery module
would change.

## What was implemented

- `TELEGRAM_PERSONAL` agent (independent ON/OFF, instructions, knowledge base,
  language, objective, guardrails) + `TELEGRAM_PERSONAL_CHAT` conversations.
- Webhook handling for all four business update types; connection state
  (owner, enabled, rights) persisted and shown in connection health.
- Personal-chat pipeline: owner-message guard (never replies to the owner),
  agent-OFF recording, can_reply + 24h-window enforcement, CRM identity shared
  with the bot channel (same person ⇒ one lead), knowledge retrieval, human
  handoff, per-part idempotent sends via `business_connection_id`, full
  AI/tool execution logging.
- Setup automation: everything the API allows; the two owner-only steps
  (BotFather Business Mode, Settings → Chat Automation) are exact-step Manual
  Actions that auto-resolve when the platform detects the connection.
