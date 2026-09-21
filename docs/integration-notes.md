# Verified integration facts (researched & fact-checked 2026-09-21)

Every fact below was read from **live official documentation** and independently
re-verified by a second pass against the cited page. These constraints drive the
implementation; if Meta/Telegram change behavior, update this file and the code
together.

## Instagram — product choice

The platform uses **Instagram API with Instagram Login** (a.k.a. Business Login
for Instagram): no Facebook Page required, host `graph.instagram.com`, Instagram
User access tokens, `instagram_business_*` permissions.
Source: https://developers.facebook.com/docs/instagram-platform/overview

- API version pinned: **v25.0** (examples in official docs; available until 2028-07-29).
- The legacy alternative (Instagram API with Facebook Login, `graph.facebook.com`,
  Page tokens, `instagram_manage_*` + `pages_*` permissions) is NOT used here.
- Instagram Basic Display API is dead (removed December 2024). Professional
  (business/creator) accounts only.

### Authentication
- Dashboard path (fastest, what this platform uses first): Meta App Dashboard →
  Instagram → "API setup with Instagram business login" → **Generate token**
  (60-day Instagram User token for accounts you own).
- OAuth path: `https://www.instagram.com/oauth/authorize` → code →
  `POST https://api.instagram.com/oauth/access_token` (short-lived, ~1 h) →
  `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token` (60 days).
- Refresh: `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`
  — token must be ≥24 h old and not expired; expired tokens cannot be refreshed.
  Source: https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token
- Scopes: `instagram_business_basic`, `instagram_business_manage_comments`,
  `instagram_business_manage_messages` (+ `_content_publish`, `_manage_insights` unused here).

### Webhooks
Source: https://developers.facebook.com/docs/instagram-platform/webhooks and
https://developers.facebook.com/docs/graph-api/webhooks/getting-started

- Verification: `GET` with `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`
  → respond 200 with the raw `hub.challenge` value.
- Signature: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(raw body, App Secret)>`.
  Computed over the **raw** body; compare constant-time.
- Payload: top-level `object: "instagram"`, `entry[]` with `entry[].id` = IG account id.
  - Comments: `entry[].changes[]`, `field: "comments"`, `value: {from{id,username},
    media{id,media_product_type}, id, parent_id?, text}`.
  - Messages: `entry[].messaging[]`: `{sender{id: IGSID}, recipient{id}, timestamp,
    message{mid, text, is_echo?}}`. Echo events (`message_echoes` field / `is_echo: true`)
    MUST be skipped to avoid reply loops.
- Per-account enablement (automated by this platform):
  `POST https://graph.instagram.com/v25.0/me/subscribed_apps?subscribed_fields=comments,messages,...`
  with the Instagram User token. Without it, no events arrive for that account.
- Delivery: respond 200 within ~5 s (messaging) — we ACK immediately and process async.
  Retries: immediate then decreasing frequency up to 36 h ⇒ duplicates possible ⇒
  server-side dedup required. Batched: up to 1000 updates per POST ⇒ iterate `entry[]`.
- **App must be Live** in the App Dashboard for webhooks to be delivered.
- **Advanced Access is required for `comments` / `live_comments` webhooks** (App Review).

### Comments
Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/

- Public reply: `POST /{ig-comment-id}/replies?message=...` — top-level comments only
  (replies to a reply re-parent to the top-level comment); cannot reply to hidden
  comments or live-video comments.
- Hide: `POST /{ig-comment-id}?hide=true|false`; Delete: `DELETE /{ig-comment-id}`.

### Private replies (the ONLY supported comment→DM path)
Source: https://developers.facebook.com/docs/instagram-platform/private-replies/

- `POST /{ig-user-id}/messages` (or `/me/messages`) with
  `{"recipient":{"comment_id":"<id>"},"message":{"text":"..."}}`.
- Window: **7 days** from the comment (live comments: only during the broadcast).
- **Exactly one private reply per comment.** Further messages only after the user
  replies in the DM thread (then the standard 24 h window applies).
- Gated by `instagram_business_manage_comments`. Rate limit: 750 calls/hour/account.
- There is **no** API to cold-DM a user who only commented. Anything else would be
  an unofficial workaround and is not implemented (spec §39).

### Direct messages
Source: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/

- Send: `POST graph.instagram.com/v25.0/{IG_ID}/messages` with
  `{"recipient":{"id":"<IGSID>"},"message":{"text":"..."}}`; text ≤ **1000 bytes** UTF-8.
- **24-hour window**: the app may only message a user within 24 h of that user's last
  message. A conversation can only be started by the user (or via private reply).
