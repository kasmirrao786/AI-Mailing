const db = require("./db");
const crypto = require("./crypto");

async function list(userId) {
  const result = await db.query(
    `SELECT id, label, imap_host, imap_port, smtp_host, smtp_port, username, from_name,
            from_email, sent_folder, is_default, daily_send_cap, created_at
     FROM mailbox_connections WHERE user_id = $1 ORDER BY created_at`,
    [userId]
  );
  return result.rows;
}

async function create(userId, input) {
  const {
    label, imapHost, imapPort, imapSecure, smtpHost, smtpPort, smtpSecure,
    username, password, fromName, fromEmail, sentFolder, isDefault, dailySendCap
  } = input;
  if (!label || !imapHost || !smtpHost || !username || !password || !fromEmail) {
    throw new Error("label, imapHost, smtpHost, username, password, and fromEmail are required.");
  }
  if (isDefault) {
    await db.query(`UPDATE mailbox_connections SET is_default = false WHERE user_id = $1`, [userId]);
  }
  const result = await db.query(
    `INSERT INTO mailbox_connections
      (user_id, label, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
       username, password_enc, from_name, from_email, sent_folder, is_default, daily_send_cap)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id`,
    [
      userId, label, imapHost, imapPort || 993, imapSecure !== false,
      smtpHost, smtpPort || 587, smtpSecure === true,
      username, crypto.encrypt(password), fromName || null, fromEmail,
      sentFolder || "Sent", !!isDefault, dailySendCap || 150
    ]
  );
  return result.rows[0].id;
}

async function remove(userId, id) {
  const result = await db.query(
    `DELETE FROM mailbox_connections WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId]
  );
  return result.rowCount > 0;
}

module.exports = { list, create, remove };
