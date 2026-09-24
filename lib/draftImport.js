// Imports pre-written emails as drafts — the fallback path for when generation isn't
// producing good enough copy for a given batch. Each row already carries its own
// subject and body; nothing here calls the LLM. The body can reference a saved asset
// by label with {{asset:Label}} (resolved exactly like generated emails do, so file
// attachments and demo/booking links still work), or just contain raw URLs directly —
// those get picked up automatically by tracking.js at send time either way, since link
// tracking works on the email's actual content, not on how that content was produced.
const db = require("./db");
const contacts = require("./contacts");
const emailGen = require("./emailGen");

async function importDrafts(userId, rows, { clientTypeId, campaignId } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error("No rows to import.");

  if (clientTypeId) {
    const owned = await db.query(`SELECT id FROM client_types WHERE id = $1 AND user_id = $2`, [clientTypeId, userId]);
    if (!owned.rows.length) throw new Error("Client type not found.");
  }
  if (campaignId) {
    const owned = await db.query(`SELECT id FROM campaigns WHERE id = $1 AND user_id = $2`, [campaignId, userId]);
    if (!owned.rows.length) throw new Error("Campaign not found.");
  }

  // Fetch once, reused for every row's placeholder resolution — the person can reference
  // any of their saved assets by label, not just ones auto-selected for a client type.
  const assetsResult = await db.query(`SELECT id, label, kind, url, file_name FROM assets WHERE user_id = $1`, [userId]);
  const allAssets = assetsResult.rows;

  const results = [];
  for (const row of rows) {
    try {
      if (!row.email) throw new Error("Missing email.");
      if (!row.subject || !row.subject.trim()) throw new Error("Missing subject.");
      if (!row.body || !row.body.trim()) throw new Error("Missing body.");

      const contact = await contacts.upsert(userId, {
        email: row.email,
        name: row.name,
        company: row.company,
        clientTypeId: clientTypeId || undefined
      });

      const { filled: resolvedBody, usedAssetIds } = emailGen.fillAssetPlaceholders(row.body, allAssets);
      const { filled: resolvedSubject } = emailGen.fillAssetPlaceholders(row.subject, allAssets);

      const inserted = await db.query(
        `INSERT INTO messages (user_id, contact_id, campaign_id, direction, status, subject, body_text, generated_by_ai)
         VALUES ($1,$2,$3,'outbound','draft',$4,$5,false) RETURNING id`,
        [userId, contact.id, campaignId || null, resolvedSubject.trim(), resolvedBody]
      );
      const messageId = inserted.rows[0].id;

      for (const assetId of usedAssetIds) {
        await db.query(
          `INSERT INTO message_assets (message_id, asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [messageId, assetId]
        );
      }

      if (campaignId) {
        await db.query(
          `INSERT INTO campaign_contacts (campaign_id, contact_id) VALUES ($1,$2)
           ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
          [campaignId, contact.id]
        );
      }

      results.push({ email: row.email, ok: true, messageId });
    } catch (e) {
      results.push({ email: row.email || "(missing)", ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { importDrafts };
