# avtomaktab_turon Instagram Automation - Complete Reference

**Status:** ✅ System Ready for avtomaktab_turon  
**Date:** 2026-10-11  
**Account:** @avtomaktab_turon (Professional Instagram account)  
**Replaced:** @sherzod_usmanovv (previous configuration)

---

## 📋 What Changed

### What You Need to Do

1. **Generate** Instagram User access token (60-day token from Meta Dashboard)
2. **Connect** token via Dashboard or .env variable
3. **Enable** the two pre-configured Instagram agents
4. **Test** with a comment or DM

### What the Platform Handles Automatically

✅ Token validation and encryption  
✅ Account ID discovery  
✅ Webhook subscription (comments + DMs)  
✅ Token refresh (every 24-60 days)  
✅ Request rate limiting  
✅ Error recovery and retries  
✅ Lead capture in CRM  
✅ 24-hour DM window enforcement  
✅ 7-day private reply window

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   INSTAGRAM API (v25.0)                     │
│         graph.instagram.com (Bearer token auth)             │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ├─ GET /me → Discover account ID
                       ├─ POST /me/messages → Send DMs
                       ├─ POST /{comment}/replies → Reply to comments
                       ├─ POST /me/subscribed_apps → Enable webhooks
                       └─ GET /refresh_access_token → Auto-refresh
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
   WEBHOOKS                      PLATFORM SERVICE
   ────────                      ─────────────────
   - Comments                    - Request handling
   - Messages                    - Database ops
   - Read events                 - Agent routing
        │                             │
        └──────────────┬──────────────┘
                       │
                ┌──────▼──────┐
                │  DATABASE   │
                │ PostgreSQL  │
                │  + pgvector │
                └──────┬──────┘
                       │
        ┌──────────────┴──────────────┬──────────────┐
        ▼                             ▼              ▼
   Encrypted         Knowledge Base    Leads      Agents
   Credentials       (Courses, FAQ)    (CRM)     (Config)
    (AES-256)        (Full-text search)         (Uzbek)
```

---

## 🔐 Security Implementation

### Credential Storage

```
Raw token (input)
    ↓
AES-256-GCM encrypted
    ↓
Stored in database.ChannelConnection.credentialsEncrypted
    ↓
Never logged / never exposed in API responses
    ↓
Decrypted on-demand only for API calls
```

**Key:** 64 hex chars (32 bytes) stored in ENCRYPTION_KEY env var  
**IV:** Random per encryption  
**Auth Tag:** Verified on decryption  
**Scope:** Per tenant (isolated)

### Webhook Verification

```
Meta sends: X-Hub-Signature-256: sha256=<HMAC-SHA256>
Platform verifies:
  1. Compute HMAC-SHA256(body, app_secret)
  2. Constant-time comparison
  3. Reject if mismatch
```

**Rate Limits (Meta):**

- Comments replies: 750 calls/hour/account
- DM sends: 100 calls/second across account
- 24-hour message window enforced
- Retries: Up to 36 hours (duplicates possible)

---

## 📊 Data Flow Examples

### Comment Auto-Reply

```
Meta Webhook Delivery (POST /api/webhooks/instagram)
  ├─ Payload: {entry[].id, changes[].field="comments", value}
  ├─ Signature verified ✓
  └─ Tenant found via externalAccountId
       │
       ├─ Load agent instructions (Uzbek language policy)
       ├─ Query knowledge base (courses, FAQ, prices)
       ├─ Call AI (Claude/GPT with context)
       └─ POST /graph.instagram.com/{comment_id}/replies
             │
             └─ Reply visible in comment thread within 30s
```

### Private Reply (Comment → DM)

```
User expresses interest in comment
  │
  ├─ Agent detects: "qiziqqanlar" (interested)
  ├─ Agent sends: "Direct'ga yozing" (move to DM)
  └─ Platform sends private reply
       │
       └─ Window: 7 days from comment
          (then only works if user replies in DM)
```

### DM Auto-Reply

```
User sends DM to @avtomaktab_turon
  │
  ├─ Meta webhook delivery (POST /api/webhooks/instagram)
  ├─ Tenant found via externalAccountId
  ├─ Check: Is within 24-hour window? (yes)
  │
  ├─ Agent processes:
  │  ├─ Read: "Salom, kurs qancha turadi?" (Hi, how much is the course?)
  │  ├─ Search knowledge base: Course prices
  │  ├─ Call AI: Generate response
  │  ├─ Extract lead data: Name? Phone? Category?
  │  └─ Add to CRM as Lead
  │
  └─ Send DM reply (POST /me/messages)
       │
       └─ Delivered within 5-15s
