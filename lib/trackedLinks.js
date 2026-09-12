const crypto = require("crypto");
const db = require("./db");

// Short, URL-safe, collision-resistant enough for this volume — not a
// sequential id (would let anyone enumerate other people's links) and not a
// full UUID (unnecessarily long for a link recipients will see).
function generateId() {
  return crypto.randomBytes(9).toString("base64url");
}

async function save(trackingId, targetUrl) {
  const id = generateId();
  await db.query(
    "INSERT INTO tracked_links (id, tracking_id, target_url) VALUES ($1, $2, $3)",
    [id, trackingId, targetUrl]
  );
  return id;
}

async function resolve(id) {
  const result = await db.query("SELECT tracking_id, target_url FROM tracked_links WHERE id = $1", [id]);
  if (!result.rows.length) return null;
  return { trackingId: result.rows[0].tracking_id, targetUrl: result.rows[0].target_url };
}

module.exports = { save, resolve };
