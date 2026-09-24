require("dotenv").config();
const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const multer = require("multer");
const path = require("path");

const db = require("./lib/db");
const { runMigrations } = require("./db/migrate");
const authStore = require("./lib/authStore");
const mailboxConnections = require("./lib/mailboxConnections");
const mailboxes = require("./lib/mailboxes");
const clientTypes = require("./lib/clientTypes");
const contacts = require("./lib/contacts");
const assetsLib = require("./lib/assets");
const settings = require("./lib/settings");
const emailGen = require("./lib/emailGen");
const importRows = require("./lib/importRows");
const draftImport = require("./lib/draftImport");
const sendJobs = require("./lib/sendJobs");
const sendJobWorker = require("./lib/sendJobWorker");
const sequences = require("./lib/sequences");
const enrollments = require("./lib/enrollments");
const sequenceScheduler = require("./lib/sequenceScheduler");
const replyPoller = require("./lib/replyPoller");
const campaigns = require("./lib/campaigns");
const tracking = require("./lib/tracking");

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Patches app.get/post/patch/delete so every route handler registered from this point on
// is automatically wrapped to catch thrown/rejected errors. This matters a lot in
// practice: Express 4 does NOT catch errors from an async handler on its own, and modern
// Node terminates the whole process on an unhandled promise rejection — so one route
// throwing (a bad DB query, a missing env var inside a library call, anything) would
// otherwise crash every user's session, not just fail the one request. Every route below
// gets this safety net without needing an individual try/catch in each handler.
["get", "post", "put", "patch", "delete"].forEach(method => {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => {
    const wrapped = handlers.map(h =>
      typeof h === "function"
        ? (req, res, next) => { Promise.resolve(h(req, res, next)).catch(next); }
        : h
    );
    return original(routePath, ...wrapped);
  };
});

app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    store: new pgSession({ pool: db.pool, tableName: "session" }), // table created by db/schema.sql migration
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 30, secure: "auto", httpOnly: true, sameSite: "lax" }
  })
);

// ---------- auth ----------
const PUBLIC_PATHS = new Set(["/login.html", "/signup.html", "/style.css", "/api/login", "/api/signup"]);

function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.session.userId) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not authenticated" });
  return res.redirect("/login.html");
}

