# Instagram Account Setup Guide - avtomaktab_turon

## Step 1: Prepare the Instagram Account

Before connecting, ensure the **avtomaktab_turon** Instagram account has:

✅ **Account Type:** Professional (Business or Creator)  
✅ **Messages Enabled:** Settings → Messages → Message controls → Allow Access to Messages = **ON**  
✅ **Connected Tools:** Settings → Messages → Connected Tools → "Allow Access to Messages" = **ON**  
✅ **Meta Business App:** Account must be linked to a Meta Business App with:

- App ID: (get from Meta App Dashboard)
- App Secret: (get from Meta App Dashboard)
- Scopes: `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages`

---

## Step 2: Generate Instagram User Access Token

### Option A: Via Meta App Dashboard (Recommended - Fastest)

1. Go to **https://developers.facebook.com/apps/**
2. Select your Business app
3. Navigate to **Instagram → API Setup with Instagram business login**
4. Click **"Generate token"**
5. Select the **avtomaktab_turon** account
6. Approve permissions for:
   - `instagram_business_basic`
   - `instagram_business_manage_comments`
   - `instagram_business_manage_messages`
7. Copy the long-lived token (valid for 60 days; platform auto-refreshes)

### Option B: Via OAuth Flow (Alternative)

1. Reference: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/getting-started
2. This is automated if using OAuth in the dashboard (if implemented)

---

## Step 3: Connect to Platform

### Method A: Dashboard UI (Recommended)

1. Open **Dashboard** → **Ulanishlar** (Connections)
2. Click **Instagram** card
3. Paste the token in the **"Instagram access token"** field
4. Click **Connect**
5. The system will:
   - ✅ Validate the token
   - ✅ Discover account ID: `avtomaktab_turon`
   - ✅ Encrypt and store credentials
   - ✅ If switching from old account: gracefully release the old connection
   - ✅ Display: "@avtomaktab_turon"
   - ✅ Subscribe to webhooks: `comments` + `messages`

### Method B: Environment Variable + Boot-time Setup

1. Edit `.env`:

   ```bash
   INSTAGRAM_ACCESS_TOKEN=<your_60_day_token_here>
   ```

2. Restart the server:

   ```bash
   pnpm dev
   # or
   docker compose down && docker compose up
   ```

3. At startup, the platform will auto-connect and log the result

---

## Step 4: Verify Connection

### Check Dashboard Health

1. Go to **Dashboard** → **Ulanishlar** (Connections)
2. Look for Instagram card with:
   - ✅ Status: **Connected**
   - ✅ Account: **@avtomaktab_turon**
   - ✅ Health: **Green** (checks live API)

### Check Webhooks Registered

The platform automatically subscribes to these webhook fields:

- `comments` - for comment replies
- `messages` - for direct message handling

If you see webhooks working:

- ✅ Comments on posts are arriving
- ✅ Direct messages received in real-time

### Check Logs

```bash
# Development
pnpm dev

# Check for:
# ✅ "connectInstagram: token validated"
# ✅ "Instagram account user_id: XXX registered for apartamantId: XXX"
# ✅ "subscribed_fields=['comments', 'messages'] confirmed"
```

---

## Step 5: Enable Agents (If Needed)

Two Instagram agents are pre-created but disabled by default:

1. **Instagram Izoh Agenti** (Comment automation)
   - Replies to comments on posts
   - Qualifies leads from comments
   - Guides interested users to DMs

2. **Instagram Direct Agenti** (DM automation)
   - Handles incoming DMs (24-hour window rule)
   - Collects lead information
   - Writes to CRM

To enable:

1. Go to **Dashboard** → **Agentlar** (Agents)
2. Find each agent
3. Toggle **Enabled** = ON
4. Set **Model:** (Claude Sonnet / GPT-4 / etc.)
5. Click **Save**

---

## Troubleshooting

### ❌ "Access token validation failed"

- Token expired or invalid
- Account not professional/business type
- App Secret mismatch
- **Fix:** Re-generate token from Meta App Dashboard

### ❌ "Could not resolve Instagram account ID"

- Token doesn't belong to avtomaktab_turon
- Try generating token while logged in as avtomaktab_turon
- **Fix:** Ensure you're using the correct account in Meta Dashboard

### ❌ "Webhooks not arriving"

- Platform App not set to **Live** in Meta App Dashboard
- Messages setting not enabled on Instagram account
- Webhook URL not public/accessible
- **Fix:**
  - Set app to Live in Meta Dashboard
  - Enable Messages on Instagram account
  - Ensure `APP_URL` env var points to public HTTPS domain

### ❌ "Account switching failed"

- Old account release incomplete
- Previous account still has webhooks
- **Fix:**
  - Manually unsubscribe old account from Meta Dashboard
  - Check logs for details
  - Contact Turon Avtomaktab team

### ✅ All Checks Pass?

- Comments and DMs are auto-replied
- Leads appearing in CRM
- Dashboard shows green health status
- Agents responding with Uzbek instructions

---

## Security Notes

- ✅ Tokens stored **AES-256-GCM encrypted** with ENCRYPTION_KEY
- ✅ Never logged or exposed in responses
- ✅ 60-day tokens auto-refreshed by platform
- ✅ Each connection isolated per tenant
- ✅ Webhook signature verified with `instagram_app_secret`

---

## Reference Docs

- **Facebook/Meta Documentation:** https://developers.facebook.com/docs/instagram-platform/overview
- **Instagram API v25.0:** Valid until 2028-07-29
- **Token Refresh:** Auto-scheduled for tokens ≥24h old
- **Webhook Delivery:** Retried up to 36 hours; duplicates possible → server dedup applied

---

## Next Steps After Connection

1. Train the AI models (set Claude/GPT parameters in dashboard)
2. Review and customize agent instructions (Uzbek language policy)
3. Test with a comment/DM to verify responses
4. Monitor CRM lead capture for quality
5. Adjust response tone/knowledge base as needed
