const db = require("./db");

async function list(userId) {
  const result = await db.query(
    `SELECT s.*, ct.name AS client_type_name,
       (SELECT COUNT(*) FROM sequence_steps WHERE sequence_id = s.id) AS step_count
     FROM sequences s LEFT JOIN client_types ct ON ct.id = s.client_type_id
     WHERE s.user_id = $1 ORDER BY s.created_at`,
    [userId]
  );
  return result.rows;
}

async function get(userId, id) {
  const seqResult = await db.query(`SELECT * FROM sequences WHERE id = $1 AND user_id = $2`, [id, userId]);
  const sequence = seqResult.rows[0];
  if (!sequence) return null;
  const stepsResult = await db.query(`SELECT * FROM sequence_steps WHERE sequence_id = $1 ORDER BY step_order`, [id]);
  return { ...sequence, steps: stepsResult.rows };
}

async function create(userId, { name, clientTypeId, steps }) {
  if (!name || !name.trim()) throw new Error("Sequence needs a name.");
  return db.withTransaction(async client => {
    const seqResult = await client.query(
      `INSERT INTO sequences (user_id, name, client_type_id) VALUES ($1,$2,$3) RETURNING *`,
      [userId, name.trim(), clientTypeId || null]
    );
    const sequence = seqResult.rows[0];
    const stepRows = [];
    if (Array.isArray(steps)) {
      let order = 1;
      for (const step of steps) {
        const stepResult = await client.query(
          `INSERT INTO sequence_steps (sequence_id, step_order, delay_days, angle, subject_hint)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [sequence.id, order++, step.delayDays ?? 3, step.angle || "follow-up", step.subjectHint || null]
        );
        stepRows.push(stepResult.rows[0]);
      }
    }
    return { ...sequence, steps: stepRows };
  });
}

async function remove(userId, id) {
  const result = await db.query(`DELETE FROM sequences WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId]);
  return result.rowCount > 0;
}

async function addStep(userId, sequenceId, { delayDays, angle, subjectHint }) {
  const owner = await db.query(`SELECT id FROM sequences WHERE id = $1 AND user_id = $2`, [sequenceId, userId]);
  if (!owner.rows.length) throw new Error("Sequence not found.");
  const maxOrderResult = await db.query(`SELECT COALESCE(MAX(step_order),0) AS max FROM sequence_steps WHERE sequence_id = $1`, [sequenceId]);
  const nextOrder = maxOrderResult.rows[0].max + 1;
  const result = await db.query(
    `INSERT INTO sequence_steps (sequence_id, step_order, delay_days, angle, subject_hint)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [sequenceId, nextOrder, delayDays ?? 3, angle || "follow-up", subjectHint || null]
  );
  return result.rows[0];
}

module.exports = { list, get, create, remove, addStep };
