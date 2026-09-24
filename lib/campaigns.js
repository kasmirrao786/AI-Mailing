const db = require("./db");

async function list(userId) {
  const result = await db.query(
    `SELECT c.*, ct.name AS client_type_name, s.name AS sequence_name, mc.label AS mailbox_label,
       (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id) AS contact_count
     FROM campaigns c
     LEFT JOIN client_types ct ON ct.id = c.client_type_id
     LEFT JOIN sequences s ON s.id = c.sequence_id
     LEFT JOIN mailbox_connections mc ON mc.id = c.mailbox_connection_id
     WHERE c.user_id = $1 ORDER BY c.created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function get(userId, id) {
  const result = await db.query(`SELECT * FROM campaigns WHERE id = $1 AND user_id = $2`, [id, userId]);
  return result.rows[0] || null;
}

async function getContacts(userId, campaignId) {
  const owner = await db.query(`SELECT id FROM campaigns WHERE id = $1 AND user_id = $2`, [campaignId, userId]);
  if (!owner.rows.length) throw new Error("Campaign not found.");
  const result = await db.query(
    `SELECT cc.contact_id, cc.status AS campaign_status, c.email, c.name, c.company,
       (SELECT m.id FROM messages m WHERE m.campaign_id = $1 AND m.contact_id = cc.contact_id
        AND m.enrollment_id IS NULL ORDER BY m.created_at DESC LIMIT 1) AS message_id,
       (SELECT m.status FROM messages m WHERE m.campaign_id = $1 AND m.contact_id = cc.contact_id
        AND m.enrollment_id IS NULL ORDER BY m.created_at DESC LIMIT 1) AS message_status
     FROM campaign_contacts cc JOIN contacts c ON c.id = cc.contact_id
     WHERE cc.campaign_id = $1 ORDER BY c.created_at`,
    [campaignId]
  );
  return result.rows;
}

async function create(userId, { name, clientTypeId, sequenceId, mailboxConnectionId, contactIds }) {
  if (!name || !name.trim()) throw new Error("Campaign needs a name.");

  // Every foreign id on a campaign must belong to the same user — without this check,
  // a client could attach another account's mailbox connection (and therefore send
  // through someone else's mailbox) just by passing its id.
  if (clientTypeId) {
    const owned = await db.query(`SELECT id FROM client_types WHERE id = $1 AND user_id = $2`, [clientTypeId, userId]);
    if (!owned.rows.length) throw new Error("Client type not found.");
  }
  if (sequenceId) {
    const owned = await db.query(`SELECT id FROM sequences WHERE id = $1 AND user_id = $2`, [sequenceId, userId]);
    if (!owned.rows.length) throw new Error("Sequence not found.");
  }
  if (mailboxConnectionId) {
    const owned = await db.query(`SELECT id FROM mailbox_connections WHERE id = $1 AND user_id = $2`, [mailboxConnectionId, userId]);
    if (!owned.rows.length) throw new Error("Mailbox connection not found.");
  }
  if (Array.isArray(contactIds) && contactIds.length) {
    const owned = await db.query(`SELECT id FROM contacts WHERE id = ANY($1::uuid[]) AND user_id = $2`, [contactIds, userId]);
    if (owned.rows.length !== contactIds.length) throw new Error("One or more contacts were not found.");
  }

  return db.withTransaction(async client => {
    const campResult = await client.query(
      `INSERT INTO campaigns (user_id, name, client_type_id, sequence_id, mailbox_connection_id, status)
       VALUES ($1,$2,$3,$4,$5,'draft') RETURNING *`,
      [userId, name.trim(), clientTypeId || null, sequenceId || null, mailboxConnectionId || null]
    );
    const campaign = campResult.rows[0];
    if (Array.isArray(contactIds)) {
      for (const contactId of contactIds) {
        await client.query(
          `INSERT INTO campaign_contacts (campaign_id, contact_id) VALUES ($1,$2)
           ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
          [campaign.id, contactId]
        );
      }
    }
    return campaign;
  });
}

async function setStatus(userId, id, status) {
  const result = await db.query(
    `UPDATE campaigns SET status = $3 WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, status]
  );
  if (!result.rows.length) throw new Error("Campaign not found.");
  return result.rows[0];
}

async function remove(userId, id) {
  const result = await db.query(`DELETE FROM campaigns WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId]);
  return result.rowCount > 0;
}

module.exports = { list, get, getContacts, create, setStatus, remove };
