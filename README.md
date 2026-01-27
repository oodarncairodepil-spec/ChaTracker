# WalleTracker 🤖💰

A production-ready "chat-based financial tracker" where transactions are ingested from labeled Gmail emails via Make.com, parsed into structured transaction records in Supabase, then finalized inside Telegram chat.

## 🚀 Features

- **Automated Ingestion**: Gmail → Make.com → Supabase Edge Function.
- **Smart Parsing**: Extracts amount, merchant, date, and source of fund from email body.
- **Telegram Bot**:
  - Receive notifications for new transactions.
  - Categorize expenses with inline buttons.
  - Manual entry flow (`/new`).
  - Monthly reports (`/budget`, `/month`).
  - Today's summary (`/today`).
- **Data Warehouse**: Stores raw emails and structured financial data in Postgres.

## 🛠 Tech Stack

- **Database**: Supabase (PostgreSQL)
- **Ingestion**: Supabase Edge Functions (Deno)
- **Bot/Web**: Next.js (Vercel)
- **Automation**: Make.com
- **Chat**: Telegram Bot API

---

## 📦 Project Structure

```
.
├── supabase/
│   ├── functions/
│   │   └── email-ingest/    # Deno Edge Function for parsing
│   ├── migrations/          # SQL schema
│   └── seeds.sql            # Default categories
├── src/
│   ├── app/
│   │   └── api/
│   │       └── telegram/    # Telegram Webhook
│   ├── lib/                 # Shared logic (Supabase client, Bot logic)
│   └── utils/               # Helpers
├── examples/                # Test fixtures
└── tests/                   # Unit tests
```

---

## ⚡ Setup Guide

### 1. Supabase Setup

1. Create a new Supabase project.
2. Go to **SQL Editor** and run `supabase/migrations/20240101000000_init_schema.sql`.
   - *Note: This is safe to run on existing DBs (uses `IF NOT EXISTS`).*
3. Run `supabase/seeds.sql` to populate categories.
4. Get your `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

### 2. Deploy Edge Function

1. Install Supabase CLI.
2. Login: `supabase login`
3. Link project: `supabase link --project-ref <your-project-id>`
4. Set secrets:
   ```bash
   supabase secrets set INGEST_API_KEY=your-secret-key
   supabase secrets set TELEGRAM_BOT_TOKEN=your-bot-token
   supabase secrets set TELEGRAM_CHAT_ID=your-user-id
   ```
5. Deploy:
   ```bash
   supabase functions deploy email-ingest
   ```
6. Note the URL: `https://<project-ref>.supabase.co/functions/v1/email-ingest`

### 3. Telegram Bot Setup

1. Chat with `@BotFather` on Telegram to create a new bot.
2. Get the **API Token**.
3. Set `TELEGRAM_BOT_TOKEN` in your `.env` and Supabase secrets.
4. Generate a random secret for webhook security (e.g. `openssl rand -hex 32`) and set it as `TELEGRAM_WEBHOOK_SECRET`.

### 4. Vercel Deployment (Bot Logic)

1. Push this repo to GitHub.
2. Import to Vercel.
3. Set Environment Variables in Vercel:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET`
4. Deploy.
5. Set the Telegram Webhook to your Vercel URL:
   ```bash
   curl -F "url=https://your-vercel-app.vercel.app/api/telegram/webhook" \
        -F "secret_token=your-webhook-secret" \
        https://api.telegram.org/bot<YOUR-BOT-TOKEN>/setWebhook
   ```

### 5. Make.com Scenario Setup

1. **Trigger**: Gmail "Watch Emails"
   - Label: `WalleTracker`
2. **Action**: HTTP "Make a request"
   - URL: `[Your Edge Function URL]`
   - Method: `POST`
   - Headers:
     - `Content-Type`: `application/json`
     - `x-api-key`: `[Your INGEST_API_KEY]`
   - Body type: `Raw` -> `JSON`
   - Content:
     ```json
     {
       "received_at": "{{now}}",
       "from_email": "{{sender:emailAddress}}",
       "to_email": "{{to:emailAddress}}",
       "subject": "{{subject}}",
       "date_header": "{{date}}",
       "gmail_message_id": "{{messageId}}",
       "thread_id": "{{threadId}}",
       "text_body": "{{text}}",
       "html_body": "{{html}}",
       "email_label": "WalleTracker"
     }
     ```

---

## 🧪 Testing

Run unit tests for the email parser:
```bash
npm test
```

## 📝 Commands

- `/start` - Initialize bot
- `/pending` - Show transactions needing review
- `/new` - Manually add a transaction
- `/today` - Show today's spending summary
- `/budget` - Show monthly budget progress