app.post("/api/signup", async (req, res) => {
  try {
    const user = await authStore.createUser(req.body.email, req.body.password);
    req.session.userId = user.id;
    res.json({ ok: true, email: user.email });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/login", async (req, res) => {
  const user = await authStore.verifyUser(req.body.email, req.body.password);
  if (!user) return res.status(401).json({ error: "Wrong email or password." });
  req.session.userId = user.id;
  res.json({ ok: true, email: user.email });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------- tracking (public — hit by recipients' mail clients, never authenticated) ----------
app.get("/t/o/:trackingId", async (req, res) => {
  tracking.recordOpen(req.params.trackingId).catch(e => console.error("recordOpen failed:", e.message));
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "no-store");
  res.send(tracking.TRANSPARENT_PNG);
});

app.get("/t/c/:linkId", async (req, res) => {
  try {
    const target = await tracking.recordClickAndGetTarget(req.params.linkId);
    if (!target) return res.status(404).send("Link not found.");
    res.redirect(302, target);
  } catch (e) {
    console.error("recordClickAndGetTarget failed:", e.message);
    res.status(500).send("Something went wrong.");
  }
});

// ---------- health check (public — used by hosting platforms, e.g. Railway) ----------
app.get("/healthz", async (req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.use(requireAuth);
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/me", async (req, res) => {
  const user = await authStore.getUserById(req.session.userId);
  res.json({ email: user ? user.email : null });
});

// ---------- mailbox connections ----------
app.get("/api/mailboxes", async (req, res) => {
  res.json({ mailboxes: await mailboxConnections.list(req.session.userId) });
});

app.post("/api/mailboxes", async (req, res) => {
  try {
    const id = await mailboxConnections.create(req.session.userId, req.body);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/mailboxes/:id/test", async (req, res) => {
  try {
    const conn = await mailboxes.getConnection(req.session.userId, req.params.id);
    const result = await mailboxes.testConnection(conn);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/mailboxes/:id", async (req, res) => {
  const removed = await mailboxConnections.remove(req.session.userId, req.params.id);
  if (!removed) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

// ---------- client types ----------
app.get("/api/client-types", async (req, res) => {
  res.json({ clientTypes: await clientTypes.list(req.session.userId) });
});

app.get("/api/client-types/:id", async (req, res) => {
  const ct = await clientTypes.get(req.session.userId, req.params.id);
  if (!ct) return res.status(404).json({ error: "Not found" });
  res.json({ clientType: ct });
});

app.post("/api/client-types", async (req, res) => {
  try {
    const ct = await clientTypes.create(req.session.userId, req.body);
    res.json({ ok: true, clientType: ct });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch("/api/client-types/:id", async (req, res) => {
  try {
    const ct = await clientTypes.update(req.session.userId, req.params.id, req.body);
    res.json({ ok: true, clientType: ct });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/client-types/:id", async (req, res) => {
  const removed = await clientTypes.remove(req.session.userId, req.params.id);
  if (!removed) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

app.post("/api/client-types/:id/examples", async (req, res) => {
  try {
    const example = await clientTypes.addExample(req.session.userId, req.params.id, req.body);
    res.json({ ok: true, example });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/client-types/:id/examples/:exampleId", async (req, res) => {
  const removed = await clientTypes.removeExample(req.session.userId, req.params.id, req.params.exampleId);
  if (!removed) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

// ---------- contacts ----------
app.get("/api/contacts", async (req, res) => {
  const { clientTypeId, search, limit } = req.query;
  res.json({ contacts: await contacts.list(req.session.userId, { clientTypeId, search, limit: limit ? parseInt(limit, 10) : undefined }) });
});

app.post("/api/contacts", async (req, res) => {
  try {
    const contact = await contacts.upsert(req.session.userId, req.body);
    res.json({ ok: true, contact });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/contacts/import", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const rows = await importRows.parseUpload(req.file.buffer, req.file.originalname);
    if (!rows.length) return res.status(400).json({ error: "No valid rows with an email column found." });
    const results = await contacts.bulkUpsert(req.session.userId, rows, { clientTypeId: req.body.clientTypeId });
    res.json({ results, importedCount: results.filter(r => r.ok).length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Bulk import of pre-written emails (contact + subject + body) as ready-to-send drafts —
// bypasses AI generation entirely, for when generated copy isn't good enough for a batch.
app.post("/api/messages/import", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const rows = await importRows.parseDraftUpload(req.file.buffer, req.file.originalname);
    if (!rows.length) return res.status(400).json({ error: "No valid rows found — each row needs at least email, subject, and body columns." });
    const results = await draftImport.importDrafts(req.session.userId, rows, {
      clientTypeId: req.body.clientTypeId || null,
      campaignId: req.body.campaignId || null
    });
    res.json({ results, importedCount: results.filter(r => r.ok).length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/contacts/:id", async (req, res) => {
  const removed = await contacts.remove(req.session.userId, req.params.id);
  if (!removed) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

// ---------- assets ----------
app.get("/api/assets", async (req, res) => {
  res.json({ assets: await assetsLib.list(req.session.userId) });
});

app.post("/api/assets/link", async (req, res) => {
  try {
    const asset = await assetsLib.createLink(req.session.userId, req.body);
    res.json({ ok: true, asset });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/assets/file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    let appliesTo = [];
    try { appliesTo = JSON.parse(req.body.appliesTo || "[]"); } catch (e) {}
    const asset = await assetsLib.createFile(req.session.userId, {
      label: req.body.label,
      category: req.body.category,
      appliesTo,
      fileBuffer: req.file.buffer,
      fileName: req.file.originalname
    });
    res.json({ ok: true, asset });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/assets/:id", async (req, res) => {
  const removed = await assetsLib.remove(req.session.userId, req.params.id);
  if (!removed) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

app.get("/api/assets/:id/file", async (req, res) => {
  const file = await assetsLib.getFileData(req.session.userId, req.params.id);
  if (!file || !file.file_data) return res.status(404).json({ error: "Not found" });
  res.set("Content-Disposition", `attachment; filename="${file.file_name.replace(/"/g, "")}"`);
  res.set("Content-Type", "application/octet-stream");
  res.send(file.file_data);
});

// ---------- settings ----------
app.get("/api/settings", async (req, res) => {
  res.json(await settings.get(req.session.userId));
});

app.post("/api/settings/openrouter", async (req, res) => {
  try {
    await settings.setOpenrouterKey(req.session.userId, req.body.apiKey, req.body.model);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- generation ----------
// Generates a draft (two-pass pipeline) and stores it as a `messages` row with
// status='draft' — nothing is sent here. Sending is a separate, explicit step.
app.post("/api/generate", async (req, res) => {
  const userId = req.session.userId;
  const { contactId, clientTypeId, angle, subjectHint, extraContext, campaignId } = req.body;
  try {
    const result = await emailGen.generateEmail(userId, { contactId, clientTypeId, angle, subjectHint, extraContext });
    const inserted = await db.query(
      `INSERT INTO messages (user_id, contact_id, campaign_id, direction, status, subject, body_text, generated_by_ai)
       VALUES ($1,$2,$3,'outbound','draft',$4,$5,true) RETURNING id, tracking_id`,
      [userId, contactId, campaignId || null, result.subject, result.body]
    );
    const messageId = inserted.rows[0].id;
    await db.query(
      `INSERT INTO generation_feedback (message_id, draft_subject, draft_body, final_subject, final_body)
       VALUES ($1,$2,$3,$4,$5)`,
      [messageId, result.draftSubject, result.draftBody, result.subject, result.body]
    );
    for (const assetId of result.usedAssetIds || []) {
      await db.query(
        `INSERT INTO message_assets (message_id, asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [messageId, assetId]
      );
    }
    res.json({ ok: true, messageId, subject: result.subject, body: result.body, usedAssetIds: result.usedAssetIds });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

// Explicit send step — takes a drafted (and possibly human-edited) subject/body,
// records whether it was edited (training signal), sends via the chosen mailbox, and
// logs a 'sent' event on the shared timeline.
app.post("/api/messages/:id/send", async (req, res) => {
  const userId = req.session.userId;
  const { subject, body, mailboxConnectionId } = req.body;
  try {
    const msgResult = await db.query(`SELECT * FROM messages WHERE id = $1 AND user_id = $2`, [req.params.id, userId]);
    const message = msgResult.rows[0];
    if (!message) return res.status(404).json({ error: "Message not found." });

    const contactResult = await db.query(`SELECT * FROM contacts WHERE id = $1`, [message.contact_id]);
    const contact = contactResult.rows[0];
    if (!contact) return res.status(400).json({ error: "Contact not found." });

    const finalSubject = subject || message.subject;
    const finalBody = body || message.body_text;
    const wasEdited = finalSubject !== message.subject || finalBody !== message.body_text;

    const trackedContent = await tracking.prepareTrackedContent(userId, message.id, message.tracking_id, {
      text: finalBody,
      html: finalBody.replace(/\n/g, "<br>")
    });
    const attachments = await assetsLib.getAttachmentsForMessage(userId, message.id);

    const sendResult = await mailboxes.sendAndArchive(userId, mailboxConnectionId, {
      to: contact.email,
      subject: finalSubject,
      text: trackedContent.text,
      html: trackedContent.html,
      attachments
    });

    await db.query(
      `UPDATE messages SET status='sent', subject=$2, body_text=$3, message_id_header=$4 WHERE id=$1`,
      [message.id, finalSubject, finalBody, sendResult.messageId]
    );
    if (wasEdited) {
      await db.query(
        `UPDATE generation_feedback SET final_subject=$2, final_body=$3, was_edited=true WHERE message_id=$1`,
        [message.id, finalSubject, finalBody]
      );
    }
    await db.query(
      `INSERT INTO events (user_id, message_id, contact_id, campaign_id, type)
       VALUES ($1,$2,$3,$4,'sent')`,
      [userId, message.id, message.contact_id, message.campaign_id]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

// ---------- send jobs (background bulk/campaign sending) ----------
// Takes a list of already-generated draft message ids and a mailbox to send from.
// Returns immediately with a job id — the worker (lib/sendJobWorker.js) sends them
// one at a time in the background with jittered delays. The UI polls GET /:id for
// progress instead of holding one long request open.
app.post("/api/send-jobs", async (req, res) => {
  try {
    const job = await sendJobs.createJob(req.session.userId, req.body);
    res.json({ ok: true, job });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/send-jobs", async (req, res) => {
  res.json({ jobs: await sendJobs.listJobs(req.session.userId) });
});

app.get("/api/send-jobs/:id", async (req, res) => {
  const job = await sendJobs.getJob(req.session.userId, req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json({ job });
});

app.post("/api/send-jobs/:id/cancel", async (req, res) => {
  const cancelled = await sendJobs.cancelJob(req.session.userId, req.params.id);
  if (!cancelled) return res.status(404).json({ error: "Not found or already finished." });
  res.json({ ok: true });
});

// ---------- campaigns ----------
app.get("/api/campaigns", async (req, res) => {
  res.json({ campaigns: await campaigns.list(req.session.userId) });
});

app.get("/api/campaigns/:id", async (req, res) => {
  const campaign = await campaigns.get(req.session.userId, req.params.id);
  if (!campaign) return res.status(404).json({ error: "Not found" });
  res.json({ campaign });
});

app.get("/api/campaigns/:id/contacts", async (req, res) => {
  try {
    const rows = await campaigns.getContacts(req.session.userId, req.params.id);
    res.json({ contacts: rows });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.post("/api/campaigns", async (req, res) => {
  try {
    const campaign = await campaigns.create(req.session.userId, req.body);
    res.json({ ok: true, campaign });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch("/api/campaigns/:id/status", async (req, res) => {
  try {
    const campaign = await campaigns.setStatus(req.session.userId, req.params.id, req.body.status);
    res.json({ ok: true, campaign });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/campaigns/:id", async (req, res) => {
  const removed = await campaigns.remove(req.session.userId, req.params.id);
  if (!removed) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

// ---------- sequences (auto follow-ups) ----------
app.get("/api/sequences", async (req, res) => {
  res.json({ sequences: await sequences.list(req.session.userId) });
});

app.get("/api/sequences/:id", async (req, res) => {
  const sequence = await sequences.get(req.session.userId, req.params.id);
  if (!sequence) return res.status(404).json({ error: "Not found" });
  res.json({ sequence });
});

app.post("/api/sequences", async (req, res) => {
  try {
    const sequence = await sequences.create(req.session.userId, req.body);
    res.json({ ok: true, sequence });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/sequences/:id/steps", async (req, res) => {
  try {
    const step = await sequences.addStep(req.session.userId, req.params.id, req.body);
    res.json({ ok: true, step });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/sequences/:id", async (req, res) => {
  const removed = await sequences.remove(req.session.userId, req.params.id);
  if (!removed) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

// ---------- enrollments ----------
// Enrolling starts the auto-follow-up clock: the scheduler (lib/sequenceScheduler.js)
// picks up due enrollments on its own tick and generates+queues each step automatically.
app.post("/api/enrollments", async (req, res) => {
  try {
    const { contactId, contactIds, sequenceId, campaignId } = req.body;
    if (Array.isArray(contactIds)) {
      const results = await enrollments.enrollMany(req.session.userId, { contactIds, sequenceId, campaignId });
      return res.json({ results });
    }
    const enrollment = await enrollments.enroll(req.session.userId, { contactId, sequenceId, campaignId });
    res.json({ ok: true, enrollment });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/enrollments", async (req, res) => {
  const { sequenceId, campaignId, status } = req.query;
  res.json({ enrollments: await enrollments.list(req.session.userId, { sequenceId, campaignId, status }) });
});

app.post("/api/enrollments/:id/stop", async (req, res) => {
  const stopped = await enrollments.stop(req.session.userId, req.params.id);
  if (!stopped) return res.status(404).json({ error: "Not found or already inactive." });
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Global error handler — the last line of defense. Any error passed to next() (which
// every route now does automatically, see the app.get/post/etc. patch above) lands
// here instead of crashing the process or leaking a stack trace to the client.
app.use((err, req, res, next) => {
  console.error(`Unhandled error on ${req.method} ${req.path}:`, err);
  if (res.headersSent) return next(err);
  // TEMPORARY DEBUG MODE: exposes the real error message (not the full stack) in the
  // API response so it's visible in the browser Network tab / console without needing
  // server log access. Remove the `detail` field once the underlying bug is found —
  // don't ship this to real users long-term, it can leak internal details (e.g. raw
  // DB error text) to anyone hitting a broken endpoint.
  res.status(500).json({
    error: "Something went wrong on our end. Please try again.",
    detail: err && err.message,
    code: err && err.code
  });
});

// Last-resort safety net: if something still slips past the above (e.g. a rejection in
// code that isn't part of a request at all, like a stray timer), log it instead of
// letting Node's default behavior kill the whole process and take every user down with it.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

runMigrations()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`outreach-platform running on port ${PORT}`);
      sendJobWorker.start();
      sequenceScheduler.start();
      replyPoller.start();
    });
  })
  .catch(err => {
    console.error("Failed to connect to Postgres / run migrations:", err.message);
    process.exit(1);
  });