- `human_agent` tag: 7-day window, **App-Review-gated feature, human responses only** —
  not used by the autonomous agents (policy).
- User Profile API: `GET /{IGSID}?fields=username,name,...` — requires user consent
  (exists only after the user messages); a commenter's profile is NOT accessible.
- IGSID is app-scoped; obtained only from webhooks. Send rate: 100 calls/s (text).
- Standard Access: can only message people with a role on the app. Advanced Access
  (App Review + business verification) required for the general public.
- Account prerequisite: Instagram app → Settings → Messages and story replies →
  Message controls → Connected Tools → **Allow Access to Messages** = ON.
  When off, webhooks silently never arrive.

## Telegram — Bot API 10.3 (2026-08-24)

Source: https://core.telegram.org/bots/api

- `setWebhook`: `url` (HTTPS, ports 443/80/88/8443, valid cert), `secret_token`
  (1–256 chars `[A-Za-z0-9_-]`), `allowed_updates`, `drop_pending_updates`,
  `max_connections`. Telegram sends the secret in header
  **`X-Telegram-Bot-Api-Secret-Token`** on every request — verified constant-time.
- `getWebhookInfo`: `pending_update_count`, `last_error_date`, `last_error_message`
  → used for connection health checks.
- Updates: `update_id` increases sequentially (dedup key per bot; may reset after
  ≥1 week idle). At most one payload field per update (`message`, `edited_message`,
  `callback_query`, …). Undelivered updates kept max 24 h.
- `sendMessage`: `text` 1–4096 chars; we send plain text (no parse_mode) to avoid
  MarkdownV2 escaping pitfalls. `sendChatAction` (`typing`) before slow replies.
- Rate limits: ~1 msg/s per chat, 20/min per group, ~30/s overall. On 429 honor
  `parameters.retry_after` (seconds).
- `setMyCommands` ≤100 commands; `getMe` validates the token; `deleteWebhook` reverts
  to polling.
- Privacy mode is ON by default in groups (bot only sees commands/replies) — toggled
  via @BotFather `/setprivacy`, cannot be changed via API.

### Telegram Business connected bots (PERSONAL account automation)

Source: https://core.telegram.org/api/bots/connected-business-bots,
https://core.telegram.org/bots/features#business-bots — full compliance
write-up in docs/telegram-personal-account.md.

- The account owner connects ONE bot in Settings → Chat Automation (or
  Settings → Telegram Business → Chatbots). **No Premium required** since
  Bot API 10.0 (May 2026). The bot must have Business/Secretary Mode enabled
  in @BotFather.
- Owner scopes chats (include/exclude contacts, new chats, specific users) and
  grants `BusinessBotRights` — the platform uses only `can_reply` (valid only
  in chats with incoming messages in the **last 24 hours**) and
  `can_read_messages`.
- Updates on the normal webhook: `business_connection`
  (`{id, user, user_chat_id, date, rights, is_enabled}`), `business_message`,
  `edited_business_message`, `deleted_business_messages` — an explicit
  `allowed_updates` list MUST name them. `getBusinessConnection(id)` re-checks.
- Reply with `business_connection_id` on `sendMessage`/`sendChatAction`/etc.;
  the message appears as the personal account (`sender_business_bot` set).
- Constraints: no initiating new conversations, no pre-connection history,
  1:1 private chats only, general bot rate limits.
- Policy: Bot Developer Terms §5.4 — business-chat contents only for the
  chatbot service; disclosure to third-party APIs (the AI provider) requires
  the owner's authorization (recorded on agent enable); no AI training on
  message data (also API ToS 1.5). Raw MTProto userbot automation is
  deliberately NOT used — see docs/telegram-personal-account.md.

## Embeddings & retrieval

- Anthropic offers **no first-party embeddings API**; official docs recommend Voyage AI.
  Source: https://platform.claude.com/docs/en/build-with-claude/embeddings
- Voyage: `POST https://api.voyageai.com/v1/embeddings`, model **voyage-4**
  (1024 dims, 32k context). `input_type` MUST be set: `"document"` for chunks,
  `"query"` for queries. Source: https://docs.voyageai.com/docs/embeddings
- OpenAI alternative: `POST https://api.openai.com/v1/embeddings`,
  `text-embedding-3-small` (1536 dims). Source: https://developers.openai.com/api/docs/guides/embeddings
- pgvector 0.8.x: `<=>` cosine distance; Docker image `pgvector/pgvector:pg17`;
  Prisma has no native vector type → `Unsupported("vector")` + raw SQL
  (`$queryRaw` with `$1::vector` casts). Extension created in a custom migration.
