-- Outreach Platform schema
-- Design principle: ONE event timeline (see `events`) is the source of truth for
-- sent/opened/clicked/booked/replied/bounced. Analytics, "history", and "logs" are all
-- just different views/filters over this same table — not separate features that can
-- drift out of sync with each other.

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  openrouter_api_key_enc  TEXT,
  openrouter_model        TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A user can connect more than one mailbox (e.g. one per client type/domain, for
-- deliverability separation). Sending identity is explicit per campaign, not implicit.
CREATE TABLE IF NOT EXISTS mailbox_connections (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,                 -- e.g. "Spacemail – sales@"
  imap_host      TEXT NOT NULL,
  imap_port      INTEGER NOT NULL DEFAULT 993,
  imap_secure    BOOLEAN NOT NULL DEFAULT true,
  smtp_host      TEXT NOT NULL,
  smtp_port      INTEGER NOT NULL DEFAULT 465,
  smtp_secure    BOOLEAN NOT NULL DEFAULT true,
  username       TEXT NOT NULL,
  password_enc   TEXT NOT NULL,                 -- encrypted at rest, see lib/crypto.js
  from_name      TEXT,
  from_email     TEXT NOT NULL,
  sent_folder    TEXT NOT NULL DEFAULT 'Sent',  -- IMAP folder to append sent mail into
  is_default     BOOLEAN NOT NULL DEFAULT false,
  daily_send_cap INTEGER NOT NULL DEFAULT 150,  -- deliverability guardrail per identity
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Client type = the segment. Carries its own generation scaffolding, so the LLM is
-- filling a proven skeleton per segment rather than free-writing from nothing each time.
CREATE TABLE IF NOT EXISTS client_types (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,               -- e.g. "Immigration consultancies - cold"
  description       TEXT,
  tone_notes        TEXT,                        -- "direct, no fluff, 90 words max"
  skeleton          TEXT,                         -- structural template the LLM fills in
  default_sequence_id UUID,                       -- FK added after sequences table exists
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Curated few-shot examples per client type, used to ground generation quality.
CREATE TABLE IF NOT EXISTS client_type_examples (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_type_id UUID NOT NULL REFERENCES client_types(id) ON DELETE CASCADE,
  subject        TEXT NOT NULL,
  body           TEXT NOT NULL,
  note           TEXT,                            -- why this example is "good"
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  name            TEXT,
  company        TEXT,
  client_type_id UUID REFERENCES client_types(id),
  custom_fields  JSONB NOT NULL DEFAULT '{}',      -- arbitrary personalization fields
  unsubscribed   BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, email)
);

-- Assets = links (demo, booking) and files (one-pagers, case studies), taggable per
-- client type/category so generation picks relevant ones instead of attaching everything.
CREATE TABLE IF NOT EXISTS assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,                     -- "Book a demo", "Case study - Acme"
  kind          TEXT NOT NULL CHECK (kind IN ('link','file')),
  category      TEXT NOT NULL DEFAULT 'other'
                CHECK (category IN ('demo','booking','case_study','pricing','one_pager','other')),
  url           TEXT,                              -- for kind='link'
  file_path     TEXT,                               -- for kind='file' (stored path)
  file_name     TEXT,
  applies_to    JSONB NOT NULL DEFAULT '[]',        -- array of client_type_id, empty = all
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sequences (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  client_type_id UUID REFERENCES client_types(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_types_default_sequence'
  ) THEN
    ALTER TABLE client_types
      ADD CONSTRAINT fk_client_types_default_sequence
      FOREIGN KEY (default_sequence_id) REFERENCES sequences(id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sequence_steps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id   UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  step_order    INTEGER NOT NULL,           -- 1, 2, 3...
  delay_days    INTEGER NOT NULL DEFAULT 3, -- days after previous step (0 for step 1 = immediate)
  angle         TEXT NOT NULL,              -- "full pitch" / "short bump" / "breakup"
  subject_hint  TEXT,
  UNIQUE (sequence_id, step_order)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  client_type_id        UUID REFERENCES client_types(id),
  sequence_id           UUID REFERENCES sequences(id),
  mailbox_connection_id UUID REFERENCES mailbox_connections(id),
  status                TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','review','sending','active','paused','completed')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaign_contacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id   UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','queued','sent','skipped','failed')),
  UNIQUE (campaign_id, contact_id)
);

