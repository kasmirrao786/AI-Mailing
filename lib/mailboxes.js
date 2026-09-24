// IMAP/SMTP mailbox handling — provider-agnostic (works with Spacemail or any IMAP/SMTP host).
//
// Why this replaces Gmail OAuth entirely:
//  - No Google app-verification process, no scope review, works day one.
//  - "Appear in Sent folder" is native: IMAP APPEND puts the message straight into the
//    account's real Sent folder, so what the platform sends looks identical to something
//    typed by hand in the mail client — nothing to reconcile after the fact.
//  - Replies/bounces are read the same structural way: poll INBOX (and for bounces, also
//    check for auto-generated failure notices), matched by Message-ID / In-Reply-To
//    headers rather than keyword-guessing a DSN body like the old Gmail-only approach did.
const nodemailer = require("nodemailer");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const nodeCrypto = require("crypto");
const credCrypto = require("./crypto");
const db = require("./db");

const CONNECT_TIMEOUT_MS = 15000;

// A wrong host, a blocked port, or a firewalled network can otherwise hang for minutes
// with no clear error — this guarantees a fast, specific failure instead. This matters
// a lot in a PaaS environment (Coolify, Railway, etc.) where outbound network rules
// sometimes silently block non-standard mail ports.
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function getConnection(userId, mailboxConnectionId) {
  const result = mailboxConnectionId
    ? await db.query(`SELECT * FROM mailbox_connections WHERE id = $1 AND user_id = $2`, [mailboxConnectionId, userId])
    : await db.query(`SELECT * FROM mailbox_connections WHERE user_id = $1 AND is_default = true LIMIT 1`, [userId]);
  const row = result.rows[0];
  if (!row) throw new Error("No mailbox connection configured. Add one in Settings first.");
  return { ...row, password: credCrypto.decrypt(row.password_enc) };
}

function smtpTransportFor(conn) {
  return nodemailer.createTransport({
    host: conn.smtp_host,
    port: conn.smtp_port,
    secure: conn.smtp_secure,
    // When secure=false (STARTTLS ports like 587), requireTLS forces the STARTTLS
    // upgrade to actually happen — without it, nodemailer would only *attempt* STARTTLS
    // and could silently fall back to an unencrypted connection if the upgrade failed,
    // which would mean mailbox credentials going out in plaintext. secure=true (implicit
    // TLS ports like 465) is unaffected by this — the whole connection is TLS from the
    // first byte either way.
    requireTLS: !conn.smtp_secure,
    auth: { user: conn.username, pass: conn.password },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: CONNECT_TIMEOUT_MS
  });
}

async function imapClientFor(conn) {
  const client = new ImapFlow({
    host: conn.imap_host,
    port: conn.imap_port,
    secure: conn.imap_secure,
    auth: { user: conn.username, pass: conn.password },
    logger: false,
    socketTimeout: CONNECT_TIMEOUT_MS
  });
  // Critical: an EventEmitter with no 'error' listener throws an UNCAUGHT exception the
  // moment one fires, bypassing every try/catch in the codebase — including the ones in
  // replyPoller/sendJobWorker that exist specifically to attribute an error to the right
  // mailbox and keep going. A misconfigured port/TLS setting on one mailbox (a very
  // realistic, recurring condition — not a one-off) would otherwise surface as a bare,
  // context-free OpenSSL error instead of "reply poll failed for mailbox X: <reason>".
  // This listener's only job is to exist, so the error becomes a normal, catchable
  // rejection instead of a process-level throw.
  client.on("error", (err) => {
    console.error(`IMAP client error (${conn.imap_host}:${conn.imap_port}, user ${conn.user_id || "?"}):`, err.message);
  });
  await withTimeout(
    client.connect(),
    CONNECT_TIMEOUT_MS,
    `Could not connect to IMAP host "${conn.imap_host}:${conn.imap_port}" within ${CONNECT_TIMEOUT_MS / 1000}s — check the host/port, and that this server's network can reach it.`
  ).catch(err => { throw new Error(withPortSecureHint(err, conn.imap_port)); });
  return client;
}

// SSL/TLS handshake errors (e.g. "wrong version number") almost always mean the port and
// the secure/TLS setting don't match — implicit-TLS ports (993, 465) need secure=true;
// STARTTLS ports (143, 587, 25) need secure=false. This fails fast (not via timeout), so
// it needs its own hint rather than relying on the connect-timeout message above.
function withPortSecureHint(err, port) {
  const isTlsError = /ssl|tls|wrong version number/i.test(err.message || "");
  if (!isTlsError) return err.message;
  return `${err.message} — this usually means the port and the "secure" (TLS) setting don't match for port ${port}. Implicit-TLS ports (993 for IMAP, 465 for SMTP) need secure ON; STARTTLS ports (143, 587, 25) need secure OFF. Check your mailbox connection's settings against what your provider documents for that exact port.`;
}

// Verifies both SMTP and IMAP credentials without sending or reading anything —
// used by the Settings "Test connection" button.
async function testConnection(conn) {
  const smtp = smtpTransportFor(conn);
  await withTimeout(
    smtp.verify(),
    CONNECT_TIMEOUT_MS,
    `Could not connect to SMTP host "${conn.smtp_host}:${conn.smtp_port}" within ${CONNECT_TIMEOUT_MS / 1000}s — check the host/port, and that this server's network can reach it.`
  ).catch(err => { throw new Error(withPortSecureHint(err, conn.smtp_port)); });
  const imap = await imapClientFor(conn);
  await imap.mailboxOpen(conn.sent_folder || "Sent").catch(() => {
    throw new Error(`Connected, but couldn't open IMAP folder "${conn.sent_folder || "Sent"}". Check the folder name.`);
  });
  await imap.logout();
  return { ok: true };
}


