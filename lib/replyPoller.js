// Reply/bounce poller. Runs on its own tick, separate from sending, and walks every
// mailbox connection in turn. Matching is done by RFC822 In-Reply-To/References headers
// against the Message-ID we generated at send time (lib/mailboxes.js) — a structural
// match, not the old app's approach of keyword-scanning a bounce email's body text.
const db = require("./db");
const mailboxes = require("./mailboxes");

const MIN_DELAY_MS = parseInt(process.env.REPLY_POLL_MIN_DELAY_MS || "60000", 10);   // 1 min
const MAX_DELAY_MS = parseInt(process.env.REPLY_POLL_MAX_DELAY_MS || "180000", 10);  // 3 min

let stopped = false;

function jitteredDelay() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

function extractMessageIds(headerValue) {
  if (!headerValue) return [];
  const matches = String(headerValue).match(/<[^>]+>/g);
  return matches || [];
}

async function processMailbox(mailboxConnectionId, userId) {
  let inboundMessages;
  try {
    inboundMessages = await mailboxes.pollInbox(userId, mailboxConnectionId);
  } catch (e) {
    console.error(`Reply poll failed for mailbox ${mailboxConnectionId}:`, e.message);
    return;
  }
  if (!inboundMessages.length) return;

  const seenUids = [];
  for (const inbound of inboundMessages) {
    seenUids.push(inbound.uid);
    const candidateIds = [...extractMessageIds(inbound.inReplyTo), ...extractMessageIds(inbound.references)];
    if (!candidateIds.length) continue;

    const matchResult = await db.query(
      `SELECT * FROM messages WHERE user_id = $1 AND message_id_header = ANY($2::text[]) AND direction = 'outbound' LIMIT 1`,
      [userId, candidateIds]
    );
    const matched = matchResult.rows[0];
    if (!matched) continue;

    const eventType = inbound.isBounce ? "bounced" : "replied";

    await db.query(
      `INSERT INTO messages (user_id, contact_id, campaign_id, enrollment_id, direction, status, subject, body_text, in_reply_to)
       VALUES ($1,$2,$3,$4,'inbound','sent',$5,$6,$7)`,
      [userId, matched.contact_id, matched.campaign_id, matched.enrollment_id, inbound.subject, inbound.text, matched.message_id_header]
    );
    await db.query(
      `INSERT INTO events (user_id, message_id, contact_id, campaign_id, enrollment_id, type)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, matched.id, matched.contact_id, matched.campaign_id, matched.enrollment_id, eventType]
    );

    if (matched.enrollment_id) {
      await db.query(
        `UPDATE enrollments SET status = $2, next_send_at = NULL WHERE id = $1 AND status = 'active'`,
        [matched.enrollment_id, eventType]
      );
    }
  }

  try {
    await mailboxes.markSeen(userId, mailboxConnectionId, seenUids);
  } catch (e) {
    console.error(`Failed to mark messages seen for mailbox ${mailboxConnectionId}:`, e.message);
  }
}

async function tick() {
  if (stopped) return;
  try {
    const mailboxResult = await db.query(`SELECT id, user_id FROM mailbox_connections`);
    for (const mailbox of mailboxResult.rows) {
      await processMailbox(mailbox.id, mailbox.user_id);
    }
  } catch (e) {
    console.error("Reply poller tick failed:", e.message);
  }
  setTimeout(tick, jitteredDelay());
}

function start() {
  stopped = false;
  setTimeout(tick, jitteredDelay());
}

function stop() {
  stopped = true;
}

module.exports = { start, stop, processMailbox };
