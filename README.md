# Instagram + Telegram AI Automation Platform

A production-grade, multi-agent AI automation platform with a unified CRM:

- **Instagram Comment Agent** — monitors comments via Meta webhooks, replies publicly,
  and moves interested buyers into DMs using the officially supported *private reply*
  (one DM per comment, 7-day window).
- **Instagram DM Agent** — full conversational agent for Instagram direct messages
  (24-hour messaging window, echo-safe, idempotent).
- **Telegram Agent** — webhook-driven Telegram bot with `secret_token` verification.
- **Unified CRM** — leads with identity resolution across channels, qualification data,
  notes, tags, statuses, manual merging.
- **Knowledge bases** — PDF/DOCX/TXT/MD/URL/text ingestion → chunking → embeddings
  (Voyage AI or OpenAI) → semantic retrieval with pgvector; full-text fallback.
- **Human handoff** — agents escalate; the conversation pauses until an operator resolves.
- **Admin dashboard** — agent ON/OFF toggles (backend-enforced), instructions editor,
  connection health, CRM, logs, and a *Manual Actions* queue that lists every step the
  platform cannot automate, with official URLs and exact instructions.

All integration behavior is built on **verified current official APIs** — see
[docs/integration-notes.md](docs/integration-notes.md) for the researched facts and sources.

## Architecture

Modular monolith (TypeScript, ESM):

```
apps/server      Fastify 5 API + webhooks + agent engine + workers (BullMQ or in-process)
apps/dashboard   React 19 + Vite admin SPA (built into the server's public/ dir)
```

- **PostgreSQL + pgvector** via Prisma (multi-tenant schema, every row carries `tenantId`)
- **Redis + BullMQ** for async webhook processing (optional — an in-process queue with
  the same retry semantics is used when `REDIS_URL` is empty)
- **Anthropic Claude** for generation (structured outputs validated with Zod before any
  action; server-side refusal fallbacks enabled on Opus 5)
- **AES-256-GCM** encryption at rest for channel tokens; scrypt password hashing;
  HttpOnly cookie sessions stored hashed in Postgres

Event pipeline (every inbound message):

```
webhook → verify (HMAC / secret token) → dedupe → persist event → ACK immediately
        → queue → load agent config + CRM + history + retrieved knowledge
        → Claude (schema-validated decision) → business & safety rules
        → controlled tools (updateLead / note / escalate) → channel send → logs
```

## Quick start (development)

Prerequisites: Node.js ≥ 22.9, pnpm, Docker (for Postgres/Redis) — or any Postgres 14+
with the `vector` extension.

```bash
# 1. Install
pnpm install

# 2. Infrastructure
docker compose up -d db redis

# 3. Configure
cp .env.example .env
# Fill in: DATABASE_URL (compose default works), ENCRYPTION_KEY, SESSION_SECRET,
# ANTHROPIC_API_KEY. Generate secrets:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"      # ENCRYPTION_KEY
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" # SESSION_SECRET

# 4. Database
pnpm db:generate
pnpm db:migrate:deploy
pnpm db:seed          # creates tenant + admin user (ADMIN_EMAIL / ADMIN_PASSWORD) + 3 agents

# 5. Run
pnpm dev              # server on :3000, dashboard dev server on :5173
```

Open http://localhost:5173 and sign in — Login `Instagram`, Password `Telegram3737`
(the seed defaults; override with `ADMIN_LOGIN` / `ADMIN_PASSWORD`). Then:

1. **Connections → Telegram**: paste a bot token from @BotFather. The platform validates
   it, encrypts it, configures the webhook (requires `APP_URL` to be a public HTTPS URL —
   use `ngrok http 3000` in development), and registers commands.
2. **Connections → Instagram**: paste a long-lived access token (see below). The platform
   validates it, discovers the account, and subscribes the account to webhook fields.
3. **Knowledge**: create a knowledge base, upload documents, test retrieval.
4. **Agents**: edit instructions/objective per agent and toggle them **ON**.
5. **Manual actions**: complete the listed Meta App Dashboard steps (exact URLs + steps).

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Run server (watch) + dashboard dev server |
| `pnpm build` | Build server (tsup) + dashboard (vite → served by the server) |
| `pnpm start` | Run the production build |
| `pnpm typecheck` | TypeScript checks for all packages |
| `pnpm lint` | ESLint for all packages |
| `pnpm test` | Unit + route tests (no external services needed) |
| `pnpm test:integration` | End-to-end flows against a real Postgres (`TEST_DATABASE_URL`) |
| `pnpm db:migrate` | Create/apply migrations in development |
| `pnpm db:migrate:deploy` | Apply migrations (production) |
| `pnpm db:seed` | Idempotent seed (tenant, admin, agents, knowledge base) |

