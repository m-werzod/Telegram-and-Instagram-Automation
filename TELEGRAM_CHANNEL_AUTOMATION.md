# 🤖 Telegram Channel Automation Setup

**NEW FEATURE:** Auto-reply to channel messages + scheduled morning/evening greetings

Status: ✅ Ready to use  
Date: 2026-10-11

---

## What's New

Your Telegram bot can now:

1. ✅ **Auto-reply to channel messages** when people ask questions
2. ✅ **Send scheduled messages** every morning and evening (or custom times)
3. ✅ **Handle multiple channels** with different messages
4. ✅ **Automatic message scheduling** with cron expressions
5. ✅ **Track execution** (last run, total runs, success rate)

---

## ⚙️ How It Works

### Channel Message Processing

- Bot joins your Telegram channel
- When users ask questions, bot auto-replies with AI responses
- Responses use the **TELEGRAM agent** instructions (Uzbek language)
- Leads are captured in CRM from channel interactions

### Scheduled Messages

- **Morning greeting:** "Assalomu alaykum! Men shu yerda yordam berishga tayyorman…"
- **Evening greeting:** "Kechki xabar: Agar qandaydir savol bo'lsa…"
- Scheduled with **cron expressions** (standard Linux format)
- Runs automatically every day at specified times
- Tracks execution history

---

## 🚀 Quick Setup

### Step 1: Get Your Channel ID

1. Open Telegram
2. Go to your channel
3. Click channel name → click the channel link
4. URL will look like: `https://t.me/avtomaktab` or `https://t.me/c/1234567890`
5. **Channel ID format:**
   - Public channels: Use `@channelname` (e.g., `@avtomaktab`)
   - Private channels: Use negative ID from URL (e.g., `-1001234567890`)

### Step 2: Add Bot to Channel

1. Go to **@BotFather** on Telegram
2. Find your bot in `/mybots`
3. Select the bot → **Edit Bot** → **Edit Commands**
4. Update commands if needed (or skip)
5. Go to your channel settings
6. Add bot as **Administrator** with these permissions:
   - [x] Post messages
   - [x] Send media
   - [x] Read channel messages

### Step 3: Create Scheduled Message (API)

Make an API request to create a scheduled message:

```bash
curl -X POST http://localhost:3299/api/scheduled-messages \
  -H "Content-Type: application/json" \
  -H "Cookie: YOUR_SESSION_COOKIE" \
  -d '{
    "channel": "telegram",
    "channelId": "@avtomaktab",
    "messageTemplate": "Assalomu alaykum! 👋 Men shu yerda yordam berishga tayyorman. Agar sizda avtomaktab kurslari, narxlar, yoki ro''yxatdan o''tish haqida savol bo''lsa — yozing!",
    "cronExpression": "0 8 * * *"
  }'
```

**Result:** Message sends at 8:00 AM daily

### Cron Expression Examples

| Expression     | Meaning               | Example          |
| -------------- | --------------------- | ---------------- |
| `0 8 * * *`    | Every day at 8:00 AM  | Morning greeting |
| `0 20 * * *`   | Every day at 8:00 PM  | Evening greeting |
| `0 9,17 * * *` | 9 AM and 5 PM daily   | Multiple times   |
| `0 8 * * 1-5`  | Weekdays only at 8 AM | Work hours       |
| `30 8 * * *`   | Every day at 8:30 AM  | Half-past hour   |

