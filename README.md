# Outreach Platform — rebuild

Fresh rebuild of the outbound email tool. Core design decisions vs. the old app:

- **IMAP/SMTP (Spacemail-compatible), not Gmail OAuth.** `lib/mailboxes.js` sends via SMTP
  and appends the same message into the account's real IMAP `Sent` folder, so sent mail
  shows up in Spacemail's own webmail — no Google verification process needed.
- **Client types are a first-class object**, not an afterthought. Each one carries a
  generation "skeleton" and curated example emails, so the LLM fills a proven structure
  per segment instead of free-writing from nothing every time. This is the direct fix for
  the "LLM emails were poor" complaint.
- **Two-pass generation.** `lib/emailGen.js` drafts, then runs a second critique/rewrite
  pass against a concrete quality rubric (length, generic phrasing, weak CTA, irrelevant
  assets) before a human ever sees it.
- **Assets (links + files) are tagged and selected**, not manually pasted per email.
  Demo/booking links are always eligible; case studies/pricing sheets are held back for
  later sequence steps so a first-touch email doesn't read like a brochure dump.
- **One event timeline** (`events` table) is the single source of truth for
  sent/opened/clicked/booked/replied/bounced — campaigns, sequences, and analytics all
  read from it instead of three overlapping features drifting out of sync.
- **Bulk/campaign sends are background jobs** (`send_jobs` table), not a blocking HTTP
  request — this is the direct fix for the old bulk-send timeout/no-progress problem.

## Status

Built so far:
- `db/schema.sql` + `db/migrate.js` — full data model (users, mailbox_connections,
  client_types + examples, contacts, assets, sequences + steps, campaigns, enrollments,
  messages, generation_feedback, events, send_jobs, tracked_links)
- `lib/db.js` — Postgres pool
- `lib/crypto.js` — AES-256-GCM encryption for mailbox passwords / API keys at rest
- `lib/mailboxes.js` — SMTP send, IMAP Sent-folder archive, IMAP INBOX poll (reply/bounce
  detection by header, not keyword-guessing)
- `lib/mailboxConnections.js` — CRUD for mailbox connections
- `lib/openrouter.js` — LLM API client, per-user or platform key
- `lib/emailGen.js` — the two-pass, client-type-aware generation pipeline

Not built yet (next steps, in the order I'd tackle them):
1. `server.js` + auth (signup/login/session) wiring everything above into an API
2. Client type / asset / contact management endpoints
3. Send-job worker (background bulk/campaign sending with throttling + jitter)
4. Sequence scheduler (the `enrollments.next_send_at` sweep)
5. Tracking endpoints (open pixel, click redirect, booking-link detection)
6. Frontend

## Setup (once server.js exists)

```
npm install
cp .env.example .env
# fill in DATABASE_URL, CREDENTIAL_ENCRYPTION_KEY, PLATFORM_OPENROUTER_API_KEY
npm run migrate
npm start
```
