const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");

const db = require("./lib/db");
const authStore = require("./lib/authStore");
const store = require("./lib/store");
const googleLib = require("./lib/google");
const openrouter = require("./lib/openrouter");
const mailer = require("./lib/mailer");
const history = require("./lib/history");
const loginLimiter = require("./lib/rateLimit");
const docExtract = require("./lib/docExtract");
const emailGen = require("./lib/emailGen");
const bulk = require("./lib/bulk");
const tracking = require("./lib/tracking");
const bounceDetector = require("./lib/bounceDetector");
const replyDetector = require("./lib/replyDetector");
const sequences = require("./lib/sequences");
const activityLog = require("./lib/activityLog");
const agent = require("./lib/agent");
const emailProvider = require("./lib/emailProvider");
const clientProfiles = require("./lib/clientProfiles");
const importRows = require("./lib/importRows");
const campaigns = require("./lib/campaigns");
const trackedLinks = require("./lib/trackedLinks");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
if (!process.env.PUBLIC_URL) {
  console.warn(
    `\n[WARNING] PUBLIC_URL is not set — open/click tracking links will use "${BASE_URL}", ` +
    `which is unreachable by real recipients and will make opens/clicks silently stop being ` +
    `recorded. Set PUBLIC_URL to this app's real public HTTPS domain (e.g. ` +
    `PUBLIC_URL=https://mail.yourdomain.com) and restart.\n`
  );
}
const BOUNCE_CHECK_INTERVAL_MINUTES = parseInt(process.env.BOUNCE_CHECK_INTERVAL_MINUTES || "15", 10);
const SEQUENCE_CHECK_INTERVAL_MINUTES = parseInt(process.env.SEQUENCE_CHECK_INTERVAL_MINUTES || "10", 10);

app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 30, secure: "auto", httpOnly: true, sameSite: "lax" }
  })
);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ---------- tracking endpoints (public, no auth — recipients hit these) ----------
app.get("/t/open/:trackingId.png", async (req, res) => {
  history.recordOpen(req.params.trackingId).catch(() => {});
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.send(tracking.TRACKING_PIXEL_PNG);
});

app.get("/t/click/:id", async (req, res) => {
  // New links: an opaque id that resolves server-side to the real target —
  // the destination URL is never visible in the link itself (see
  // lib/trackedLinks.js for why: recipient mail providers commonly block
  // the old "URL embedded in a URL" redirect shape as phishing-like).
  const resolved = await trackedLinks.resolve(req.params.id).catch(() => null);
  if (resolved) {
    try {
      await history.recordClick(resolved.trackingId, resolved.targetUrl);
    } catch (e) {
      console.error("Click tracking failed:", e.message);
    }
    return res.redirect(302, resolved.targetUrl);
  }

  // Fallback for links already sitting in inboxes from before this change —
  // the old format encoded the target directly in ?u=.
  const legacyTarget = req.query.u;
  if (legacyTarget && /^https?:\/\//i.test(legacyTarget)) {
    try {
      await history.recordClick(req.params.id, legacyTarget);
    } catch (e) {
      console.error("Click tracking failed:", e.message);
    }
    return res.redirect(302, legacyTarget);
  }

  res.status(400).send("Invalid or expired link.");
});

// ---------- auth ----------
const PUBLIC_PATHS = new Set(["/login.html", "/signup.html", "/style.css", "/api/login", "/api/signup"]);

function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.session.userId) return next();
  if (req.path.startsWith("/api/") || req.path.startsWith("/auth/")) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  return res.redirect("/login.html");
}

app.post("/api/signup", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await authStore.createUser(email, password);
    req.session.userId = user.id;
    res.json({ ok: true, email: user.email });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const lockState = loginLimiter.check(req);
  if (lockState.locked) {
    const minutes = Math.ceil(lockState.retryAfterMs / 60000);
    return res.status(429).json({ error: `Too many attempts. Try again in ${minutes} minute(s).` });
  }
  const user = await authStore.verifyUser(email, password);
  if (!user) {
    loginLimiter.recordFailure(req);
    return res.status(401).json({ error: "Wrong email or password." });
  }
  loginLimiter.recordSuccess(req);
  req.session.userId = user.id;
  res.json({ ok: true, email: user.email });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.use(requireAuth);
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/me", async (req, res) => {
  const user = await authStore.getUserById(req.session.userId);
  res.json({ email: user ? user.email : null });
});