```

---

## 🛠️ Configuration Files

### In Root Folder

| File                                  | Purpose                    | Your Action                  |
| ------------------------------------- | -------------------------- | ---------------------------- |
| `.env`                                | Environment variables      | Add `INSTAGRAM_ACCESS_TOKEN` |
| `.env.example`                        | Template with instructions | Already updated ✓            |
| `QUICK_START_INSTAGRAM.md`            | 5-minute setup guide       | Read this first              |
| `INSTAGRAM_ACCOUNT_SETUP.md`          | Detailed setup guide       | Reference as needed          |
| `INSTAGRAM_VERIFICATION_CHECKLIST.md` | Full verification          | Use for testing              |
| `docker-compose.yml`                  | Docker setup               | Unchanged                    |
| `pnpm-workspace.yaml`                 | Monorepo config            | Unchanged                    |

### In apps/server

| File                              | Purpose                                        |
| --------------------------------- | ---------------------------------------------- |
| `prisma/schema.prisma`            | Database schema (ChannelConnection model)      |
| `src/modules/channels/instagram/` | Instagram service implementation               |
| `src/api/connection-routes.ts`    | API endpoints for connections                  |
| `src/index.ts`                    | Boot-time setup (seeds INSTAGRAM_ACCESS_TOKEN) |

### In apps/dashboard

| File                                    | Purpose                  |
| --------------------------------------- | ------------------------ |
| `src/pages/Connections.tsx`             | Connection management UI |
| `src/pages/Agents.tsx`                  | Agent enable/disable UI  |
| `src/components/ChannelAccountCard.tsx` | Token input component    |
| `src/api.ts`                            | Frontend API calls       |

### In docs

| File                           | Purpose                                        |
| ------------------------------ | ---------------------------------------------- |
| `integration-notes.md`         | Full technical specifications (Meta, Telegram) |
| `deployment.md`                | Production deployment guide                    |
| `telegram-personal-account.md` | Telegram automation details                    |

---

## 🔄 Workflow Summary

### Setup (One-time)

```
1. Generate token from Meta Dashboard
2. Paste in Dashboard → Ulanishlar → Instagram
3. System validates and connects ✓
4. Enable agents (Instagram Izoh, Instagram Direct)
5. Test with comment/DM
```

### Runtime (Automatic)

```
Every time webhook arrives:
  1. Verify signature
  2. Find tenant by account ID
  3. Load agent instructions
  4. Query knowledge base
  5. Call AI provider (Claude/GPT)
  6. Send reply via Instagram API
  7. Log to CRM

Every 24+ hours:
  1. Check if token ≥ 24h old
  2. If yes: Request refresh token
  3. Update database
  4. Continue operating
```

---

## 📈 Scaling Notes

- **Multi-account:** Each tenant gets isolated ChannelConnection
- **Multi-provider:** Supports Claude, GPT, local LLMs
- **Multi-language:** Instructions stored as data (easily customizable)
- **Lead routing:** Agents escalate to humans via shouldEscalate flag
- **Rate limiting:** Respects Meta's 750 calls/hour (and other limits)
- **Reliability:** Webhook retries (up to 36 hours), request dedup, error recovery

---

## ✅ Pre-Launch Checklist

Before calling this "fully workable":

- [ ] Token generated successfully (no errors)
- [ ] Dashboard shows @avtomaktab_turon (green status)
- [ ] Both agents are ENABLED
- [ ] Test comment → received reply in Uzbek within 30s
- [ ] Test DM "Salom" → received greeting within 15s
- [ ] CRM shows test lead created
- [ ] No errors in logs (`pnpm dev | grep error`)
- [ ] Knowledge base has current content (prices, courses, FAQ)
- [ ] Team trained on monitoring/maintenance

---

## 🚨 SLAs & Responsibilities

### Platform Guarantees

- ✅ Token auto-refresh (no manual action needed)
- ✅ Webhook signature verification
- ✅ Encrypted credential storage
- ✅ 24-hour message window enforcement
- ✅ Private reply 7-day window
- ✅ Webhook retry logic (up to 36h)
- ✅ Rate limiting respect

### You Must Provide

- ✅ Valid Instagram access token (60-day, not expired)
- ✅ avtomaktab_turon must allow messages (Settings → Messages → ON)
- ✅ Knowledge base kept up-to-date (prices, courses, FAQ)
- ✅ Agent instructions tailored (customizable in Dashboard)
- ✅ Human escalation process defined (for complex queries)
- ✅ CRM monitoring (for lead quality)
- ✅ AI model selected (Claude/GPT with parameters)

### Maintenance Schedule

- **Daily:** Monitor CRM leads for quality
- **Weekly:** Review agent replies (sample checks)
- **Monthly:** Verify connection health, check logs
- **Quarterly:** Review token refresh status, update knowledge base

---

## 📞 Support Escalation

### Problem | Check First | Solution

---|---|---
Token invalid | Meta Dashboard → Generate new | Re-paste fresh token
No webhooks | App Status = LIVE? | Set to Live in Dashboard
DM not working | Instagram Messages = ON? | Enable in Instagram app
Comment no reply | Agent enabled? Model selected? | Enable + configure
Lead not captured | Knowledge base empty? | Add course/FAQ content
Rate limited | Too many calls? | Reduce reply frequency

---

## 🎯 Success Criteria

**System is "fully workable" when:**

1. ✅ avtomaktab_turon connected (Dashboard shows "CONNECTED")
2. ✅ Comments auto-replied within 30 seconds
3. ✅ DMs auto-replied within 15 seconds
4. ✅ Responses are in Uzbek language
5. ✅ Leads automatically captured in CRM
6. ✅ Human escalation triggers appropriately
7. ✅ No errors in application logs
8. ✅ Token auto-refresh working (scheduled task logged)
9. ✅ Webhook events processed successfully
10. ✅ Team can monitor and maintain without assistance

---

## 📚 Quick Reference Links

- **Quick Start (5 min):** [QUICK_START_INSTAGRAM.md](./QUICK_START_INSTAGRAM.md)
- **Detailed Setup:** [INSTAGRAM_ACCOUNT_SETUP.md](./INSTAGRAM_ACCOUNT_SETUP.md)
- **Verification:** [INSTAGRAM_VERIFICATION_CHECKLIST.md](./INSTAGRAM_VERIFICATION_CHECKLIST.md)
- **Technical Docs:** [docs/integration-notes.md](./docs/integration-notes.md)
- **Meta API Docs:** https://developers.facebook.com/docs/instagram-platform/
- **Platform Code:** `apps/server/src/modules/channels/instagram/`

---

**Generated:** 2026-10-11  
**Version:** Ready for Production  
**Status:** ✅ All systems prepared for avtomaktab_turon activation
