# Production deployment guide

The platform is a **modular monolith + background workers in one stateless
container**: Fastify API + webhooks + dashboard + BullMQ workers, with ALL
state in PostgreSQL (pgvector) and Redis. Webhooks and queue workers are
long-running — they need a persistent host, never serverless.

> Deploy only after local verification passes:
> `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
> and the integration suite against a real Postgres (`pnpm test:integration`).

## Recommended: Option A — one container on a persistent host (simplest reliable)

Everything on one host: API, webhooks, workers, and the dashboard served from
the same origin (no CORS, no cookie domain issues, one deploy). Suitable hosts:
Railway, Render, Fly.io, or any Docker VPS.

### A1. Railway (fastest managed path)

1. Open **https://railway.com** → sign in with GitHub → **New Project**.
2. **Deploy from GitHub repo** → select this repository. Railway detects the
   `Dockerfile` automatically.
3. In the project: **+ Create → Database → PostgreSQL**. Then in the Postgres
   service → **Data** tab → run once:
   `CREATE EXTENSION IF NOT EXISTS vector;`
   (Railway's Postgres image ships pgvector; if the command errors, use Neon —
   see A3.)
4. **+ Create → Database → Redis**.
5. On the app service → **Variables** → add (Railway injects the database URLs
   via references):
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `REDIS_URL` = `${{Redis.REDIS_URL}}`
   - `NODE_ENV` = `production`
   - `TRUST_PROXY` = `true` (Railway terminates TLS in front of the app)
   - `APP_URL` = the public URL from **Settings → Networking → Generate
     Domain** (e.g. `https://your-app.up.railway.app`)
   - `ENCRYPTION_KEY`, `SESSION_SECRET` — generate locally:
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
   - `ANTHROPIC_API_KEY`, `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`
   - Optional: `EMBEDDINGS_PROVIDER=voyage` + `VOYAGE_API_KEY`
6. Deploy. The container runs `prisma migrate deploy` + the idempotent seed on
   boot, then starts the server.
7. **Expected result**: `https://<your domain>/api/health` returns
   `{"status":"ok","db":"ok"}`, and the dashboard sign-in page loads at the
   root URL (Login `Instagram`, Password `Telegram3737` unless you changed
   `ADMIN_LOGIN`/`ADMIN_PASSWORD`).
8. **Return**: the public domain (needed as `APP_URL` for the Meta webhook
   callback and Telegram webhook), and the `/api/health` response.

### A2. Any Docker VPS (Hetzner/DigitalOcean/…)

```bash
git clone <repo> && cd <repo>
cp .env.example .env   # fill in everything; APP_URL = https://your-domain
docker compose --profile app up -d --build
```
Put Caddy/nginx/Traefik in front for TLS at `APP_URL` and set
`TRUST_PROXY=true`. Telegram accepts webhook ports 443/80/88/8443 only.

### A3. Managed databases (either option)

- **Postgres with pgvector**: https://neon.tech (free tier, pgvector
  preinstalled — run `CREATE EXTENSION IF NOT EXISTS vector;` in the SQL
  editor) or any provider from the pgvector README.
- **Redis**: https://upstash.com (create a Redis database → copy the
  `rediss://` URL into `REDIS_URL`).

## Option B — dashboard on Vercel + backend on a persistent host

Only the static dashboard goes to Vercel; the Fastify monolith (webhooks +
workers) stays on Option A's host. The dashboard is a Vite SPA — Vercel hosts
it natively; a Next.js rewrite would add nothing (see the note below).

1. Deploy the backend exactly as in Option A (it still serves its own copy of
   the dashboard — harmless).
2. Edit [apps/dashboard/vercel.json](../apps/dashboard/vercel.json): replace
   `REPLACE-WITH-YOUR-BACKEND-DOMAIN` with your backend domain from Option A.
3. Open **https://vercel.com/new** → import the GitHub repository.
4. Configure the project:
   - **Root Directory**: `apps/dashboard`
   - Framework preset: **Vite** (auto-detected; build command and output come
     from `vercel.json`)
5. Deploy. The `/api/*` rewrite makes Vercel proxy API calls server-side to
   your backend, so the browser sees a single origin and the session cookie
   works unchanged.
6. **Expected result**: the sign-in page on `https://<project>.vercel.app`,
   and signing in works end-to-end.
7. **Return**: the Vercel URL. (Webhook URLs for Meta/Telegram keep pointing
   at the BACKEND domain, not the Vercel one.)

### Why the dashboard is not a Next.js app

The admin dashboard has no SSR/SEO/server-component needs — it is an
authenticated SPA. Vercel serves Vite static builds natively, so rewriting it
to Next.js would add a framework migration with zero functional gain,
against the "no unnecessary architecture" requirement. If Next.js features
are ever needed, the API contract in `apps/dashboard/src/api.ts` is the only
integration surface to port.

## What must never go on serverless

Webhook processing, BullMQ workers, the recovery sweep, and health-check
intervals are long-running: they live in the container (Option A host) in
every topology. Vercel functions are not used for any backend logic.
