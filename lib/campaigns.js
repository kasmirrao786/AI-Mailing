const db = require("./db");

function mapRow(r) {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    rowCount: r.row_count,
    createdAt: r.created_at.toISOString()
  };
}

// Created the moment a file is uploaded — id doubles as the import batch id,
// so "the list of prospects" and "the campaign it belongs to" are the same
// object from the start, not two things joined later by a text label.
async function create(userId, id, name, rowCount) {
  await db.query(
    "INSERT INTO campaigns (id, user_id, name, status, row_count) VALUES ($1, $2, $3, 'draft', $4)",
    [id, userId, name || "", rowCount || 0]
  );
  return get(userId, id);
}

async function get(userId, id) {
  const result = await db.query("SELECT * FROM campaigns WHERE id = $1 AND user_id = $2", [id, userId]);
  return result.rows.length ? mapRow(result.rows[0]) : null;
}

async function rename(userId, id, name) {
  await db.query("UPDATE campaigns SET name = $3 WHERE id = $1 AND user_id = $2", [id, userId, name || ""]);
  return get(userId, id);
}

async function setStatus(userId, id, status) {
  await db.query("UPDATE campaigns SET status = $3 WHERE id = $1 AND user_id = $2", [id, userId, status]);
}

async function remove(userId, id) {
  const result = await db.query("DELETE FROM campaigns WHERE id = $1 AND user_id = $2", [id, userId]);
  return result.rowCount > 0;
}

// One row per campaign: status, how many prospects are in it, and real
// send stats pulled from `sends` by campaign_id — not by matching a label
// that could've been renamed, reused, or typed differently.
async function listWithStats(userId) {
  const result = await db.query(
    `SELECT
       c.id, c.name, c.status, c.row_count, c.created_at,
       COUNT(s.id) FILTER (WHERE s.status = 'sent' OR s.status = 'bounced') AS sent_count,
       COUNT(s.id) FILTER (WHERE s.opened_at IS NOT NULL) AS opened_count,
       COUNT(s.id) FILTER (WHERE s.status = 'bounced') AS bounced_count,
       COUNT(s.id) FILTER (WHERE s.status = 'failed') AS failed_count
     FROM campaigns c
     LEFT JOIN sends s ON s.campaign_id = c.id
     WHERE c.user_id = $1
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
    [userId]
  );
  return result.rows.map(r => ({
    ...mapRow(r),
    sentCount: parseInt(r.sent_count, 10),
    openedCount: parseInt(r.opened_count, 10),
    bouncedCount: parseInt(r.bounced_count, 10),
    failedCount: parseInt(r.failed_count, 10)
  }));
}

async function getStats(userId, id) {
  const list = await listWithStats(userId);
  return list.find(c => c.id === id) || null;
}

module.exports = { create, get, rename, setStatus, remove, listWithStats, getStats };