Integration tests:

```bash
docker compose up -d db
# create a separate test database once:
docker compose exec db psql -U platform -c "CREATE DATABASE platform_test"
TEST_DATABASE_URL=postgresql://platform:platform@localhost:5432/platform_test pnpm test:integration
```

## Production deployment

See **[docs/deployment.md](docs/deployment.md)** for the full guide (Railway /
VPS single-container recommended; optional Vercel-hosted dashboard). The app
container is stateless — all state lives in Postgres (pgvector) and Redis, and
`REDIS_URL` is required in production. Quick VPS path:

```bash
cp .env.example .env   # fill everything in; APP_URL must be your public HTTPS URL
docker compose --profile app up -d --build
```

The app container applies migrations and the idempotent seed on boot (set `ADMIN_EMAIL` /
`ADMIN_PASSWORD` / `TENANT_NAME` in `.env` first), then serves the API, webhooks, and
dashboard on port 3000 — put it behind an HTTPS reverse proxy (Caddy/nginx/Traefik) at
`APP_URL`. Telegram requires ports 443/80/88/8443 with a valid certificate; Meta requires
valid HTTPS.

## Telegram setup (5 minutes)

1. In Telegram, talk to **@BotFather** → `/newbot` → choose a name and username → copy the token.
2. Dashboard → Connections → Telegram → paste the token.
3. Done. The platform calls `getMe`, `setWebhook` (with a per-connection `secret_token`),
   verifies with `getWebhookInfo`, and registers `/start`. If `APP_URL` is not public
   HTTPS yet, a Manual Action explains exactly what to do.

## Meta / Instagram setup

The platform uses the **Instagram API with Instagram Login** (graph.instagram.com) — no
Facebook Page required. One-time setup in the Meta App Dashboard:

1. https://developers.facebook.com/apps/ → **Create app** → type **Business**.
2. Add the **Instagram** product → *API setup with Instagram business login*.
3. App settings → Basic → copy **App ID** and **App secret** into `META_APP_ID` /
   `META_APP_SECRET` (note: for token generation the *Instagram App ID/secret* shown in
   the Instagram product page are separate values — the webhook signature uses the
   **Meta app secret**; if signatures fail, use the Instagram app secret shown next to
   the webhook configuration).
4. In the Instagram product page: **Generate token** next to your professional account →
   log in → copy the 60-day token → paste it in Dashboard → Connections → Instagram.
   (The platform refreshes it automatically every week.)
5. Configure webhooks (Instagram product → *Configure webhooks*):
   - Callback URL: `https://<your APP_URL>/api/webhooks/instagram`
   - Verify token: the exact value of `META_VERIFY_TOKEN` from your `.env`
   - Subscribe to fields: `comments`, `messages`
6. Switch the app to **Live** mode (webhooks are not delivered in Development mode).
7. On the phone: Instagram app → Settings → Messages and story replies → Message
   controls → Connected tools → **Allow Access to Messages** = ON.
8. For comment webhooks and messaging the general public: complete **App Review**
   (Advanced Access) for `instagram_business_basic`,
   `instagram_business_manage_comments`, `instagram_business_manage_messages`.
   With Standard Access you can fully test using accounts that hold roles on the app.

Every one of these steps also appears in the dashboard under **Manual actions** with the
official URL, exact values, and expected result.

### Instagram platform limitations (by Meta policy — not bugs)

- A business **cannot cold-DM** a user. The only comment→DM path is the *private reply*:
  **one** DM per comment, within **7 days**. After the user replies, the standard
  **24-hour** window applies to each subsequent user message.
- Comment webhooks (`comments`) require **Advanced Access** (App Review).
- DM text is limited to 1000 bytes; comment replies target top-level comments.
- The `human_agent` tag (7-day window) is App-Review-gated and restricted to human
  responses — the autonomous agents do not use it.
- No unofficial workarounds (scraping, private APIs, browser automation) are included,
  deliberately.

## Security

- Tenant isolation on every query; agents/leads/knowledge/logs are tenant-scoped.
- Channel tokens encrypted at rest (AES-256-GCM); never returned by any API; masked in UI.
- Webhooks verified: Meta `X-Hub-Signature-256` (HMAC-SHA256 over the raw body,
  constant-time compare) and Telegram `X-Telegram-Bot-Api-Secret-Token` (constant-time).
- Prompt-injection defense: platform security rules outrank operator instructions, which
  outrank knowledge and user input; user content is delimited as data; agents never see
  credentials or other tenants' data; model output is schema-validated before any action.
- Rate limiting, Helmet security headers, same-origin CORS, HttpOnly cookies,
  login throttling, audit log for operator mutations.
