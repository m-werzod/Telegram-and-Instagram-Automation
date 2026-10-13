# 🚀 Telegram Channel Automation - Quick Start

**Now your bot can reply to channel messages + send daily greetings!**

---

## ⚡ 3-Step Setup

### Step 1: Restart Server to Apply Changes

```bash
# Apply database migration (creates ScheduledMessage table)
npm run db:migrate

# Or with Docker:
docker compose down && docker compose up
```

✅ You'll see: `20261011000001_scheduled_telegram_messages migration complete`

### Step 2: Create Morning Greeting

```bash
curl -X POST http://localhost:3299/api/scheduled-messages \
  -H "Content-Type: application/json" \
  -H "Cookie: YOUR_SESSION_COOKIE" \
  -d '{
    "channel": "telegram",
    "channelId": "@YOUR_CHANNEL_NAME",
    "messageTemplate": "Assalomu alaykum! 👋 Sabahki savollaring uchun tayyorman!",
    "cronExpression": "0 8 * * *"
  }'
```

✅ Message will send **every day at 8:00 AM**

### Step 3: Create Evening Greeting (Optional)

```bash
curl -X POST http://localhost:3299/api/scheduled-messages \
  -H "Content-Type: application/json" \
  -H "Cookie: YOUR_SESSION_COOKIE" \
  -d '{
    "channel": "telegram",
    "channelId": "@YOUR_CHANNEL_NAME",
    "messageTemplate": "Kechqurun! 🌙 Agar savoling bo''lsa yozing!",
    "cronExpression": "0 20 * * *"
  }'
```

✅ Message will send **every day at 8:00 PM**

---

## ✅ Verify It Works

### Test send immediately

```bash
curl -X POST http://localhost:3299/api/scheduled-messages/{MESSAGE_ID}/test-send \
  -H "Cookie: YOUR_SESSION_COOKIE"
```

✅ Check your Telegram channel - message should appear in 5-10 seconds!

### List all scheduled messages

```bash
curl -X GET http://localhost:3299/api/scheduled-messages \
  -H "Cookie: YOUR_SESSION_COOKIE"
```

✅ Should show your created messages with `nextRunAt` times

---

## 🎯 What Changed

| Feature                       | Before     | After               |
| ----------------------------- | ---------- | ------------------- |
| **Channel messages**          | ❌ Ignored | ✅ Auto-reply       |
| **Scheduled messages**        | ❌ None    | ✅ Cron-based       |
| **Morning/evening greetings** | ❌ Manual  | ✅ Automatic        |
| **Multiple channels**         | ❌ No      | ✅ Yes              |
| **Execution tracking**        | ❌ None    | ✅ Last run + count |

---

## 📚 Full Documentation

See: [TELEGRAM_CHANNEL_AUTOMATION.md](./TELEGRAM_CHANNEL_AUTOMATION.md)

For:

- Detailed cron expressions
- API endpoint reference
- Troubleshooting guide
- Best practices
- Architecture diagram

---

## 🔧 Get Channel ID

**Public channel:** `@channelname` (e.g., `@avtomaktab_turon`)  
**Private channel:** Copy from channel link: `https://t.me/c/1234567890` → `-1001234567890`

---

## 💡 Example Messages

```
Morning: "Assalomu alaykum! 👋 Bugun qanday savol bo''lsa, javob berah tayyorman!"

Evening: "Kechqurun! 🌙 Avtomaktab kurslari, narxlar, yozilish haqida savol bo''lsa - yozing!"

Professional: "Salom! Turon Avtomaktab 24/7 sizning savollaring uchun tayyor. Qanday yordam bera olaman?"
```

---

## 🚨 Important

1. **Bot must be ADMIN in channel** with "Post messages" permission
2. **Restart server** after running migration
3. **Get your SESSION COOKIE** from browser DevTools → Application tab
4. **Test before production** using `/test-send` endpoint
5. **Check logs** if issues: `pnpm dev | grep scheduled`

---

## 📞 Next Questions?

- **"How do I change the message?"** → `PUT /api/scheduled-messages/{id}` with new `messageTemplate`
- **"How do I change the time?"** → Update `cronExpression` (use https://crontab.guru)
- **"How do I test?"** → `POST /api/scheduled-messages/{id}/test-send`
- **"How do I delete it?"** → `DELETE /api/scheduled-messages/{id}`
- **"Can I send multiple times daily?"** → Yes! `"0 8,14,20 * * *"` (8 AM, 2 PM, 8 PM)

---

**Your Telegram channel is now fully automated! 🎉**

Messages will send automatically every day.  
Channel questions will get AI auto-replies.  
Everything tracked in the dashboard.