// ---------- settings ----------
app.get("/api/settings", async (req, res) => {
  const userId = req.session.userId;
  const s = await store.load(userId);
  const { usingOwnKey } = await openrouter.resolveCredentials(userId);
  const googleConnected = await googleLib.isConnected(userId);

  res.json({
    name: s.name,
    companyName: s.companyName,
    phone: s.phone,
    signature: s.signature,
    links: s.links,
    openrouterModel: s.openrouterModel,
    hasOpenrouterKey: !!s.openrouterApiKey,
    usingOwnOpenrouterKey: usingOwnKey,
    platformKeyAvailable: !!process.env.PLATFORM_OPENROUTER_API_KEY,
    emailFormat: s.emailFormat,
    subjectTemplate: s.subjectTemplate,
    extraInfo: s.extraInfo,
    ccSelf: s.ccSelf,
    trackOpens: s.trackOpens,
    trackClicks: s.trackClicks,
    collateralFiles: s.collateralFiles,
    defaultCollateralIds: s.defaultCollateralIds,
    emailProvider: s.emailProvider,
    googleConfigured: googleLib.isConfigured(),
    googleConnected,
    googleEmail: s.google.email,
    smtp: {
      host: s.smtp.host,
      port: s.smtp.port,
      secure: s.smtp.secure,
      username: s.smtp.username,
      fromEmail: s.smtp.fromEmail,
      fromName: s.smtp.fromName,
      hasPassword: !!s.smtp.password
    }
  });
});

app.post("/api/settings", async (req, res) => {
  const userId = req.session.userId;
  const {
    name,
    companyName,
    phone,
    signature,
    links,
    openrouterApiKey,
    openrouterModel,
    emailFormat,
    subjectTemplate,
    extraInfo,
    ccSelf,
    trackOpens,
    trackClicks,
    emailProvider: emailProviderChoice,
    smtp
  } = req.body;
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (companyName !== undefined) patch.companyName = companyName;
  if (phone !== undefined) patch.phone = phone;
  if (signature !== undefined) patch.signature = signature;
  if (links !== undefined) {
    // Keep it to well-formed {id, label, url} entries with both fields present.
    patch.links = Array.isArray(links)
      ? links
          .filter(l => l && l.label && l.url)
          .map(l => ({ id: l.id || crypto.randomUUID(), label: String(l.label).trim(), url: String(l.url).trim() }))
      : [];
  }
  if (openrouterApiKey !== undefined) patch.openrouterApiKey = openrouterApiKey;
  if (openrouterModel !== undefined) patch.openrouterModel = openrouterModel;
  if (emailFormat !== undefined) patch.emailFormat = emailFormat;
  if (subjectTemplate !== undefined) patch.subjectTemplate = subjectTemplate;
  if (emailProviderChoice === "gmail" || emailProviderChoice === "smtp") patch.emailProvider = emailProviderChoice;
  if (smtp !== undefined) {
    const smtpPatch = {
      host: smtp.host !== undefined ? String(smtp.host).trim() : undefined,
      port: smtp.port !== undefined ? parseInt(smtp.port, 10) || 587 : undefined,
      secure: smtp.secure !== undefined ? !!smtp.secure : undefined,
      username: smtp.username !== undefined ? String(smtp.username).trim() : undefined,
      fromEmail: smtp.fromEmail !== undefined ? String(smtp.fromEmail).trim() : undefined,
      fromName: smtp.fromName !== undefined ? String(smtp.fromName).trim() : undefined
    };
    // Only overwrite the stored password if a new one was actually typed —
    // an empty/missing field here means "keep what's already saved".
    if (smtp.password) smtpPatch.password = smtp.password;
    Object.keys(smtpPatch).forEach(k => smtpPatch[k] === undefined && delete smtpPatch[k]);
    patch.smtp = smtpPatch;
  }
  if (extraInfo !== undefined) patch.extraInfo = extraInfo;
  if (ccSelf !== undefined) patch.ccSelf = !!ccSelf;
  if (trackOpens !== undefined) patch.trackOpens = !!trackOpens;
  if (trackClicks !== undefined) patch.trackClicks = !!trackClicks;
  await store.update(userId, patch);
  res.json({ ok: true });
});

