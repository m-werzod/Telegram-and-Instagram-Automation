# ⚡ Quick Start: Connect avtomaktab_turon Instagram Account

This guide gets your new Instagram account working in < 10 minutes.

---

## Prerequisites

- ✅ avtomaktab_turon Instagram account (Professional/Business type)
- ✅ Meta Business App with Instagram app set up
- ✅ Your platform running (localhost:3000 or deployment URL)
- ✅ You are logged in as Admin

---

## 🚀 5-Minute Setup

### Step 1: Get Instagram Access Token (2 min)

1. Open: **https://developers.facebook.com/apps/**
2. Select your Business App
3. Go: **Instagram** → **"API setup with Instagram business login"**
4. Click: **"Generate token"**
5. Choose: **avtomaktab_turon** account
6. Approve all permissions
7. **Copy** the token (save somewhere safe)

▶️ **Token Example:** `IGQA-8349...` (200+ characters)

---

### Step 2: Connect Token (2 min)

**Via Dashboard (Easiest):**

1. Open Dashboard: **http://localhost:3000**
2. Login as Admin
3. Click: **Ulanishlar** (Connections) in sidebar
4. Find: **Instagram** card
5. Click: **"Ulash"** (Connect) button
6. Paste token → Click **"Ulash"**
7. ⏳ Wait 20-30 seconds for validation
8. ✅ See: **@avtomaktab_turon** (green status)

**Done!** Account is connected.

---

### Step 3: Enable Agents (1 min)

1. Click: **Agentlar** (Agents) in sidebar
2. Find: **"Instagram Izoh Agenti"** (Comments)
   - Click → **Enabled** toggle ON
   - Select Model: **Claude Sonnet** (or your preferred)
   - Click **Saqlash** (Save)
3. Find: **"Instagram Direct Agenti"** (Messages)
   - Click → **Enabled** toggle ON
   - Select Model: **Claude Sonnet**
   - Click **Saqlash** (Save)

✅ Both agents are now live and responding!

---

## 🧪 Test It (2 min)

1. **Post a comment** from another Instagram account on avtomaktab_turon's profile
2. **Wait 10-30 seconds**
3. ✅ See avatar comment reply in Uzbek

OR:

1. **Send DM** to avtomaktab_turon from another account
2. **Write:** "Salom, nə qiymatlar?" (Hello, what are the prices?)
3. **Wait 5-15 seconds**
4. ✅ Receive auto-reply with info about courses

---

## ✅ Verification

After setup, verify in Dashboard:

| Check           | Expected                      |
| --------------- | ----------------------------- |
| **Connections** | @avtomaktab_turon (green ✅)  |
| **Agents**      | Both enabled with checkmark   |
| **Health**      | CONNECTED (live API)          |
| **Manual test** | Comment/DM → Reply within 30s |

---

## 🚨 Common Issues

| Issue                  | Fix                                                          |
| ---------------------- | ------------------------------------------------------------ |
| "Token invalid"        | Re-generate from Meta Dashboard for avtomaktab_turon account |
| "Account not found"    | Ensure Instagram account is Professional type                |
| "Webhooks not working" | Set App Status to **LIVE** in Meta Dashboard                 |
| No reply to comments   | Enable agent + check logs: `pnpm dev \| grep instagram`      |
| No reply to DMs        | Ensure Instagram Messages setting is ON                      |

---

## 📞 If Issues Persist

1. **Check logs:**

   ```bash
   pnpm dev
   # Look for "instagram" or "webhook" errors
   ```

2. **Verify connection:**
   - Dashboard → Ulanishlar → Instagram
   - Click health check button
   - Should show: Last checked (recent timestamp)

3. **Reset connection:**
   - Delete existing connection
   - Re-paste token
   - Re-enable

---

## 🎉 You're Done!

Your avtomaktab_turon Instagram account is now fully automated:

- ✅ Comments auto-replied
- ✅ DMs auto-answered
- ✅ Leads captured in CRM
- ✅ 24/7 Uzbek language support
- ✅ Automatic token refresh

**Next step:** Monitor the CRM leads and adjust agent instructions as needed.

---

**Questions?** See:

- INSTAGRAM_ACCOUNT_SETUP.md (detailed guide)
- INSTAGRAM_VERIFICATION_CHECKLIST.md (full checklist)
- docs/integration-notes.md (technical details)