// Sends via SMTP, then appends the exact same MIME message into the account's IMAP
// Sent folder — this is what makes sent mail show up in Spacemail's own webmail/Sent view.
async function sendAndArchive(userId, mailboxConnectionId, { to, subject, text, html, attachments, headers, inReplyTo }) {
  const conn = await getConnection(userId, mailboxConnectionId);
  const smtp = smtpTransportFor(conn);

  // Explicit Message-ID so reply detection can match inbound In-Reply-To/References
  // headers back to this exact send, the same reliable mechanism regardless of provider.
  const messageIdHeader = `<${nodeCrypto.randomUUID()}@outreach-platform>`;

  const info = await smtp.sendMail({
    from: conn.from_name ? `"${conn.from_name}" <${conn.from_email}>` : conn.from_email,
    to,
    subject,
    text,
    html,
    attachments,
    messageId: messageIdHeader,
    inReplyTo,
    headers
  });

  // nodemailer gives us the raw RFC822 source via `message` when using streamTransport,
  // but the default SMTP transport doesn't return it — so we build a raw copy for
  // archiving that mirrors what was actually sent: same Message-ID (so this archived
  // copy is identifiable as the same message, not a different one), same attachments
  // (so Spacemail's Sent view shows what the recipient actually received, not a
  // text-only stand-in).
  try {
    const imap = await imapClientFor(conn);
    const raw = buildRawMessage({ from: conn.from_email, fromName: conn.from_name, to, subject, text, html, headers, messageIdHeader, attachments });
    await imap.append(conn.sent_folder || "Sent", raw, ["\\Seen"]);
    await imap.logout();
  } catch (e) {
    // Sending succeeded even if the archive step fails — log, don't throw, so a flaky
    // IMAP append never blocks delivery. Surface this in activity logs at the call site.
    console.error(`IMAP archive-to-Sent failed for user ${userId}:`, e.message);
  }

  return { messageId: info.messageId };
}

function buildRawMessage({ from, fromName, to, subject, text, html, headers, messageIdHeader, attachments }) {
  const altBoundary = `----=_Alt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const mixedBoundary = `----=_Mixed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const extraHeaders = Object.entries(headers || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");

  const alternativePart = [
    `--${altBoundary}`,
    `Content-Type: text/plain; charset="utf-8"`,
    ``,
    text || "",
    `--${altBoundary}`,
    `Content-Type: text/html; charset="utf-8"`,
    ``,
    html || "",
    `--${altBoundary}--`
  ].join("\r\n");

  const attachmentParts = (attachments || []).map(att => {
    const content = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content || "");
    const base64 = content.toString("base64").replace(/(.{76})/g, "$1\r\n");
    return [
      `--${mixedBoundary}`,
      `Content-Type: application/octet-stream; name="${att.filename}"`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${att.filename}"`,
      ``,
      base64
    ].join("\r\n");
  }).join("\r\n");

  const headerLines = [
    `From: ${fromName ? `"${fromName}" <${from}>` : from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    messageIdHeader ? `Message-ID: ${messageIdHeader}` : null,
    `MIME-Version: 1.0`,
    extraHeaders || null
  ].filter(Boolean);

  if (!attachments || !attachments.length) {
    return [...headerLines, `Content-Type: multipart/alternative; boundary="${altBoundary}"`, ``, alternativePart].join("\r\n");
  }

  return [
    ...headerLines,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    ``,
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    ``,
    alternativePart,
    attachmentParts,
    `--${mixedBoundary}--`
  ].join("\r\n");
}

// Polls INBOX for messages since a watermark, parses them, and classifies as reply vs.
// bounce (bounce = From looks like a mailer-daemon/postmaster, or has an
// Auto-Submitted/X-Failed-Recipients-style header). Returns parsed messages for the
// caller (replyDetector / bounceDetector) to match against sent messages by
// In-Reply-To / References headers.
async function pollInbox(userId, mailboxConnectionId, { sinceUid } = {}) {
  const conn = await getConnection(userId, mailboxConnectionId);
  const imap = await imapClientFor(conn);
  const results = [];
  try {
    const lock = await imap.getMailboxLock("INBOX");
    try {
      const searchCriteria = sinceUid ? { uid: `${sinceUid + 1}:*` } : { seen: false };
      for await (const message of imap.fetch(searchCriteria, { source: true, uid: true })) {
        const parsed = await simpleParser(message.source);
        const fromAddr = (parsed.from && parsed.from.value[0] && parsed.from.value[0].address || "").toLowerCase();
        const isBounce =
          /mailer-daemon|postmaster|mail delivery|delivery status/i.test(fromAddr) ||
          /mailer-daemon|delivery status notification/i.test(parsed.subject || "") ||
          (parsed.headers.get("auto-submitted") || "").toString() !== "";
        results.push({
          uid: message.uid,
          from: fromAddr,
          subject: parsed.subject || "",
          text: parsed.text || "",
          inReplyTo: parsed.inReplyTo || null,
          references: parsed.references || null,
          isBounce
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout();
  }
  return results;
}

// Marks specific UIDs as \Seen — called after the reply/bounce poller has processed a
// batch, so the same messages aren't re-parsed and re-matched on every subsequent tick.
async function markSeen(userId, mailboxConnectionId, uids) {
  if (!uids || !uids.length) return;
  const conn = await getConnection(userId, mailboxConnectionId);
  const imap = await imapClientFor(conn);
  try {
    const lock = await imap.getMailboxLock("INBOX");
    try {
      await imap.messageFlagsAdd({ uid: uids.join(",") }, ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout();
  }
}

module.exports = { getConnection, testConnection, sendAndArchive, pollInbox, markSeen };