// Tests SMTP credentials without sending anything — lets someone confirm
// their setup works before switching their active sending method to it.
app.post("/api/smtp/test", async (req, res) => {
  const userId = req.session.userId;
  const { smtp } = req.body;
  try {
    const s = await store.load(userId);
    // Same "blank means keep the saved one" pattern as the settings save —
    // lets someone test without retyping a password they already saved.
    const merged = { ...s.smtp, ...smtp };
    if (!smtp || !smtp.password) merged.password = s.smtp.password;

    if (!emailProvider.smtpConfigured(merged)) {
      return res.status(400).json({ error: "Fill in host, username, password, and from address first." });
    }
    await mailer.verifySmtp(merged);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/collateral", upload.single("file"), async (req, res) => {
  const userId = req.session.userId;
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const label = (req.body.label || "").trim() || req.file.originalname.replace(/\.[^.]+$/, "");
  const ext = path.extname(req.file.originalname) || "";
  const id = crypto.randomUUID();
  const finalName = `collateral_${id}${ext}`;

  const text = await docExtract.extractTextFromBuffer(req.file.buffer, ext);
  const updated = await store.addCollateral(userId, {
    id,
    label,
    fileName: finalName,
    mimeType: req.file.mimetype || "application/octet-stream",
    content: req.file.buffer,
    text
  });
  res.json({
    ok: true,
    collateralFiles: updated.collateralFiles,
    defaultCollateralIds: updated.defaultCollateralIds,
    textExtracted: !!text
  });
});

app.delete("/api/collateral/:id", async (req, res) => {
  const updated = await store.removeCollateral(req.session.userId, req.params.id);
  res.json({ ok: true, collateralFiles: updated.collateralFiles, defaultCollateralIds: updated.defaultCollateralIds });
});

app.post("/api/collateral/:id/default", async (req, res) => {
  const updated = await store.toggleDefaultCollateral(req.session.userId, req.params.id);
  res.json({ ok: true, defaultCollateralIds: updated.defaultCollateralIds });
});

// ---------- google oauth ----------
app.get("/auth/google", (req, res) => {
  if (!googleLib.isConfigured()) {
    return res.status(400).send("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars are not set yet.");
  }
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  res.redirect(googleLib.getAuthUrl(state));
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!req.query.state || req.query.state !== req.session.oauthState) {
      return res.status(400).send("Invalid or expired OAuth state. Please try connecting again.");
    }
    delete req.session.oauthState;
    const email = await googleLib.handleCallback(req.session.userId, req.query.code);
    res.redirect(`/settings.html?connected=${encodeURIComponent(email)}`);
  } catch (e) {
    console.error(e);
    res.status(500).send("Google connection failed: " + e.message);
  }
});

app.post("/api/google/disconnect", async (req, res) => {
  await googleLib.disconnect(req.session.userId);
  res.json({ ok: true });
});

// ---------- extract (paste a LinkedIn bio / note about a prospect) ----------
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

function regexExtract(pasted) {
  const match = pasted.match(EMAIL_REGEX);
  const to = match ? match[0] : "";
  return { to, company: "", contactName: "", notes: pasted.trim() };
}

app.post("/api/extract", async (req, res) => {
  const userId = req.session.userId;
  const { pasted } = req.body;
  if (!pasted || !pasted.trim()) return res.status(400).json({ error: "Paste some text first." });

  try {
    const result = await openrouter.extractProspectInfo(userId, pasted);
    const emailMatch = pasted.match(EMAIL_REGEX);
    res.json({
      to: emailMatch ? emailMatch[0] : "",
      company: result.company,
      contactName: result.contactName,
      notes: result.notes
    });
  } catch (e) {
    console.error("AI extraction failed, falling back to regex:", e.message);
    res.json(regexExtract(pasted));
  }
});

// ---------- client types ("kinds of clients") ----------
app.get("/api/client-profiles", async (req, res) => {
  const list = await clientProfiles.list(req.session.userId);
  res.json({ clientProfiles: list });
});

