const db = require("./db");

const DEFAULT_FORMAT = `Write a concise, professional cold outreach email pitching our services to a potential
customer.

Structure to follow:
1. A short, personalized opening line that references something specific about the
   prospect's company (from the notes/context given) — not a generic "I hope this finds
   you well."
2. 2-3 sentences: what we do and why it's specifically relevant to them — connect a real
   detail about our services to something about their situation. Be concrete, not generic.
   Avoid filler like "we'd love to help you grow."
3. A single, low-friction call to action (e.g. "Worth a quick call this week?"). Never
   state a specific duration (e.g. "15-minute," "30-minute") unless a link you're using
   states that duration itself — never guess or default to a number.
   If a demo, booking, or pricing link is genuinely relevant, weave it into this sentence
   as a natural inline hyperlink rather than dropping it on its own line.
4. A short closing line. Do NOT write a sign-off, closing name, company name, or phone
   number — never invent your own signature block. The app appends your real signature
   automatically after your text, so your email should just end after the closing line.

Use exactly {{company}} for the prospect's company name and {{contactName}} for their name
if given — do not paraphrase or rename them.

Keep the whole email under 150 words. Plain text only, no markdown, no bullet points, no
hard selling or hype language — the one exception is a genuinely relevant link, which
should be written as an inline markdown link, e.g. "[a quick demo](https://example.com)",
placed naturally inside a sentence rather than pasted as a bare URL.`;

const DEFAULTS = {
  name: "", // sender's own name
  companyName: "", // sender's company name
  phone: "",
  signature: "", // free-text signature block, supports {{name}} {{companyName}} {{phone}} tokens; empty = auto-built from those three fields, one per line
  links: [], // [{ id, label, url }] — website, pricing page, case study, calendar link, etc.
  openrouterApiKey: "", // per-user override; empty = use the platform's shared key
  openrouterModel: "", // per-user override; empty = use the platform's default model
  emailFormat: DEFAULT_FORMAT,
  subjectTemplate: "Quick question about {{company}}",
  extraInfo: "", // what the company sells / who it's for / pricing notes / proof points, etc.
  defaultCollateralId: "", // deprecated — kept only to migrate old accounts, see loadRaw()
  defaultCollateralIds: [], // account-level default set of collateral docs
  ccSelf: false,
  trackOpens: true,
  trackClicks: true,
  emailProvider: "gmail", // "gmail" | "smtp" — which one actually sends
  google: { refreshToken: "", email: "" },
  smtp: {
    host: "",
    port: 587,
    secure: false, // true = implicit TLS (port 465); false = STARTTLS (port 587) or plain
    username: "",
    password: "",
    fromEmail: "",
    fromName: ""
  }
};

async function loadRaw(userId) {
  const result = await db.query("SELECT data FROM user_settings WHERE user_id = $1", [userId]);
  if (!result.rows.length) {
    await db.query(
      "INSERT INTO user_settings (user_id, data) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
      [userId, JSON.stringify(DEFAULTS)]
    );
    return { ...DEFAULTS };
  }
  const merged = { ...DEFAULTS, ...result.rows[0].data };
  // One-time migration: accounts saved before multi-collateral existed only
  // have the old single defaultCollateralId — carry it into the new array
  // so nothing that used to be "the default doc" silently stops being one.
  if ((!merged.defaultCollateralIds || !merged.defaultCollateralIds.length) && merged.defaultCollateralId) {
    merged.defaultCollateralIds = [merged.defaultCollateralId];
  }
  return merged;
}

async function listCollateral(userId) {
  const result = await db.query(
    "SELECT id, label, file_name, text FROM collateral_files WHERE user_id = $1 ORDER BY created_at ASC",
    [userId]
  );
  return result.rows.map(r => ({ id: r.id, label: r.label, fileName: r.file_name, text: r.text }));
}

// Full settings object — collateralFiles is attached live from its own table
// so callers don't need to know it's stored separately.
async function load(userId) {
  const [settings, collateralFiles] = await Promise.all([loadRaw(userId), listCollateral(userId)]);
  return { ...settings, collateralFiles };
}

