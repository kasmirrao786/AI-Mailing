const db = require("./db");

// Enrolling starts the clock on step 1 immediately (next_send_at = now()), so the
// scheduler picks it up on its next tick rather than requiring a separate "kick off".
async function enroll(userId, { contactId, sequenceId, campaignId }) {
  const contactResult = await db.query(`SELECT id FROM contacts WHERE id = $1 AND user_id = $2`, [contactId, userId]);
  if (!contactResult.rows.length) throw new Error("Contact not found.");
  const sequenceResult = await db.query(`SELECT id FROM sequences WHERE id = $1 AND user_id = $2`, [sequenceId, userId]);
  if (!sequenceResult.rows.length) throw new Error("Sequence not found.");
  if (campaignId) {
    const campaignResult = await db.query(`SELECT id FROM campaigns WHERE id = $1 AND user_id = $2`, [campaignId, userId]);
    if (!campaignResult.rows.length) throw new Error("Campaign not found.");
  }

  const existing = await db.query(
    `SELECT id FROM enrollments WHERE contact_id = $1 AND sequence_id = $2 AND status = 'active'`,
    [contactId, sequenceId]
  );
  if (existing.rows.length) throw new Error("This contact is already actively enrolled in this sequence.");

  const result = await db.query(
    `INSERT INTO enrollments (user_id, contact_id, sequence_id, campaign_id, current_step, status, next_send_at)
     VALUES ($1,$2,$3,$4,0,'active', now()) RETURNING *`,
    [userId, contactId, sequenceId, campaignId || null]
  );
  return result.rows[0];
}

async function enrollMany(userId, { contactIds, sequenceId, campaignId }) {
  const results = [];
  for (const contactId of contactIds) {
    try {
      const enrollment = await enroll(userId, { contactId, sequenceId, campaignId });
      results.push({ contactId, ok: true, enrollmentId: enrollment.id });
    } catch (e) {
      results.push({ contactId, ok: false, error: e.message });
    }
  }
  return results;
}

async function list(userId, { sequenceId, campaignId, status } = {}) {
  const conditions = ["e.user_id = $1"];
  const params = [userId];
  if (sequenceId) { params.push(sequenceId); conditions.push(`e.sequence_id = $${params.length}`); }
  if (campaignId) { params.push(campaignId); conditions.push(`e.campaign_id = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`e.status = $${params.length}`); }
  const result = await db.query(
    `SELECT e.*, c.email AS contact_email, c.name AS contact_name, s.name AS sequence_name
     FROM enrollments e
     JOIN contacts c ON c.id = e.contact_id
     JOIN sequences s ON s.id = e.sequence_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY e.created_at DESC LIMIT 200`,
    params
  );
  return result.rows;
}

// Manual stop — e.g. the user wants to pull someone out regardless of reply/bounce state.
async function stop(userId, id) {
  const result = await db.query(
    `UPDATE enrollments SET status = 'stopped', next_send_at = NULL
     WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING id`,
    [id, userId]
  );
  return result.rowCount > 0;
}

module.exports = { enroll, enrollMany, list, stop };
