// Background send-job worker.
//
// Deliberately processes ONE item per tick, with a randomized delay between ticks
// (not a fixed interval) — this both keeps each tick fast/non-blocking and avoids the
// old app's pattern of blasting a fixed batch with a flat delay, which is an easy
// signature for spam filters to key on. A 50-email job spreads across many minutes,
// the way a person actually sending email would.
const db = require("./db");
const mailboxes = require("./mailboxes");
const tracking = require("./tracking");
const assetsLib = require("./assets");

const MIN_DELAY_MS = parseInt(process.env.SEND_JOB_MIN_DELAY_MS || "20000", 10);   // 20s
const MAX_DELAY_MS = parseInt(process.env.SEND_JOB_MAX_DELAY_MS || "90000", 10);   // 90s

let running = false;
let stopped = false;

function jitteredDelay() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

async function mailboxSentToday(mailboxConnectionId) {
  const result = await db.query(
    `SELECT COUNT(*)::int AS count FROM events e
     JOIN messages m ON m.id = e.message_id
     WHERE m.mailbox_connection_id = $1 AND e.type = 'sent' AND e.created_at >= date_trunc('day', now())`,
    [mailboxConnectionId]
  );
  return result.rows[0].count;
}

// Finds the oldest pending item across all active (queued/running) jobs and sends it.
// Returns true if an item was processed (so the caller can decide the next tick delay),
// false if there was nothing to do.
async function processOneItem() {
  const itemResult = await db.query(
    `SELECT sji.id AS item_id, sji.job_id, sji.message_id, sj.user_id, sj.mailbox_connection_id
     FROM send_job_items sji
     JOIN send_jobs sj ON sj.id = sji.job_id
     WHERE sji.status = 'pending' AND sj.status IN ('queued','running')
     ORDER BY sj.created_at, sji.item_order
     LIMIT 1`
  );
  const item = itemResult.rows[0];
  if (!item) return false;

  await db.query(`UPDATE send_jobs SET status = 'running', updated_at = now() WHERE id = $1 AND status = 'queued'`, [item.job_id]);

  // Scoped by user_id, not just id — this is the last line of defense before real SMTP/IMAP
  // credentials get used to send. Even if a job somehow carried a mailbox id belonging to
  // a different user (it shouldn't, since sendJobs.createJob validates this at creation
  // time), the worker must never send through a mailbox that isn't the job owner's.
  const mailboxResult = await db.query(
    `SELECT * FROM mailbox_connections WHERE id = $1 AND user_id = $2`,
    [item.mailbox_connection_id, item.user_id]
  );
  const mailbox = mailboxResult.rows[0];
  if (!mailbox) {
    await failItem(item, "Mailbox connection no longer exists.");
    return true;
  }

  const sentToday = await mailboxSentToday(item.mailbox_connection_id);
  if (sentToday >= mailbox.daily_send_cap) {
    // Leave it pending — not a failure, just deferred until the cap resets tomorrow.
    // Avoid hammering this same job every tick once capped: back off harder.
    return "capped";
  }

  const msgResult = await db.query(
    `SELECT m.*, c.email AS to_email FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE m.id = $1`,
    [item.message_id]
  );
  const message = msgResult.rows[0];
  if (!message || !message.to_email) {
    await failItem(item, "Message or recipient contact missing.");
    return true;
  }
  if (message.status === "sent") {
    // Already sent (e.g. re-run after a crash) — just mark the item done.
    await db.query(`UPDATE send_job_items SET status = 'sent', updated_at = now() WHERE id = $1`, [item.item_id]);
    return true;
  }

  try {
    const trackedContent = await tracking.prepareTrackedContent(item.user_id, message.id, message.tracking_id, {
      text: message.body_text,
      html: (message.body_html || message.body_text || "").replace(/\n/g, "<br>")
    });
    const attachments = await assetsLib.getAttachmentsForMessage(item.user_id, message.id);
    const result = await mailboxes.sendAndArchive(item.user_id, item.mailbox_connection_id, {
      to: message.to_email,
      subject: message.subject,
      text: trackedContent.text,
      html: trackedContent.html,
      attachments
    });
    await db.query(
      `UPDATE messages SET status = 'sent', message_id_header = $2 WHERE id = $1`,
      [message.id, result.messageId]
    );
    await db.query(
      `INSERT INTO events (user_id, message_id, contact_id, campaign_id, type)
       VALUES ($1,$2,$3,$4,'sent')`,
      [item.user_id, message.id, message.contact_id, message.campaign_id]
    );
    await db.query(`UPDATE send_job_items SET status = 'sent', updated_at = now() WHERE id = $1`, [item.item_id]);
    await db.query(`UPDATE send_jobs SET sent_count = sent_count + 1, updated_at = now() WHERE id = $1`, [item.job_id]);
  } catch (e) {
    await db.query(`UPDATE messages SET status = 'failed' WHERE id = $1`, [message.id]);
    await failItem(item, e.message);
  }

  await maybeCompleteJob(item.job_id);
  return true;
}

async function failItem(item, errorMessage) {
  await db.query(`UPDATE send_job_items SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [item.item_id, errorMessage]);
  await db.query(`UPDATE send_jobs SET failed_count = failed_count + 1, updated_at = now() WHERE id = $1`, [item.job_id]);
}

async function maybeCompleteJob(jobId) {
  const remaining = await db.query(
    `SELECT COUNT(*)::int AS count FROM send_job_items WHERE job_id = $1 AND status = 'pending'`,
    [jobId]
  );
  if (remaining.rows[0].count === 0) {
    await db.query(
      `UPDATE send_jobs SET status = 'completed', updated_at = now() WHERE id = $1 AND status IN ('queued','running')`,
      [jobId]
    );
  }
}

async function tick() {
  if (stopped) return;
  try {
    const outcome = await processOneItem();
    const delay = outcome === "capped" ? Math.max(MAX_DELAY_MS, 5 * 60 * 1000) : jitteredDelay();
    setTimeout(tick, delay);
  } catch (e) {
    console.error("Send job worker tick failed:", e.message);
    setTimeout(tick, jitteredDelay());
  }
}

function start() {
  if (running) return;
  running = true;
  stopped = false;
  setTimeout(tick, jitteredDelay());
}

function stop() {
  stopped = true;
  running = false;
}

module.exports = { start, stop, processOneItem };