-- One row per contact's progress through a sequence. This is what the background
-- scheduler scans (`next_send_at <= now()`) to fire the next step.
CREATE TABLE IF NOT EXISTS enrollments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id     UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  sequence_id    UUID NOT NULL REFERENCES sequences(id),
  campaign_id    UUID REFERENCES campaigns(id),
  current_step   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','completed','stopped','bounced','replied','error')),
  next_send_at   TIMESTAMPTZ,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every outbound/inbound message. Outbound rows are what generation produces and what
-- gets appended to the IMAP Sent folder; inbound rows are populated by the reply poller.
CREATE TABLE IF NOT EXISTS messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id        UUID REFERENCES contacts(id),
  campaign_id       UUID REFERENCES campaigns(id),
  enrollment_id     UUID REFERENCES enrollments(id),
  mailbox_connection_id UUID REFERENCES mailbox_connections(id),
  direction         TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','queued','sent','failed','bounced')),
  subject           TEXT,
  body_text         TEXT,
  body_html         TEXT,
  tracking_id       UUID DEFAULT gen_random_uuid(),
  message_id_header TEXT,                     -- RFC822 Message-ID, for threading
  in_reply_to       TEXT,
  imap_uid          TEXT,                     -- UID once appended/seen in IMAP
  generated_by_ai   BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Draft vs. what was actually sent, kept side by side so edits become training signal
-- for prompt/template improvement instead of being thrown away.
CREATE TABLE IF NOT EXISTS generation_feedback (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id     UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  draft_subject  TEXT,
  draft_body     TEXT,
  final_subject  TEXT,
  final_body     TEXT,
  was_edited     BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The single event timeline: sent/opened/clicked/booked/replied/bounced.
CREATE TABLE IF NOT EXISTS events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id     UUID REFERENCES messages(id) ON DELETE CASCADE,
  contact_id     UUID REFERENCES contacts(id),
  campaign_id    UUID REFERENCES campaigns(id),
  enrollment_id  UUID REFERENCES enrollments(id),
  type           TEXT NOT NULL
                 CHECK (type IN ('sent','opened','clicked','booked','replied','bounced','unsubscribed')),
  url            TEXT,                        -- for 'clicked'/'booked'
  meta           JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Background jobs (bulk sends, campaign launches) so the API returns instantly and
-- the UI polls progress instead of holding one HTTP request open for a whole batch.
-- The worker sends ONE item per tick with jittered delay (see lib/sendJobWorker.js) —
-- this both keeps request handling non-blocking and spreads sends over time, which is
-- friendlier to deliverability than the old app's flat 50-in-30-seconds loop.
CREATE TABLE IF NOT EXISTS send_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id           UUID REFERENCES campaigns(id),
  mailbox_connection_id UUID REFERENCES mailbox_connections(id),
  status        TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','completed','failed','cancelled')),
  total         INTEGER NOT NULL DEFAULT 0,
  sent_count    INTEGER NOT NULL DEFAULT 0,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS send_job_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL REFERENCES send_jobs(id) ON DELETE CASCADE,
  message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  error       TEXT,
  item_order  INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_send_job_items_pending ON send_job_items(job_id, item_order) WHERE status = 'pending';

-- Which assets a generated message actually used — persisted at generation time so the
-- send step (which may happen much later, via a background job) knows which files to
-- attach and which links were meant to be tracked, without re-deriving it from text.
CREATE TABLE IF NOT EXISTS message_assets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  asset_id    UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, asset_id)
);

CREATE TABLE IF NOT EXISTS tracked_links (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  target_url   TEXT NOT NULL,
  asset_id     UUID REFERENCES assets(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_user_created ON events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_message ON events(message_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrollments_next_send ON enrollments(next_send_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_contacts_client_type ON contacts(client_type_id);

-- ---------------------------------------------------------------------------
-- Schema evolution: CREATE TABLE IF NOT EXISTS only helps on a fresh database —
-- it does nothing to a table that already exists but predates a new column. Any
-- column added after a table's initial CREATE TABLE block must also get an explicit
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS here so `npm run migrate` stays safe to
-- re-run against a database created by an earlier version of this file.
-- ---------------------------------------------------------------------------
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mailbox_connection_id UUID REFERENCES mailbox_connections(id);
ALTER TABLE send_jobs ADD COLUMN IF NOT EXISTS mailbox_connection_id UUID REFERENCES mailbox_connections(id);
ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS error TEXT;
-- File bytes live in Postgres, not local disk — a PaaS filesystem (Railway, etc.) is
-- ephemeral and wipes local files on every redeploy/restart, which would silently lose
-- every uploaded case study / one-pager. Storing small attachment-sized files as bytea
-- keeps them durable without needing a separate object-storage dependency.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS file_data BYTEA;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS openrouter_api_key_enc TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS openrouter_model TEXT;
