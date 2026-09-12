const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. This app requires a Postgres connection — set DATABASE_URL to your Railway Postgres connection string."
  );
}

// Railway's internal (private network) Postgres connection doesn't need SSL.
// Set PGSSLMODE=require if connecting to an external/public Postgres that does.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false
});

async function query(text, params) {
  return pool.query(text, params);
}

async function runMigrations() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Multiple collateral docs (one-pagers, case studies, pricing sheets...) —
  // same pattern as multi-CV in the job-application version. A user picks
  // which one grounds the AI (and whether to attach it) per email.
  await query(`
    CREATE TABLE IF NOT EXISTS collateral_files (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      content BYTEA NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS collateral_files_user_id_idx ON collateral_files(user_id);`);

  await query(`
    CREATE TABLE IF NOT EXISTS sends (
      id UUID PRIMARY KEY,
      tracking_id UUID NOT NULL UNIQUE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_email TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      contact_name TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      batch_label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'sent', -- sent | failed | bounced
      error TEXT,
      gmail_message_id TEXT,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      opened_at TIMESTAMPTZ,
      open_count INTEGER NOT NULL DEFAULT 0,
      bounced_at TIMESTAMPTZ,
      bounce_reason TEXT
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS sends_user_id_idx ON sends(user_id);`);
  await query(`CREATE INDEX IF NOT EXISTS sends_user_id_to_email_idx ON sends(user_id, to_email);`);
  await query(`CREATE INDEX IF NOT EXISTS sends_tracking_id_idx ON sends(tracking_id);`);
  await query(
    `CREATE INDEX IF NOT EXISTS sends_pending_bounce_idx ON sends(user_id, status, sent_at) WHERE status = 'sent';`
  );

  await query(`
    CREATE TABLE IF NOT EXISTS clicks (
      id UUID PRIMARY KEY,
      send_id UUID NOT NULL REFERENCES sends(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      clicked_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS clicks_send_id_idx ON clicks(send_id);`);

  await query(`
    CREATE TABLE IF NOT EXISTS usage_counters (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );
  `);

  // ---------- follow-up sequences ----------
  await query(`
    CREATE TABLE IF NOT EXISTS sequences (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS sequences_user_id_idx ON sequences(user_id);`);

  await query(`
    CREATE TABLE IF NOT EXISTS sequence_steps (
      id UUID PRIMARY KEY,
      sequence_id UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL,
      delay_days INTEGER NOT NULL DEFAULT 0,
      instructions TEXT NOT NULL DEFAULT '',
      subject_override TEXT
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS sequence_steps_sequence_id_idx ON sequence_steps(sequence_id);`);

  await query(`
    CREATE TABLE IF NOT EXISTS sequence_enrollments (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sequence_id UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
      to_email TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      contact_name TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      collateral_id UUID,
      status TEXT NOT NULL DEFAULT 'active', -- active | completed | stopped | bounced | error
      current_step_order INTEGER NOT NULL DEFAULT 1,
      next_send_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS sequence_enrollments_user_id_idx ON sequence_enrollments(user_id);`);
  await query(
    `CREATE INDEX IF NOT EXISTS sequence_enrollments_due_idx ON sequence_enrollments(status, next_send_at) WHERE status = 'active';`
  );

  // Link a send back to the sequence/step that generated it, for traceability
  // in Analytics. Nullable — ordinary one-off sends have no sequence.
  await query(`ALTER TABLE sends ADD COLUMN IF NOT EXISTS sequence_enrollment_id UUID;`);
  await query(`ALTER TABLE sends ADD COLUMN IF NOT EXISTS step_order INTEGER;`);

  // ---------- reply detection ----------
  // gmail_thread_id lets us reliably check "did anyone else post to this
  // thread" via the Gmail API — far more reliable than the bounce
  // detector's keyword-matching, since Gmail gives us this structurally.
  // Only populated for sends made via the Gmail provider.
  await query(`ALTER TABLE sends ADD COLUMN IF NOT EXISTS gmail_thread_id TEXT;`);
  await query(`ALTER TABLE sends ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;`);
  await query(
    `CREATE INDEX IF NOT EXISTS sends_pending_reply_idx ON sends(user_id, status, sent_at) WHERE status = 'sent' AND gmail_thread_id IS NOT NULL;`
  );

  // ---------- activity log ----------
  // A visible record of what the app's background processes (and the AI
  // agent) have been doing — sequence sweeps, bounce/reply checks, agent
  // actions — so none of it is a black box.
  await query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL, -- sequence | bounce | reply | agent | system
      level TEXT NOT NULL DEFAULT 'info', -- info | warn | error
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS activity_logs_user_id_idx ON activity_logs(user_id, created_at DESC);`);

  // ---------- client profiles ("kinds of clients") ----------
  // Each user can define several client types (e.g. "Study-visa consultants",
  // "Corporate immigration firms") with their own links, email format, extra
  // pitch info, and default collateral. The account-level fields in
  // user_settings (links/emailFormat/subjectTemplate/extraInfo) remain the
  // fallback "General" pitch used whenever no profile is a clear match, or a
  // user hasn't set up any profiles at all — so this is purely additive and
  // never required.
  await query(`
    CREATE TABLE IF NOT EXISTS client_profiles (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', -- short blurb the AI uses to match prospects to this type
      links JSONB NOT NULL DEFAULT '[]'::jsonb,
      email_format TEXT NOT NULL DEFAULT '', -- empty = fall back to the account default format
      subject_template TEXT NOT NULL DEFAULT '',
      extra_info TEXT NOT NULL DEFAULT '',
      default_collateral_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS client_profiles_user_id_idx ON client_profiles(user_id);`);

  // ---------- saved bulk imports ----------
  // A parsed CSV/XLSX batch is persisted here the moment it's uploaded, so
  // the row list (and any edits/deletes) survive even if the user never
  // gets around to generating or sending — previously this only ever lived
  // in the browser tab's memory and vanished on refresh.
  await query(`
    CREATE TABLE IF NOT EXISTS import_rows (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      batch_id UUID NOT NULL,
      batch_label TEXT NOT NULL DEFAULT '',
      row_index INTEGER NOT NULL DEFAULT 0,
      to_email TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      contact_name TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      client_profile_id UUID, -- manual client-type override for this row; null = auto-detect
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS import_rows_user_batch_idx ON import_rows(user_id, batch_id);`);

  // Client types now support multiple default collateral docs, not just one.
  await query(`ALTER TABLE client_profiles ADD COLUMN IF NOT EXISTS default_collateral_ids JSONB NOT NULL DEFAULT '[]'::jsonb;`);

  // ---------- campaigns ----------
  // A campaign is the real, durable object a bulk send belongs to — created
  // the moment a file is uploaded, carrying its own status and its own
  // stats (sent/opened/clicked/bounced), joined by campaign_id rather than
  // by matching a free-text label. import_rows.batch_id IS a campaign_id —
  // every uploaded batch has exactly one row here.
  await query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', -- draft | sending | sent
      row_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS campaigns_user_id_idx ON campaigns(user_id, created_at DESC);`);

  // sends.campaign_id links a sent email back to the campaign it came from,
  // for reliable per-campaign stats. Nullable — single compose sends and
  // sequence steps aren't part of a campaign.
  await query(`ALTER TABLE sends ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;`);
  await query(`CREATE INDEX IF NOT EXISTS sends_campaign_id_idx ON sends(campaign_id);`);

  // Pre-written body from a CSV/XLSX column — if set, generation is skipped
  // for that row entirely (see emailGen.generateForProspect).
  await query(`ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS provided_body TEXT NOT NULL DEFAULT '';`);

  // Click-tracking links used to embed the real destination as a visible
  // ?u=<url> query param — a "URL inside a URL" shape that many recipient
  // mail providers' spam/phishing scanners flag and block outright, since
  // it's the same shape as a classic open-redirect phishing link. Now the
  // destination is stored here and the link itself is just an opaque id.
  await query(`
    CREATE TABLE IF NOT EXISTS tracked_links (
      id TEXT PRIMARY KEY,
      tracking_id UUID NOT NULL,
      target_url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS tracked_links_tracking_id_idx ON tracked_links(tracking_id);`);
}

module.exports = { query, pool, runMigrations };
