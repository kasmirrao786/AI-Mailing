const db = require("./db");

// list() intentionally never selects file_data — attachment bytes can be a few MB each
// and every other screen (asset tables, generation's asset selection) only needs
// metadata. Use getFileData() to fetch bytes only when actually sending or downloading.
async function list(userId) {
  const result = await db.query(
    `SELECT id, user_id, label, kind, category, url, file_name, applies_to, created_at,
       (file_data IS NOT NULL) AS has_file
     FROM assets WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function createLink(userId, { label, category, url, appliesTo }) {
  if (!label || !url) throw new Error("Link asset needs a label and a url.");
  const result = await db.query(
    `INSERT INTO assets (user_id, label, kind, category, url, applies_to)
     VALUES ($1,$2,'link',$3,$4,$5) RETURNING id, user_id, label, kind, category, url, applies_to, created_at`,
    [userId, label, category || "other", url, JSON.stringify(appliesTo || [])]
  );
  return result.rows[0];
}

// fileBuffer/fileName come from the multer upload at the API layer. Stored as bytea in
// Postgres rather than local disk — see the schema-evolution note in db/schema.sql for why.
async function createFile(userId, { label, category, appliesTo, fileBuffer, fileName }) {
  if (!label || !fileBuffer || !fileName) throw new Error("File asset needs a label and a file.");
  const result = await db.query(
    `INSERT INTO assets (user_id, label, kind, category, file_name, file_data, applies_to)
     VALUES ($1,$2,'file',$3,$4,$5,$6) RETURNING id, user_id, label, kind, category, file_name, applies_to, created_at`,
    [userId, label, category || "other", fileName, fileBuffer, JSON.stringify(appliesTo || [])]
  );
  return result.rows[0];
}

// Fetches file bytes for one asset — used at send time to build the email attachment,
// and by the download endpoint for the person previewing/downloading it themselves.
async function getFileData(userId, id) {
  const result = await db.query(
    `SELECT file_name, file_data FROM assets WHERE id = $1 AND user_id = $2 AND kind = 'file'`,
    [id, userId]
  );
  return result.rows[0] || null;
}

async function remove(userId, id) {
  const result = await db.query(`DELETE FROM assets WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId]);
  return result.rowCount > 0;
}

// Attachments to actually send with a message — file-kind assets that were used during
// generation for this message. Returns nodemailer-ready {filename, content} objects.
async function getAttachmentsForMessage(userId, messageId) {
  const result = await db.query(
    `SELECT a.file_name, a.file_data FROM message_assets ma
     JOIN assets a ON a.id = ma.asset_id
     WHERE ma.message_id = $1 AND a.user_id = $2 AND a.kind = 'file' AND a.file_data IS NOT NULL`,
    [messageId, userId]
  );
  return result.rows.map(r => ({ filename: r.file_name, content: r.file_data }));
}

module.exports = { list, createLink, createFile, getFileData, getAttachmentsForMessage, remove };
