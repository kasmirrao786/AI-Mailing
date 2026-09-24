const db = require("./db");

async function list(userId, { clientTypeId, search, limit } = {}) {
  const conditions = ["user_id = $1"];
  const params = [userId];
  if (clientTypeId) {
    params.push(clientTypeId);
    conditions.push(`client_type_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(email ILIKE $${params.length} OR name ILIKE $${params.length} OR company ILIKE $${params.length})`);
  }
  params.push(limit ? Math.min(limit, 500) : 200);
  const result = await db.query(
    `SELECT * FROM contacts WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

async function get(userId, id) {
  const result = await db.query(`SELECT * FROM contacts WHERE id = $1 AND user_id = $2`, [id, userId]);
  return result.rows[0] || null;
}

async function upsert(userId, { email, name, company, clientTypeId, customFields }) {
  if (!email || !email.trim()) throw new Error("Contact needs an email.");
  const result = await db.query(
    `INSERT INTO contacts (user_id, email, name, company, client_type_id, custom_fields)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, email) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, contacts.name),
       company = COALESCE(EXCLUDED.company, contacts.company),
       client_type_id = COALESCE(EXCLUDED.client_type_id, contacts.client_type_id),
       custom_fields = contacts.custom_fields || EXCLUDED.custom_fields
     RETURNING *`,
    [userId, email.trim().toLowerCase(), name || null, company || null, clientTypeId || null, customFields || {}]
  );
  return result.rows[0];
}

// Bulk import — rows already parsed from CSV/XLSX by the caller (xlsx handling lives at
// the API layer via exceljs, not here, so this module stays format-agnostic).
async function bulkUpsert(userId, rows, { clientTypeId } = {}) {
  const results = [];
  for (const row of rows) {
    try {
      const contact = await upsert(userId, {
        email: row.email,
        name: row.name,
        company: row.company,
        clientTypeId: clientTypeId || row.clientTypeId,
        customFields: row.customFields || {}
      });
      results.push({ email: row.email, ok: true, id: contact.id });
    } catch (e) {
      results.push({ email: row.email, ok: false, error: e.message });
    }
  }
  return results;
}

async function remove(userId, id) {
  const result = await db.query(`DELETE FROM contacts WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId]);
  return result.rowCount > 0;
}

async function setUnsubscribed(userId, id, unsubscribed) {
  const result = await db.query(
    `UPDATE contacts SET unsubscribed = $3 WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId, unsubscribed]
  );
  return result.rowCount > 0;
}

module.exports = { list, get, upsert, bulkUpsert, remove, setUnsubscribed };
