const crypto = require("crypto");
const db = require("./db");

function cleanLinks(links) {
  return Array.isArray(links)
    ? links
        .filter(l => l && l.label && l.url)
        .map(l => ({ id: l.id || crypto.randomUUID(), label: String(l.label).trim(), url: String(l.url).trim() }))
    : [];
}

function cleanCollateralIds(ids) {
  return Array.isArray(ids) ? ids.filter(Boolean).map(String) : [];
}

function mapRow(r) {
  return {
    id: r.id,
    label: r.label,
    description: r.description || "",
    links: r.links || [],
    emailFormat: r.email_format || "",
    subjectTemplate: r.subject_template || "",
    extraInfo: r.extra_info || "",
    defaultCollateralIds: r.default_collateral_ids || [],
    createdAt: r.created_at.toISOString()
  };
}

async function list(userId) {
  const result = await db.query(
    "SELECT * FROM client_profiles WHERE user_id = $1 ORDER BY created_at ASC",
    [userId]
  );
  return result.rows.map(mapRow);
}

async function get(userId, id) {
  const result = await db.query("SELECT * FROM client_profiles WHERE id = $1 AND user_id = $2", [id, userId]);
  return result.rows.length ? mapRow(result.rows[0]) : null;
}

async function create(userId, { label, description, links, emailFormat, subjectTemplate, extraInfo, defaultCollateralIds }) {
  if (!label || !String(label).trim()) throw new Error("Give this client type a name.");
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO client_profiles
       (id, user_id, label, description, links, email_format, subject_template, extra_info, default_collateral_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      userId,
      String(label).trim(),
      description ? String(description).trim() : "",
      JSON.stringify(cleanLinks(links)),
      emailFormat ? String(emailFormat) : "",
      subjectTemplate ? String(subjectTemplate).trim() : "",
      extraInfo ? String(extraInfo) : "",
      JSON.stringify(cleanCollateralIds(defaultCollateralIds))
    ]
  );
  return get(userId, id);
}

async function update(userId, id, patch) {
  const current = await get(userId, id);
  if (!current) throw new Error("Client type not found.");
  const merged = { ...current, ...patch };
  if (!merged.label || !String(merged.label).trim()) throw new Error("Give this client type a name.");

  await db.query(
    `UPDATE client_profiles
     SET label = $3, description = $4, links = $5, email_format = $6, subject_template = $7,
         extra_info = $8, default_collateral_ids = $9
     WHERE id = $1 AND user_id = $2`,
    [
      id,
      userId,
      String(merged.label).trim(),
      merged.description ? String(merged.description).trim() : "",
      JSON.stringify(cleanLinks(merged.links)),
      merged.emailFormat ? String(merged.emailFormat) : "",
      merged.subjectTemplate ? String(merged.subjectTemplate).trim() : "",
      merged.extraInfo ? String(merged.extraInfo) : "",
      JSON.stringify(cleanCollateralIds(merged.defaultCollateralIds))
    ]
  );
  return get(userId, id);
}

async function remove(userId, id) {
  const result = await db.query("DELETE FROM client_profiles WHERE id = $1 AND user_id = $2", [id, userId]);
  return result.rowCount > 0;
}

module.exports = { list, get, create, update, remove };
