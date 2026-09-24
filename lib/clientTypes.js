const db = require("./db");

async function list(userId) {
  const result = await db.query(
    `SELECT ct.*, COUNT(c.id) AS contact_count
     FROM client_types ct
     LEFT JOIN contacts c ON c.client_type_id = ct.id
     WHERE ct.user_id = $1
     GROUP BY ct.id ORDER BY ct.created_at`,
    [userId]
  );
  return result.rows;
}

async function get(userId, id) {
  const ctResult = await db.query(`SELECT * FROM client_types WHERE id = $1 AND user_id = $2`, [id, userId]);
  const clientType = ctResult.rows[0];
  if (!clientType) return null;
  const exResult = await db.query(
    `SELECT * FROM client_type_examples WHERE client_type_id = $1 ORDER BY created_at`,
    [id]
  );
  return { ...clientType, examples: exResult.rows };
}

async function create(userId, { name, description, toneNotes, skeleton }) {
  if (!name || !name.trim()) throw new Error("Client type needs a name.");
  const result = await db.query(
    `INSERT INTO client_types (user_id, name, description, tone_notes, skeleton)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [userId, name.trim(), description || null, toneNotes || null, skeleton || null]
  );
  return result.rows[0];
}

async function update(userId, id, { name, description, toneNotes, skeleton, defaultSequenceId }) {
  const result = await db.query(
    `UPDATE client_types SET
       name = COALESCE($3, name),
       description = COALESCE($4, description),
       tone_notes = COALESCE($5, tone_notes),
       skeleton = COALESCE($6, skeleton),
       default_sequence_id = COALESCE($7, default_sequence_id)
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, name, description, toneNotes, skeleton, defaultSequenceId]
  );
  if (!result.rows.length) throw new Error("Client type not found.");
  return result.rows[0];
}

async function remove(userId, id) {
  const result = await db.query(`DELETE FROM client_types WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId]);
  return result.rowCount > 0;
}

// Examples — the few-shot quality bar for generation. Kept small (UI should cap at ~3-5
// active per client type) since these get pasted into every generation prompt.
async function addExample(userId, clientTypeId, { subject, body, note }) {
  const owner = await db.query(`SELECT id FROM client_types WHERE id = $1 AND user_id = $2`, [clientTypeId, userId]);
  if (!owner.rows.length) throw new Error("Client type not found.");
  if (!subject || !body) throw new Error("Example needs both a subject and a body.");
  const result = await db.query(
    `INSERT INTO client_type_examples (client_type_id, subject, body, note) VALUES ($1,$2,$3,$4) RETURNING *`,
    [clientTypeId, subject, body, note || null]
  );
  return result.rows[0];
}

async function removeExample(userId, clientTypeId, exampleId) {
  const result = await db.query(
    `DELETE FROM client_type_examples
     WHERE id = $1 AND client_type_id = $2
       AND client_type_id IN (SELECT id FROM client_types WHERE user_id = $3)
     RETURNING id`,
    [exampleId, clientTypeId, userId]
  );
  return result.rowCount > 0;
}

module.exports = { list, get, create, update, remove, addExample, removeExample };
