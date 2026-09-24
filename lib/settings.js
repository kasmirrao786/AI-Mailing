const db = require("./db");
const crypto = require("./crypto");

async function get(userId) {
  const result = await db.query(`SELECT * FROM user_settings WHERE user_id = $1`, [userId]);
  const row = result.rows[0];
  return { hasOwnOpenrouterKey: !!(row && row.openrouter_api_key_enc), openrouterModel: row ? row.openrouter_model : null };
}

async function setOpenrouterKey(userId, apiKey, model) {
  const enc = apiKey ? crypto.encrypt(apiKey) : null;
  await db.query(
    `INSERT INTO user_settings (user_id, openrouter_api_key_enc, openrouter_model, updated_at)
     VALUES ($1,$2,$3, now())
     ON CONFLICT (user_id) DO UPDATE SET
       openrouter_api_key_enc = COALESCE($2, user_settings.openrouter_api_key_enc),
       openrouter_model = COALESCE($3, user_settings.openrouter_model),
       updated_at = now()`,
    [userId, enc, model || null]
  );
}

module.exports = { get, setOpenrouterKey };
