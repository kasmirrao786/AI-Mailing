const crypto = require("crypto");
const db = require("./db");
const campaigns = require("./campaigns");

function mapRow(r) {
  return {
    id: r.id,
    batchId: r.batch_id,
    batchLabel: r.batch_label,
    rowIndex: r.row_index,
    to: r.to_email,
    company: r.company,
    contactName: r.contact_name,
    notes: r.notes,
    providedBody: r.provided_body || "",
    clientProfileId: r.client_profile_id || "",
    createdAt: r.created_at.toISOString()
  };
}

// Persists a freshly-parsed batch. The batch id IS the campaign id — the
// campaign exists as a real object from the moment of upload, not just a
// label attached later. Returns { batchId, rows }.
async function createBatch(userId, label, rows) {
  const batchId = crypto.randomUUID();
  const batchLabel = label || "";

  for (const row of rows) {
    await db.query(
      `INSERT INTO import_rows
         (id, user_id, batch_id, batch_label, row_index, to_email, company, contact_name, notes, provided_body, client_profile_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        crypto.randomUUID(),
        userId,
        batchId,
        batchLabel,
        row.rowIndex || 0,
        row.to || "",
        row.company || "",
        row.contactName || "",
        row.notes || "",
        row.providedBody || "",
        row.clientProfileId || null
      ]
    );
  }

  await campaigns.create(userId, batchId, batchLabel, rows.length);

  return listRows(userId, batchId);
}

// One summary row per batch — for a "Saved imports" list.
async function listBatches(userId) {
  const result = await db.query(
    `SELECT batch_id, MAX(batch_label) AS batch_label, COUNT(*) AS row_count, MIN(created_at) AS created_at
     FROM import_rows
     WHERE user_id = $1
     GROUP BY batch_id
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows.map(r => ({
    batchId: r.batch_id,
    batchLabel: r.batch_label,
    rowCount: parseInt(r.row_count, 10),
    createdAt: r.created_at.toISOString()
  }));
}

async function listRows(userId, batchId) {
  const result = await db.query(
    "SELECT * FROM import_rows WHERE user_id = $1 AND batch_id = $2 ORDER BY row_index ASC",
    [userId, batchId]
  );
  return result.rows.map(mapRow);
}

async function updateRow(userId, id, patch) {
  const fields = [];
  const params = [];
  const colMap = {
    to: "to_email",
    company: "company",
    contactName: "contact_name",
    notes: "notes",
    providedBody: "provided_body",
    clientProfileId: "client_profile_id"
  };
  for (const [jsKey, col] of Object.entries(colMap)) {
    if (patch[jsKey] !== undefined) {
      params.push(jsKey === "clientProfileId" ? (patch[jsKey] || null) : patch[jsKey]);
      fields.push(`${col} = $${params.length}`);
    }
  }
  if (!fields.length) return null;

  params.push(id, userId);
  const result = await db.query(
    `UPDATE import_rows SET ${fields.join(", ")} WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING *`,
    params
  );
  return result.rows.length ? mapRow(result.rows[0]) : null;
}

async function removeRow(userId, id) {
  const result = await db.query("DELETE FROM import_rows WHERE id = $1 AND user_id = $2", [id, userId]);
  return result.rowCount > 0;
}

async function removeBatch(userId, batchId) {
  const result = await db.query("DELETE FROM import_rows WHERE user_id = $1 AND batch_id = $2", [userId, batchId]);
  await campaigns.remove(userId, batchId);
  return result.rowCount > 0;
}

module.exports = { createBatch, listBatches, listRows, updateRow, removeRow, removeBatch };
