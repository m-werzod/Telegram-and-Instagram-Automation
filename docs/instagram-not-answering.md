# Instagram is not answering anybody — what to check, in order

Instagram is the one channel that can be **completely dead while every
indicator says it is fine**, and it is worth understanding why before touching
anything.

Telegram has two ways in: if the webhook cannot be set, the bot falls back to
long-polling and keeps working, and `getWebhookInfo` reports delivery errors on
every health check. **Instagram has no pull mode at all.** Every comment and
every direct message arrives only because Meta makes an HTTP POST to this
server. If Meta is not sending, nothing arrives, nothing errors, and nothing
anywhere looks wrong: the token is valid, the account is "connected", the agents
are green, the logs are empty — because there is nothing to log.

So: **a valid token proves this server can call Instagram. It proves nothing
about Instagram being able to call this server**, which is the direction every
customer message travels.

## Start here

Dashboard → **Ulanishlar** (Connections) → **"Instagram nega javob bermayapti?"**
→ *Tekshirishni boshlash*.

That runs every precondition live and reports each one with its evidence and
its fix. It is the same data as `GET /api/connections/instagram/diagnose`
(admin session required). Work down its failures in order; everything below is
background on what each check means.

## The checks, most common cause first

### 1. Both Instagram agents are switched OFF

The seed ships all four agents **disabled on purpose**, so that a fresh
deployment never starts auto-replying to real customers with instructions
nobody has reviewed. If they were never switched on, every comment and DM is
recorded in the dashboard and answered by nobody — which looks exactly like a
broken integration.

→ **Agentlar** (Agents) → enable *Instagram Izoh Agenti* and *Instagram Direct
Agenti*.

### 2. The app is still in Development mode

Meta delivers **no webhooks at all** for an app in Development mode. This is the
single most common cause of "nothing ever arrives".

→ https://developers.facebook.com/apps/ → your app → the Live toggle at the top.

### 3. The account is not subscribed to deliver events

Separate from the app-level webhook config, each account must be subscribed via
`POST /me/subscribed_apps`. The platform now does this automatically, reads it
back from Meta to confirm, and **re-verifies and repairs it at every boot and
every health check** — so this should no longer be able to silently stay broken.
When it cannot be established the connection reports `PERMISSION_REQUIRED`, the
"automation is down" banner fires, and a Manual Action spells out why.

If it keeps failing, the token lacks permissions: re-generate it approving all
of `instagram_business_basic`, `instagram_business_manage_comments`,
`instagram_business_manage_messages`.

### 4. The callback URL does not actually reach this server

Meta requires a public HTTPS address **on port 443** with a publicly-trusted
certificate — it rejects self-signed ones, and a custom port is not accepted.
A NAT, a shared-IP provider gateway or a firewall can accept the connection and
answer with something that is not this application at all, which is why the
check probes `/api/health` and looks for its exact response shape rather than
just a 200.

→ `APP_URL` must be that address; the callback is `APP_URL/api/webhooks/instagram`.

### 5. The app secret is wrong, so every delivery is rejected with 401

An app set up with Instagram Login carries **two** secrets — the Facebook App
Secret and a separate "Instagram app secret" — and Meta's docs do not state
which one signs Instagram webhooks. The server accepts either, so set both:
`META_APP_SECRET` and `META_IG_APP_SECRET` (Settings page or env).

A signature mismatch logs a warning naming this exact cause. From the outside a
401 on every delivery is indistinguishable from Meta sending nothing.

### 6. Comments arrive but DMs never do

That asymmetry is conclusive — the address, the secret and the token are all
correct, Meta is simply not sending messages. Almost always the account-side
toggle:

→ On the phone, Instagram app → Settings and privacy → Messages and story
replies → Message controls → **Connected tools** → *Allow Access to Messages* =
ON. With it off, Meta never delivers a single message webhook and reports no
error anywhere.

The health check measures this ratio and raises a Manual Action naming it.

### 7. Advanced Access for comment webhooks

With Standard Access, `comments` / `live_comments` webhooks are **not
delivered**, and DMs only work with users who hold a role on your app. Comment
automation for the public needs App Review for
`instagram_business_manage_comments`.

### 8. Delivered events match no connected account

Meta publishes two ids for the same professional account — `user_id` and the
app-scoped `id` from `GET /me` — and which one lands in the webhook's
`entry.id` has moved between apps and API versions. Events whose id matched
nothing used to be discarded leaving no trace (an unmatched event is stored with
no tenant, so the Logs page filtered it out).

The server now matches `entry.id` against both ids, falls back to the only
connected Instagram account when there is exactly one, and **learns the id Meta
actually uses** so later events match directly. The diagnostic reports any
events that still matched nothing.

### 9. The AI key is dead

Not an Instagram fault, but it presents as one: messages arrive and are
recorded, and no reply is ever generated — on *both* channels. The
"automation is down" banner says so on every page, and the dead-lettered
messages can be replayed from it once the key is fixed.

## What is checked automatically, and when

| When | What |
|---|---|
| Connect | Token validated, account discovered, subscription established **and read back** |
| Every boot | Subscription re-verified and repaired for every connected account |
| Every 15 min (housekeeping) | Same, plus token refresh, delivery evidence, AI key health |
| On demand | The full diagnostic above |

The 60-day token is refreshed automatically once it is older than 7 days, so it
never expires while the server is running. A refresh failure is only reported as
an outage once the token is genuinely close to its 60-day limit — a transient
failure on a young token is noted, not escalated, so the banner does not cry
wolf.