[Full cron reference](https://crontab.guru/)

---

## 📋 API Endpoints

### List scheduled messages

```bash
GET /api/scheduled-messages
Response: { messages: [...] }
```

### Get specific message

```bash
GET /api/scheduled-messages/{id}
Response: { message: {...} }
```

### Create scheduled message

```bash
POST /api/scheduled-messages
Body: {
  channel: "telegram",
  channelId: "@channel_name",
  messageTemplate: "Your message here",
  cronExpression: "0 8 * * *",
  metadata: { custom_field: "value" } // optional
}
```

### Update scheduled message

```bash
PUT /api/scheduled-messages/{id}
Body: {
  messageTemplate: "Updated message",
  cronExpression: "0 9 * * *",
  enabled: true
}
```

### Delete scheduled message

```bash
DELETE /api/scheduled-messages/{id}
```

### Test send immediately

```bash
POST /api/scheduled-messages/{id}/test-send
Response: { success: true, message: "Test send queued" }
```

---

## 💡 Example Setup: Turon Avtomaktab

```bash
# 1. Morning greeting (8 AM)
curl -X POST http://localhost:3299/api/scheduled-messages \
  -d '{
    "channel": "telegram",
    "channelId": "@avtomaktab_turon",
    "messageTemplate": "Assalomu alaykum! 🚗 Turon Avtomaktab sabahki savollaringiz uchun tayyorman.\n\nKurslar, narxlar, yozilish haqidagi barcha savollarga javob berah tayyorman. Savol bo''lsa yozing! 👋",
    "cronExpression": "0 8 * * *"
  }'

# 2. Evening greeting (8 PM)
curl -X POST http://localhost:3299/api/scheduled-messages \
  -d '{
    "channel": "telegram",
    "channelId": "@avtomaktab_turon",
    "messageTemplate": "Kechqurun! 🌙 Turon Avtomaktab akshom savollaringiz uchun har doim tayyor.\n\nHaydovchilik kurslarimiz, narxlar, jadval va ro''yxatdan o''tish haqida ma''lumot olish uchun yozing.",
    "cronExpression": "0 20 * * *"
  }'
```

---

## 🧪 Testing

### Test the message sends immediately:

```bash
POST /api/scheduled-messages/{id}/test-send
```

### Verify in Telegram

- Watch your channel
- Message should appear within 5-10 seconds
- No delays or errors

### Check execution history

```bash
GET /api/scheduled-messages/{id}
```

Look for:

- `lastRunAt`: When it last ran
- `runsCount`: Total successful sends
- `nextRunAt`: When it'll run next

---

## 📊 System Architecture

```
┌─────────────────────────────────────┐
│   Housekeeping Loop (every 15 min)  │
│   ├─ Health checks                  │
│   ├─ Session cleanup                │
│   └─ Scheduled messages ✨ NEW     │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  Scheduled Message Processor         │
│  ├─ Find due scheduled messages     │
│  ├─ Queue them for execution        │
│  └─ Calculate next run time (cron)  │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  Queue Worker (BullMQ)              │
│  ├─ Claim message                   │
│  ├─ Send to Telegram API            │
│  ├─ Update next run time            │
│  └─ Mark as complete                │
└────────────┬────────────────────────┘
             │
             ▼
       ┌──────────────┐
       │ Telegram API │
       │  /messages   │
       └──────────────┘
             │
             ▼
      ┌──────────────┐
      │ Your Channel │
      └──────────────┘
```

---

## 🔧 Configuration

### Environment Variables

No new env vars required! Uses existing:

- `TELEGRAM_BOT_TOKEN` — Already configured
- `DATABASE_URL` — Already configured
- `REDIS_URL` — Already configured

### Database

New table: `ScheduledMessage`

- Tracked automatically
- Migration runs on `npm run DB_MIGRATE`

### Queue

New job type: `scheduled-message:send`

- Integrated into existing BullMQ/inline queue
- Respects retry logic (5 attempts, exponential backoff)
- Dead-lettered if final failure

---

## ✅ Verification

### 1. Database table exists

```bash
psql -U platform -d platform -c "SELECT * FROM ScheduledMessage LIMIT 1;"
```

### 2. Scheduled message created

```bash
GET /api/scheduled-messages
# Should return: { messages: [{id, channel, messageTemplate, cronExpression, nextRunAt, ...}] }
```

### 3. Migrations applied

```bash
npm run db:migrate
# Should run: 20261011000001_scheduled_telegram_messages
```

### 4. Test send succeeded

```bash
POST /api/scheduled-messages/{id}/test-send
# Check Telegram channel for message arrival
```

---

## 🐛 Troubleshooting

| Issue                        | Solution                                                   |
| ---------------------------- | ---------------------------------------------------------- |
| "Channel not found"          | Verify bot is admin in channel + correct channel ID        |
| "Invalid cron expression"    | Check format: use https://crontab.guru                     |
| Message not sending          | Verify bot has "Post messages" permission in channel       |
| Message sends but duplicates | Check cron schedule, may overlap (shift by minutes)        |
| "500 Internal error"         | Check PostgreSQL + Redis running, check logs: `pnpm dev`   |
| Message never arrives        | Check `nextRunAt` hasn't passed, run test-send immediately |

---

## 📈 Monitoring

### Check next scheduled message

```bash
GET /api/scheduled-messages
# Look at messages sorted by nextRunAt
```

### Check execution count

```bash
GET /api/scheduled-messages/{id}
# runsCount: total successful sends
# lastRunAt: last successful send time
```

### Check logs

```bash
pnpm dev | grep -i "scheduled"
# Look for: "Scheduled message sent to chat XXX"
```

---

## 🎯 Best Practices

1. **Avoid overlapping messages**
   - Don't schedule 8:00 AM exact, use 8:05 AM
   - Different channels = different times can avoid clutter

2. **Test before production**
   - Use POST `/test-send` first
   - Verify message formatting (emojis, line breaks)

3. **Monitor execution**
   - Weekly check: `GET /api/scheduled-messages`
   - Verify `runsCount` is increasing
   - Check `lastRunAt` is recent

4. **Keep messages fresh**
   - Update monthly with seasonal content
   - Use variables/templates for dynamic content

5. **Error handling**
   - Failed messages retry up to 5 times
   - After 5 times, go to DEAD_LETTER (monitor logs)
   - Test connectivity occasionally with `/test-send`

---

## 🚀 Next Steps

1. ✅ Restart server: `pnpm dev` or `docker compose restart server`
2. ✅ Get channel ID from your Telegram channel
3. ✅ Create first scheduled message (morning greeting)
4. ✅ Test with `/test-send` endpoint
5. ✅ Create evening greeting (optional, different cron time)
6. ✅ Monitor with `GET /api/scheduled-messages`
7. ✅ Adjust message content as needed

---

## 📞 Support

For issues or questions:

- Share the error from `pnpm dev` logs
- Include the channel ID and cron expression used
- Check if bot has correct permissions in channel

---

**Channels work with:** @avtomaktab_turon, @avtomaktab, any public or private channel where your bot is admin

✨ **Now your Telegram channel is fully automated with AI and scheduled greetings!**
