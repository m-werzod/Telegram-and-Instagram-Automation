# avtomaktab_turon Instagram Account - Implementation Checklist

## ✅ System Status Verification

### Code Configuration

- [x] Agent instructions reference: **@avtomaktab_turon** (in seed.ts line 137)
- [x] Instagram Comment Agent: Pre-configured with Uzbek instructions
- [x] Instagram DM Agent: Pre-configured with Uzbek instructions
- [x] Database schema: Ready for secure credential storage (AES-256-GCM encryption)
- [x] API endpoints: `/api/connections/instagram` ready to receive token
- [x] Webhook infrastructure: Ready for `comments` + `messages` subscriptions
- [x] Token refresh system: Ready for auto-refresh after 24 hours
- [x] .env.example: Includes `INSTAGRAM_ACCESS_TOKEN` variable

### Environment Configuration

- [ ] **ACTION REQUIRED:** Add INSTAGRAM_ACCESS_TOKEN to `.env` file
- [x] Encryption key already generated: `ENCRYPTION_KEY` present in .env
- [x] Session secret configured
- [x] Database URL configured (PostgreSQL ready)

### Dashboard Pages

- [x] Connections page: Ready to accept token
- [x] Agents page: Instagram agents visible and ready to enable
- [x] Settings page: Ready for runtime configuration

---

## 🔧 Implementation Steps (For You)

### Step 1: Generate Instagram Access Token

**Who:** Account owner of avtomaktab_turon  
**Where:** https://developers.facebook.com/apps/  
**How:**

1. Login to Meta Business Suite
2. Go to your Business App
3. Navigate to Instagram → "API setup with Instagram business login"
4. Click "Generate token"
5. Select avtomaktab_turon account
6. Approve: instagram_business_basic, instagram_business_manage_comments, instagram_business_manage_messages
7. Copy the 60-day token

**Token Format:** Starts with `IGQA-` or similar, ~200+ characters

---

### Step 2: Connect Token to Platform

#### Option A: Via Dashboard (Recommended)

1. Open: http://localhost:3000 (or your deployment URL)
2. Navigate: **Ulanishlar** (Connections)
3. Click: **Instagram** card
4. Paste token into: **"Instagram access token"** field
5. Click: **"Ulash"** (Connect) button
6. Wait for green checkmark (20-30 seconds)
7. Verify: Display shows **@avtomaktab_turon**

#### Option B: Via .env + Restart

1. Edit `.env`:
   ```
   INSTAGRAM_ACCESS_TOKEN=<paste_token_here>
   ```
2. Restart server:
   ```bash
   pnpm dev
   # or: docker compose restart server
   ```
3. Check logs for: `"Instagram account connected successfully"`

---

## ✅ Verification Checklist

After connecting, verify these points:

### Connection Health

- [ ] Dashboard shows: **@avtomaktab_turon** with green status
- [ ] Health check: **CONNECTED** (not AUTH_REQUIRED or DISCONNECTED)
- [ ] Last check: Recent timestamp (updated every ~30 min)
- [ ] Display name: Shows **@avtomaktab_turon**

### Webhook Subscriptions

- [ ] Go to Meta Developer Dashboard → Your App → Webhooks
- [ ] Verify: AVtomaktab_turon account is subscribed to:
  - [x] `comments` webhook
  - [x] `messages` webhook
- [ ] Webhook URL: Points to your `APP_URL` env variable
- [ ] Webhook secret: MAC-verified with `instagram_app_secret`

### Agent Configuration

- [ ] Navigate to: **Agentlar** (Agents)
- [ ] Find: "Instagram Izoh Agenti" (Comment agent)
- [ ] Status: Can be toggled **Enabled**
- [ ] Find: "Instagram Direct Agenti" (DM agent)
- [ ] Status: Can be toggled **Enabled**

### Live Testing

1. Post to another Instagram account: @avtomaktab_turon's profile
2. Leave a comment: "Test comment from @[yourname]"
3. Wait 5-10 seconds
4. Verify: Agent replied with Uzbek text (if enabled)
5. Send Instagram DM: "Salom" (Hello)
6. Verify: Agent responds with greeting

---

## 📊 Expected System Behavior

