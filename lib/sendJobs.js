const db = require("./db");

// Creates a job from a set of already-drafted messages (each generated separately via
// /api/generate, possibly human-edited). The job only ever touches messages that are
// still status='draft' and belong to the requesting user — this is deliberate: it means
// generation and sending stay decoupled, so a bulk send is always "send these reviewed
// drafts," never "generate and send blind."
async function createJob(userId, { campaignId, mailboxConnectionId, messageIds }) {
  if (!Array.isArray(messageIds) || !messageIds.length) throw new Error("No messages to send.");
  if (!mailboxConnectionId) throw new Error("mailboxConnectionId is required.");

  const mailboxOwned = await db.query(`SELECT id FROM mailbox_connections WHERE id = $1 AND user_id = $2`, [mailboxConnectionId, userId]);
  if (!mailboxOwned.rows.length) throw new Error("Mailbox connection not found.");

  return db.withTransaction(async client => {
    const msgResult = await client.query(
      `SELECT id FROM messages WHERE id = ANY($1::uuid[]) AND user_id = $2 AND status = 'draft'`,
      [messageIds, userId]
    );
    const validIds = msgResult.rows.map(r => r.id);
    if (!validIds.length) throw new Error("None of the given messages are sendable drafts.");

    const jobResult = await client.query(
      `INSERT INTO send_jobs (user_id, campaign_id, mailbox_connection_id, status, total)
       VALUES ($1,$2,$3,'queued',$4) RETURNING *`,
      [userId, campaignId || null, mailboxConnectionId, validIds.length]
    );
    const job = jobResult.rows[0];

    let order = 0;
    for (const messageId of validIds) {
      await client.query(
        `INSERT INTO send_job_items (job_id, message_id, item_order) VALUES ($1,$2,$3)`,
        [job.id, messageId, order++]
      );
      await client.query(`UPDATE messages SET status = 'queued', mailbox_connection_id = $2 WHERE id = $1`, [messageId, mailboxConnectionId]);
    }
    return job;
  });
}

async function getJob(userId, id) {
  const jobResult = await db.query(`SELECT * FROM send_jobs WHERE id = $1 AND user_id = $2`, [id, userId]);
  const job = jobResult.rows[0];
  if (!job) return null;
  const itemsResult = await db.query(
    `SELECT sji.*, m.subject, c.email AS to_email
     FROM send_job_items sji
     JOIN messages m ON m.id = sji.message_id
     LEFT JOIN contacts c ON c.id = m.contact_id
     WHERE sji.job_id = $1 ORDER BY sji.item_order`,
    [id]
  );
  return { ...job, items: itemsResult.rows };
}

async function listJobs(userId) {
  const result = await db.query(`SELECT * FROM send_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId]);
  return result.rows;
}

async function cancelJob(userId, id) {
  const result = await db.query(
    `UPDATE send_jobs SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND user_id = $2 AND status IN ('queued','running') RETURNING id`,
    [id, userId]
  );
  if (!result.rowCount) return false;
  await db.query(
    `UPDATE send_job_items SET status = 'skipped', updated_at = now()
     WHERE job_id = $1 AND status = 'pending'`,
    [id]
  );
  await db.query(
    `UPDATE messages SET status = 'draft' WHERE id IN
      (SELECT message_id FROM send_job_items WHERE job_id = $1 AND status = 'skipped')`,
    [id]
  );
  return true;
}

module.exports = { createJob, getJob, listJobs, cancelJob };