async function save(userId, settings) {
  const { collateralFiles, ...rest } = settings; // derived, never persisted here
  await db.query(
    `INSERT INTO user_settings (user_id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = now()`,
    [userId, JSON.stringify(rest)]
  );
}

async function update(userId, patch) {
  const current = await load(userId);
  const merged = {
    ...current,
    ...patch,
    google: { ...current.google, ...(patch.google || {}) },
    smtp: { ...current.smtp, ...(patch.smtp || {}) }
  };
  await save(userId, merged);
  return merged;
}

// Resolves which collateral doc ids actually apply: an explicit list wins,
// then the account's default set, then — to preserve old single-doc
// behavior for anyone who hasn't touched this — the first uploaded doc if
// nothing else is set.
function resolveCollateralIds(s, collateralIds) {
  if (collateralIds && collateralIds.length) return collateralIds;
  if (s.defaultCollateralIds && s.defaultCollateralIds.length) return s.defaultCollateralIds;
  if (s.collateralFiles.length) return [s.collateralFiles[0].id];
  return [];
}

// Lightweight collateral entries (id, label, fileName, text) — no file
// bytes. Pass specific ids to get those; omit to get the user's defaults.
async function getCollateralTexts(userId, collateralIds) {
  const s = await load(userId);
  const ids = resolveCollateralIds(s, collateralIds);
  return ids.map(id => s.collateralFiles.find(c => c.id === id)).filter(Boolean);
}

// Backward-compat singular version — still used anywhere that only ever
// dealt with one doc.
async function getCollateral(userId, collateralId) {
  const list = await getCollateralTexts(userId, collateralId ? [collateralId] : undefined);
  return list[0] || null;
}

// Full collateral docs including file bytes — used only when actually
// attaching to an outgoing email. Returns them in the same order as ids.
async function getCollateralFiles(userId, collateralIds) {
  const s = await load(userId);
  const ids = resolveCollateralIds(s, collateralIds);
  if (!ids.length) return [];
  const result = await db.query(
    "SELECT id, file_name, mime_type, content FROM collateral_files WHERE id = ANY($1::uuid[]) AND user_id = $2",
    [ids, userId]
  );
  return ids
    .map(id => result.rows.find(r => r.id === id))
    .filter(Boolean)
    .map(row => ({ fileName: row.file_name, mimeType: row.mime_type, content: row.content }));
}

// Backward-compat singular version.
async function getCollateralFile(userId, collateralId) {
  const list = await getCollateralFiles(userId, collateralId ? [collateralId] : undefined);
  return list[0] || null;
}

async function addCollateral(userId, { id, label, fileName, mimeType, content, text }) {
  await db.query(
    `INSERT INTO collateral_files (id, user_id, label, file_name, mime_type, content, text)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, userId, label, fileName, mimeType, content, text || ""]
  );
  const s = await loadRaw(userId);
  if (!s.defaultCollateralIds || !s.defaultCollateralIds.length) {
    return update(userId, { defaultCollateralIds: [id] });
  }
  return load(userId);
}

async function removeCollateral(userId, id) {
  await db.query("DELETE FROM collateral_files WHERE id = $1 AND user_id = $2", [id, userId]);
  const s = await loadRaw(userId);
  const remainingIds = (s.defaultCollateralIds || []).filter(x => x !== id);
  if (remainingIds.length !== (s.defaultCollateralIds || []).length) {
    return update(userId, { defaultCollateralIds: remainingIds });
  }
  return load(userId);
}

// Toggles whether a collateral doc is part of the account-level default
// set (used when nothing more specific — a client type, a manual pick —
// overrides it).
async function toggleDefaultCollateral(userId, id) {
  const s = await loadRaw(userId);
  const current = s.defaultCollateralIds || [];
  const next = current.includes(id) ? current.filter(x => x !== id) : [...current, id];
  return update(userId, { defaultCollateralIds: next });
}

module.exports = {
  load,
  save,
  update,
  getCollateral,
  getCollateralFile,
  getCollateralTexts,
  getCollateralFiles,
  addCollateral,
  removeCollateral,
  toggleDefaultCollateral,
  DEFAULT_FORMAT
};