app.post("/api/client-profiles", async (req, res) => {
  try {
    const created = await clientProfiles.create(req.session.userId, req.body);
    res.json({ ok: true, clientProfile: created });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put("/api/client-profiles/:id", async (req, res) => {
  try {
    const updated = await clientProfiles.update(req.session.userId, req.params.id, req.body);
    res.json({ ok: true, clientProfile: updated });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/client-profiles/:id", async (req, res) => {
  const removed = await clientProfiles.remove(req.session.userId, req.params.id);
  if (!removed) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

// ---------- compose (single) ----------
app.post("/api/generate", async (req, res) => {
  const userId = req.session.userId;
  try {
    const { company, contactName, notes, collateralIds, clientProfileId } = req.body;
    const { subject, textBody, clientProfile, collateralIds: usedCollateralIds } = await emailGen.generateForProspect(userId, {
      company,
      contactName,
      notes,
      collateralIds,
      clientProfileId
    });
    res.json({ ok: true, subject, body: textBody, clientProfile, collateralIds: usedCollateralIds });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/send", async (req, res) => {
  const userId = req.session.userId;
  const { to, company, contactName, subject, body, attachCollateral, collateralIds } = req.body;
  try {
    if (!to || !subject || !body) {
      return res.status(400).json({ error: "to, subject and body are all required." });
    }
    const readiness = await emailProvider.checkReady(userId);
    if (!readiness.ready) {
      return res.status(400).json({ error: readiness.reason });
    }

    const s = await store.load(userId);
    const trackingId = crypto.randomUUID();
    const htmlBody = await emailGen.buildTrackedVersion(body, {
      trackingId,
      baseUrl: BASE_URL,
      trackOpens: s.trackOpens,
      trackClicks: s.trackClicks
    });

    const result = await mailer.sendOutreachEmail(userId, {
      to,
      subject,
      textBody: tracking.markdownLinksToPlainText(body),
      htmlBody,
      attachCollateral: !!attachCollateral,
      collateralIds
    });

    await history.add(userId, {
      to,
      company,
      contactName,
      subject,
      status: "sent",
      trackingId,
      gmailMessageId: result.id,
      gmailThreadId: result.threadId
    });
    res.json({ ok: true, id: result.id });
  } catch (e) {
    console.error(e);
    await history.add(userId, { to, company, contactName, subject, status: "failed", error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ---------- bulk ----------
app.post("/api/bulk/parse", upload.single("file"), async (req, res) => {
  const userId = req.session.userId;
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  let parsed;
  try {
    parsed = bulk.parseFile(req.file.buffer, req.file.originalname);
  } catch (e) {
    return res.status(400).json({ error: "Couldn't read that file. Make sure it's a valid CSV or Excel (.xlsx) file." });
  }
  if (!parsed.rows.length) {
    return res.status(400).json({
      error: "No rows found. Make sure the file has a header row with columns like email, company, name, notes."
    });
  }

  const rows = [];
  const defaultClientProfileId = (req.body && req.body.defaultClientProfileId) || "";
  for (const row of parsed.rows) {
    let { to, company, contactName, notes, raw } = row;

    if (raw && (!to || !company)) {
      try {
        const extracted = await openrouter.extractProspectInfo(userId, raw);
        company = company || extracted.company;
        contactName = contactName || extracted.contactName;
        notes = notes || extracted.notes;
        if (!to) {
          const m = raw.match(EMAIL_REGEX);
          if (m) to = m[0];
        }
      } catch (e) {
        console.error(`Bulk row ${row.rowIndex} extraction failed:`, e.message);
      }
    }

    const priorSends = to ? await history.findByEmail(userId, to) : [];
    rows.push({
      rowIndex: row.rowIndex,
      to,
      company,
      contactName,
      notes,
      providedBody: row.body || "",
      clientProfileId: defaultClientProfileId || "",
      valid: !!to,
      duplicate: priorSends.length > 0
    });
  }

  // Persisted immediately — this batch (and any edits/deletes to it) will
  // still be here even if nothing gets generated or sent this session.
  const batchLabel = (req.body && req.body.batchLabel) || "";
  const savedRows = await importRows.createBatch(userId, batchLabel, rows);
  const savedById = new Map(savedRows.map(r => [r.rowIndex, r]));
  const rowsWithIds = rows.map(r => ({ ...r, id: savedById.get(r.rowIndex) ? savedById.get(r.rowIndex).id : null }));
  const batchId = savedRows.length ? savedRows[0].batchId : null;

  res.json({ rows: rowsWithIds, batchId, truncated: parsed.truncated, totalRows: parsed.totalRows, maxRows: bulk.MAX_ROWS });
});

// ---------- campaigns ----------
app.get("/api/campaigns", async (req, res) => {
  const list = await campaigns.listWithStats(req.session.userId);
  res.json({ campaigns: list });
});

app.get("/api/campaigns/:id", async (req, res) => {
  const campaign = await campaigns.getStats(req.session.userId, req.params.id);
  if (!campaign) return res.status(404).json({ error: "Not found" });
  const rows = await importRows.listRows(req.session.userId, req.params.id);
  const rowsWithStatus = await Promise.all(
    rows.map(async r => {
      const priorSends = r.to ? await history.findByEmail(req.session.userId, r.to) : [];
      return { ...r, valid: !!r.to, duplicate: priorSends.length > 0 };
    })
  );
  res.json({ campaign, rows: rowsWithStatus });
});

app.put("/api/campaigns/:id", async (req, res) => {
  const updated = await campaigns.rename(req.session.userId, req.params.id, req.body.name);
  if (!updated) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true, campaign: updated });
});

app.delete("/api/campaigns/:id", async (req, res) => {
  await importRows.removeBatch(req.session.userId, req.params.id); // also deletes the campaign row
  res.json({ ok: true });
});

// Kept for the row-level edit/delete controls in the campaign detail view.
app.put("/api/bulk/imports/rows/:id", async (req, res) => {
  const updated = await importRows.updateRow(req.session.userId, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true, row: updated });
});

app.delete("/api/bulk/imports/rows/:id", async (req, res) => {
  const removed = await importRows.removeRow(req.session.userId, req.params.id);
  if (!removed) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

app.post("/api/bulk/generate", async (req, res) => {
  const userId = req.session.userId;
  const { rows, collateralIds } = req.body;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: "No rows to generate." });
  if (rows.length > bulk.MAX_ROWS) return res.status(400).json({ error: `Too many rows — max ${bulk.MAX_ROWS} per batch.` });

  const settings = await store.load(userId);
  const profiles = await clientProfiles.list(userId);
  const results = [];
  let stoppedForCap = false;

  for (const row of rows) {
    if (stoppedForCap) {
      results.push({ rowIndex: row.rowIndex, error: "Skipped — daily AI limit reached." });
      continue;
    }
    try {
      // collateralIds (not pre-resolved collateral) is passed through so
      // each row can fall back to its own matched client type's default
      // collateral set when the batch wasn't pinned to specific docs.
      // clientProfileId is a manual override — if the row has one, it skips
      // AI auto-detection entirely and uses that client type outright.
      // providedBody (from a CSV "body" column) skips the AI call for that
      // row entirely — everything else (collateral, subject, signature)
      // still applies exactly the same.
      const { subject, textBody, clientProfile, collateralIds: usedCollateralIds, wasGenerated } = await emailGen.generateForProspect(userId, {
        company: row.company,
        contactName: row.contactName,
        notes: row.notes,
        settings,
        profiles,
        collateralIds,
        clientProfileId: row.clientProfileId || undefined,
        providedBody: row.providedBody || undefined
      });
      results.push({
        rowIndex: row.rowIndex,
        to: row.to,
        company: row.company,
        contactName: row.contactName,
        subject,
        body: textBody,
        clientProfile,
        collateralIds: usedCollateralIds,
        wasGenerated
      });
    } catch (e) {
      results.push({ rowIndex: row.rowIndex, to: row.to, company: row.company, error: e.message });
      if (e.message.includes("today's limit")) stoppedForCap = true;
    }
  }

  res.json({ results, stoppedForCap });
});

app.post("/api/bulk/send", async (req, res) => {
  const userId = req.session.userId;
  const { items, attachCollateral, collateralIds, batchLabel, campaignId } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "No emails to send." });
  const readiness = await emailProvider.checkReady(userId);
  if (!readiness.ready) {
    return res.status(400).json({ error: readiness.reason });
  }

  const s = await store.load(userId);
  const results = [];

  if (campaignId) await campaigns.setStatus(userId, campaignId, "sending");

  for (const item of items) {
    try {
      if (!item.to || !item.subject || !item.body) throw new Error("Missing recipient, subject, or body.");

      const trackingId = crypto.randomUUID();
      const htmlBody = await emailGen.buildTrackedVersion(item.body, {
        trackingId,
        baseUrl: BASE_URL,
        trackOpens: s.trackOpens,
        trackClicks: s.trackClicks
      });

      // Prefer the exact set of docs this row's email was actually grounded
      // in (item.collateralIds, carried over from generation) so what gets
      // attached matches what the pitch actually references; fall back to
      // the batch-wide picker only if that's missing.
      const result = await mailer.sendOutreachEmail(userId, {
        to: item.to,
        subject: item.subject,
        textBody: tracking.markdownLinksToPlainText(item.body),
        htmlBody,
        attachCollateral: !!attachCollateral,
        collateralIds: (item.collateralIds && item.collateralIds.length) ? item.collateralIds : collateralIds
      });

      await history.add(userId, {
        to: item.to,
        company: item.company,
        contactName: item.contactName,
        subject: item.subject,
        status: "sent",
        trackingId,
        gmailMessageId: result.id,
        gmailThreadId: result.threadId,
        batchLabel: batchLabel || "",
        campaignId: campaignId || null
      });
      results.push({ to: item.to, ok: true });
    } catch (e) {
      console.error(e);
      await history.add(userId, {
        to: item.to,
        company: item.company,
        contactName: item.contactName,
        subject: item.subject,
        status: "failed",
        error: e.message,
        batchLabel: batchLabel || "",
        campaignId: campaignId || null
      });
      results.push({ to: item.to, ok: false, error: e.message });
    }
    await new Promise(r => setTimeout(r, 600));
  }

  const sentCount = results.filter(r => r.ok).length;
  if (campaignId) await campaigns.setStatus(userId, campaignId, "sent");
  res.json({ results, sentCount, failedCount: results.length - sentCount });
});

// ---------- analytics / history ----------
app.get("/api/history", async (req, res) => {
  const userId = req.session.userId;
  const { search, limit, status, batch } = req.query;
  const [entries, stats] = await Promise.all([
    history.list(userId, { search, status, batch, limit: limit ? parseInt(limit, 10) : undefined }),
    history.stats(userId)
  ]);
  res.json({ entries, stats });
});

app.get("/api/history/batches", async (req, res) => {
  const batches = await history.listBatches(req.session.userId);
  res.json({ batches });
});

app.get("/api/history/check", async (req, res) => {
  const priorSends = await history.findByEmail(req.session.userId, req.query.to);
  res.json({ priorSends });
});

app.patch("/api/history/:id", async (req, res) => {
  const { company, contactName, to, status } = req.body;
  const updated = await history.update(req.session.userId, req.params.id, { company, contactName, to, status });
  if (!updated) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true, entry: updated });
});

app.delete("/api/history/:id", async (req, res) => {
  const removed = await history.remove(req.session.userId, req.params.id);
  if (!removed) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

app.get("/api/history/export.csv", async (req, res) => {
  const csv = await history.toCsv(req.session.userId);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="outreach-history.csv"');
  res.send(csv);
});

// ---------- sequences ----------
app.get("/api/sequences", async (req, res) => {
  const list = await sequences.listSequences(req.session.userId);
  res.json({ sequences: list });
});

app.post("/api/sequences", async (req, res) => {
  try {
    const { name, steps } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "Give the sequence a name." });
    if (!Array.isArray(steps) || !steps.length) return res.status(400).json({ error: "Add at least one step." });
    const saved = await sequences.saveSequence(req.session.userId, { name: name.trim(), steps });
    res.json({ ok: true, sequence: saved });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/sequences/enrollments", async (req, res) => {
  const { sequenceId, status } = req.query;
  const list = await sequences.listEnrollments(req.session.userId, { sequenceId, status });
  res.json({ enrollments: list });
});

app.post("/api/sequences/enrollments/:id/stop", async (req, res) => {
  const stopped = await sequences.stopEnrollment(req.session.userId, req.params.id);
  if (!stopped) return res.status(404).json({ error: "Enrollment not found or already stopped." });
  res.json({ ok: true });
});

app.post("/api/sequences/enrollments/:id/retry", async (req, res) => {
  const retried = await sequences.retryEnrollment(req.session.userId, req.params.id);
  if (!retried) return res.status(404).json({ error: "Enrollment not found or not in an error state." });
  res.json({ ok: true });
});

app.get("/api/sequences/:id", async (req, res) => {
  const sequence = await sequences.getSequence(req.session.userId, req.params.id);
  if (!sequence) return res.status(404).json({ error: "Not found" });
  res.json({ sequence });
});

app.put("/api/sequences/:id", async (req, res) => {
  try {
    const { name, steps } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "Give the sequence a name." });
    if (!Array.isArray(steps) || !steps.length) return res.status(400).json({ error: "Add at least one step." });
    const saved = await sequences.saveSequence(req.session.userId, { id: req.params.id, name: name.trim(), steps });
    res.json({ ok: true, sequence: saved });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/sequences/:id", async (req, res) => {
  const removed = await sequences.deleteSequence(req.session.userId, req.params.id);
  if (!removed) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

app.post("/api/sequences/:id/enroll", async (req, res) => {
  try {
    const { to, company, contactName, notes, collateralId } = req.body;
    const enrollmentId = await sequences.enroll(req.session.userId, req.params.id, {
      to,
      company,
      contactName,
      notes,
      collateralId
    });
    res.json({ ok: true, enrollmentId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/sequences/:id/enroll-bulk", async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: "No rows to enroll." });
  if (rows.length > bulk.MAX_ROWS) return res.status(400).json({ error: `Too many rows — max ${bulk.MAX_ROWS} per batch.` });

  const results = [];
  for (const row of rows) {
    try {
      const enrollmentId = await sequences.enroll(req.session.userId, req.params.id, {
        to: row.to,
        company: row.company,
        contactName: row.contactName,
        notes: row.notes
      });
      results.push({ to: row.to, ok: true, enrollmentId });
    } catch (e) {
      results.push({ to: row.to, ok: false, error: e.message });
    }
  }
  res.json({ results, enrolledCount: results.filter(r => r.ok).length });
});

// Manual "process due steps now" — mirrors the bounce "check now" button,
// mainly useful right after setting up a sequence rather than waiting for
// the next automatic sweep.
app.post("/api/sequences/run-now", async (req, res) => {
  const result = await sequences.processDueEnrollments(BASE_URL);
  res.json(result);
});


app.post("/api/bounces/check", async (req, res) => {
  const result = await bounceDetector.checkBouncesForUser(req.session.userId);
  res.json(result);
});

app.post("/api/replies/check", async (req, res) => {
  const result = await replyDetector.checkRepliesForUser(req.session.userId);
  res.json(result);
});

app.get("/api/logs", async (req, res) => {
  const { category, limit } = req.query;
  const entries = await activityLog.list(req.session.userId, {
    category,
    limit: limit ? parseInt(limit, 10) : undefined
  });
  res.json({ entries });
});

// ---------- AI assistant ----------
app.post("/api/agent/message", async (req, res) => {
  const userId = req.session.userId;
  const { message, conversation } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Say something first." });
  }
  try {
    const result = await agent.runTurn(userId, Array.isArray(conversation) ? conversation : [], message);
    res.json({ ok: true, reply: result.reply, messages: result.messages, pendingAction: result.pendingAction });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

async function runBounceSweepForAllUsers() {
  try {
    const result = await db.query(
      `SELECT user_id FROM user_settings WHERE data->'google'->>'refreshToken' IS NOT NULL AND data->'google'->>'refreshToken' != ''`
    );
    for (const row of result.rows) {
      try {
        await bounceDetector.checkBouncesForUser(row.user_id);
      } catch (e) {
        console.error(`Bounce sweep failed for user ${row.user_id}:`, e.message);
      }
      try {
        await replyDetector.checkRepliesForUser(row.user_id);
      } catch (e) {
        console.error(`Reply sweep failed for user ${row.user_id}:`, e.message);
      }
    }
  } catch (e) {
    console.error("Bounce/reply sweep query failed:", e.message);
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

db.runMigrations()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`outreach-mailer running on port ${PORT}, connected to Postgres`);
      if (BOUNCE_CHECK_INTERVAL_MINUTES > 0) {
        setInterval(runBounceSweepForAllUsers, BOUNCE_CHECK_INTERVAL_MINUTES * 60 * 1000);
      }
      if (SEQUENCE_CHECK_INTERVAL_MINUTES > 0) {
        setInterval(() => {
          sequences.processDueEnrollments(BASE_URL).catch(e => console.error("Sequence sweep failed:", e.message));
        }, SEQUENCE_CHECK_INTERVAL_MINUTES * 60 * 1000);
      }
    });
  })
  .catch(err => {
    console.error("Failed to connect to Postgres / run migrations:", err.message);
    process.exit(1);
  });
