// Sequence scheduler — this is what makes follow-ups actually "auto." On each tick it
// finds one enrollment whose next step is due, generates that step's email through the
// same two-pass pipeline as manual sends (so follow-ups get the same quality bar as a
// first touch), and hands it to the send-job worker to deliver with normal throttling.
//
// Processes ONE enrollment per tick with jitter, same rationale as sendJobWorker: keeps
// each tick fast and avoids a stampede of simultaneous generation calls when many
// follow-ups happen to come due at once.
const db = require("./db");
const emailGen = require("./emailGen");
const sendJobs = require("./sendJobs");

const MIN_DELAY_MS = parseInt(process.env.SEQUENCE_TICK_MIN_DELAY_MS || "15000", 10);
const MAX_DELAY_MS = parseInt(process.env.SEQUENCE_TICK_MAX_DELAY_MS || "45000", 10);

let stopped = false;

function jitteredDelay() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

async function resolveMailboxConnectionId(userId, campaignId) {
  if (campaignId) {
    const campResult = await db.query(`SELECT mailbox_connection_id FROM campaigns WHERE id = $1`, [campaignId]);
    if (campResult.rows[0] && campResult.rows[0].mailbox_connection_id) return campResult.rows[0].mailbox_connection_id;
  }
  const defaultResult = await db.query(`SELECT id FROM mailbox_connections WHERE user_id = $1 AND is_default = true LIMIT 1`, [userId]);
  return defaultResult.rows[0] ? defaultResult.rows[0].id : null;
}

async function processOneEnrollment() {
  const dueResult = await db.query(
    `SELECT * FROM enrollments WHERE status = 'active' AND next_send_at IS NOT NULL AND next_send_at <= now()
     ORDER BY next_send_at LIMIT 1`
  );
  const enrollment = dueResult.rows[0];
  if (!enrollment) return false;

  const seqResult = await db.query(`SELECT * FROM sequences WHERE id = $1`, [enrollment.sequence_id]);
  const sequence = seqResult.rows[0];
  const stepsResult = await db.query(
    `SELECT * FROM sequence_steps WHERE sequence_id = $1 ORDER BY step_order`,
    [enrollment.sequence_id]
  );
  const steps = stepsResult.rows;
  const nextStep = steps[enrollment.current_step]; // current_step=0 -> steps[0] is step 1

  if (!sequence || !nextStep) {
    await db.query(`UPDATE enrollments SET status = 'completed', next_send_at = NULL WHERE id = $1`, [enrollment.id]);
    return true;
  }

  try {
    const contactResult = await db.query(`SELECT * FROM contacts WHERE id = $1`, [enrollment.contact_id]);
    const contact = contactResult.rows[0];
    if (!contact) throw new Error("Contact no longer exists.");
    if (contact.unsubscribed) {
      await db.query(`UPDATE enrollments SET status = 'stopped', next_send_at = NULL WHERE id = $1`, [enrollment.id]);
      return true;
    }
    const clientTypeId = sequence.client_type_id || contact.client_type_id;
    if (!clientTypeId) throw new Error("No client type on the sequence or contact to generate from.");

    const generated = await emailGen.generateEmail(enrollment.user_id, {
      contactId: contact.id,
      clientTypeId,
      angle: nextStep.angle,
      subjectHint: nextStep.subject_hint
    });

    const mailboxConnectionId = await resolveMailboxConnectionId(enrollment.user_id, enrollment.campaign_id);
    if (!mailboxConnectionId) throw new Error("No mailbox connection configured to send from.");

    const insertResult = await db.query(
      `INSERT INTO messages (user_id, contact_id, campaign_id, enrollment_id, direction, status, subject, body_text, generated_by_ai)
       VALUES ($1,$2,$3,$4,'outbound','draft',$5,$6,true) RETURNING id`,
      [enrollment.user_id, contact.id, enrollment.campaign_id, enrollment.id, generated.subject, generated.body]
    );
    const messageId = insertResult.rows[0].id;
    await db.query(
      `INSERT INTO generation_feedback (message_id, draft_subject, draft_body, final_subject, final_body)
       VALUES ($1,$2,$3,$4,$5)`,
      [messageId, generated.draftSubject, generated.draftBody, generated.subject, generated.body]
    );
    for (const assetId of generated.usedAssetIds || []) {
      await db.query(
        `INSERT INTO message_assets (message_id, asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [messageId, assetId]
      );
    }

    // Hand off to the send-job worker rather than sending inline here — same throttling,
    // same daily-cap awareness, same failure handling as a manual bulk send.
    await sendJobs.createJob(enrollment.user_id, { campaignId: enrollment.campaign_id, mailboxConnectionId, messageIds: [messageId] });

    const newStepIndex = enrollment.current_step + 1;
    const followingStep = steps[newStepIndex];
    const nextSendAt = followingStep
      ? `now() + interval '${parseInt(followingStep.delay_days, 10)} days'`
      : null;

    if (nextSendAt) {
      await db.query(
        `UPDATE enrollments SET current_step = $2, next_send_at = ${nextSendAt} WHERE id = $1`,
        [enrollment.id, newStepIndex]
      );
    } else {
      await db.query(
        `UPDATE enrollments SET current_step = $2, status = 'completed', next_send_at = NULL WHERE id = $1`,
        [enrollment.id, newStepIndex]
      );
    }
  } catch (e) {
    console.error(`Sequence step generation failed for enrollment ${enrollment.id}:`, e.message);
    await db.query(
      `UPDATE enrollments SET status = 'error', next_send_at = NULL, error = $2 WHERE id = $1`,
      [enrollment.id, e.message]
    );
  }

  return true;
}

async function tick() {
  if (stopped) return;
  try {
    await processOneEnrollment();
  } catch (e) {
    console.error("Sequence scheduler tick failed:", e.message);
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

module.exports = { start, stop, processOneEnrollment };