### Comment Automation (If Enabled)

**Trigger:** Public comment on avtomaktab_turon's posts  
**Response:** Within 10-30 seconds:

- ✅ Avatar replies in the comment thread
- ✅ Captures lead data if user expresses interest
- ✅ Offers private reply to move to DMs
- ✅ Logs interaction in CRM

### DM Automation (If Enabled)

**Trigger:** Direct message from Instagram user  
**Response:** Within 5-15 seconds:

- ✅ Greets user
- ✅ Addresses their question (from knowledge base)
- ✅ Collects lead info: name, phone, course interest, location
- ✅ Stores in CRM with lead status
- ✅ Routes to human if needed

### Scheduled Tasks

- **Hourly:** Token health check
- **Every 24h:** Check if token needs refresh (if ≥24h old)
- **Real-time:** Webhook processing for comments/messages
- **Per-lead:** Auto-routing to human when shouldEscalate=true

---

## 🚨 Troubleshooting

### Problem: "Token validation failed"

**Check:**

- [ ] Token is for avtomaktab_turon (not another account)
- [ ] Account is Professional (Business/Creator type)
- [ ] App permissions approved in Meta Dashboard
- [ ] Token not expired

**Solution:**

```bash
# Re-generate token from Meta Dashboard
# Copy fresh token, clear old one, try again
```

### Problem: "Webhooks not arriving"

**Check:**

- [ ] App Status: **LIVE** (not Development) in Meta Dashboard
- [ ] APP_URL: Set to public HTTPS domain (not localhost)
- [ ] Instagram Settings → Messages → "Allow Access" = ON
- [ ] Platform logs show webhook signature verification passing

**Solution:**

```bash
# Check logs:
pnpm dev | grep -i webhook
# Look for: "Webhook signature verified" or "Webhook processing error"
```

### Problem: "Avatar not replying"

**Check:**

- [ ] Agent: **Enabled** in Dashboard
- [ ] Model: Selected (Claude/GPT/etc.)
- [ ] Knowledge base: Has content
- [ ] Connection: Status is green
- [ ] Rate limits: Not exceeded (Meta limits ~750 calls/hr)

**Solution:**

- Enable agent if disabled
- Check logs for errors
- Verify knowledge base has aktual content
- Wait a few seconds (some delay is normal)

### Problem: "Can't find old account (@sherzod_usmanovv)"

**Status:** This is expected if it was already removed  
**Action:** No action needed - system cleanly switches to new account

---

## 📋 Final Checklist

Before considering this COMPLETE:

- [ ] **Token Generated:** 60-day Instagram User access token obtained
- [ ] **Connected:** Token accepted by platform
- [ ] **Display Name:** "@avtomaktab_turon" visible in Dashboard → Ulanishlar
- [ ] **Health Check:** Status shows CONNECTED (green)
- [ ] **Webhooks Verified:** Comments and DMs arriving in real-time
- [ ] **Agents Enabled:** Comment and DM agents toggled on
- [ ] **Test Comment:** Posted a comment, received reply within 30 sec
- [ ] **Test DM:** Sent "Salom", received greeting response
- [ ] **CRM Tested:** Leads appearing in Dashboard → Leads when submitted
- [ ] **Logs Clean:** No errors in pnpm dev output
- [ ] **Documentation:** Team knows how to monitor/maintain

---

## 📞 Support Contacts

If any step fails:

1. **Meta App Issues:** https://developers.facebook.com/support
2. **Platform Logs:** Run `pnpm dev` and share error output
3. **Database Issues:** Check PostgreSQL is running: `psql -U platform -d platform`
4. **Webhook Debug:** Check Meta Dashboard → Apps → Your App → Webhooks → Recent deliveries

---

## 🎯 Success Criteria

✅ **System is fully workable when:**

- avtomaktab_turon account successfully connected
- Both Instagram agents enabled and responding
- Webhook events processed in real-time
- Comments and DMs auto-replied with Uzbek text
- Lead data captured in CRM
- No errors in logs
- Can manually test and receive responses within 30 seconds

---

Generated: 2026-10-11  
Project: Telegram and Instagram Automation - Turon Avtomaktab  
Account: avtomaktab_turon (replacing previous configuration)
