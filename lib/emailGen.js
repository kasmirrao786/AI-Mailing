// Email generation pipeline.
//
// Why this is structured as two passes instead of "one prompt, done":
// the single biggest quality lever isn't a cleverer prompt, it's (a) giving the model a
// proven structural skeleton per client type instead of free-writing from scratch, and
// (b) a second pass that critiques the first draft against a concrete rubric before it
// ever reaches a human reviewer. Cheap insurance against generic "AI-sounding" copy.
const db = require("./db");
const openrouter = require("./openrouter");

const DRAFT_SYSTEM_PROMPT = `You write short, specific cold outreach emails for business services. You are given:
- a client type's tone notes and a structural skeleton to follow
- a few example emails that represent the quality bar
- facts about one specific prospect
- which assets (links/files) are available to reference this email

Rules:
- Follow the skeleton's structure, but write fresh content — never copy the examples verbatim.
- Reference the prospect's specific situation; never write something that could be sent to anyone.
- Keep it short. Cold emails over ~120 words get ignored.
- Only reference an asset if it's actually relevant to this step's angle — don't cram every link in.
- No generic AI phrasing ("I hope this email finds you well", "In today's fast-paced world", etc).
- Output ONLY valid JSON: {"subject": "...", "body": "..."}. No markdown fences, no commentary.
- In "body", use {{asset:LABEL}} as a placeholder anywhere you want a link/file inserted, where
  LABEL exactly matches one of the provided asset labels.`;

const CRITIQUE_SYSTEM_PROMPT = `You are a ruthless editor for cold outreach email quality. You will be given a
draft email plus the same brief it was written from. Rewrite it if needed to fix any of:
- Generic AI-sounding phrasing or filler
- Length over ~130 words
- A vague or missing call to action
- Asset placeholders that don't match anything relevant to this email's angle
- Weak/generic subject line (should be specific and low-hype, not clickbait)

If the draft already clears the bar, return it unchanged. Output ONLY valid JSON:
{"subject": "...", "body": "..."}. No markdown fences, no commentary.`;

function safeParseJson(text) {
  const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Model did not return valid JSON for the email draft.");
  }
}

async function loadClientType(userId, clientTypeId) {
  const ctResult = await db.query(`SELECT * FROM client_types WHERE id = $1 AND user_id = $2`, [clientTypeId, userId]);
  const clientType = ctResult.rows[0];
  if (!clientType) throw new Error("Client type not found.");
  const exResult = await db.query(
    `SELECT subject, body, note FROM client_type_examples WHERE client_type_id = $1 AND is_active = true ORDER BY created_at LIMIT 3`,
    [clientTypeId]
  );
  return { clientType, examples: exResult.rows };
}

// Picks assets relevant to this client type + sequence angle. Booking/demo links are
// generally always relevant; case studies/pricing are held back for later steps unless
// explicitly requested, so step 1 doesn't arrive looking like a brochure dump.
async function selectAssets(userId, { clientTypeId, angle }) {
  const result = await db.query(
    `SELECT id, label, kind, category, url, file_name, applies_to
     FROM assets WHERE user_id = $1`,
    [userId]
  );
  const all = result.rows.filter(a => {
    const applies = Array.isArray(a.applies_to) ? a.applies_to : [];
    return applies.length === 0 || applies.includes(clientTypeId);
  });

  const isLateStep = /bump|breakup|follow.?up/i.test(angle || "");
  return all.filter(a => {
    if (a.category === "demo" || a.category === "booking") return true; // always eligible
    if (a.category === "case_study" || a.category === "pricing" || a.category === "one_pager") {
      return isLateStep || /pitch|full/i.test(angle || "");
    }
    return true;
  });
}

function buildBriefBlock({ clientType, examples, prospect, angle, subjectHint, assets }) {
  const exampleBlock = examples.length
    ? examples.map((e, i) => `Example ${i + 1} (subject: ${e.subject}):\n${e.body}`).join("\n\n")
    : "(no curated examples yet — rely on the skeleton and tone notes)";

  const assetBlock = assets.length
    ? assets.map(a => `- ${a.label} (${a.category}${a.kind === "file" ? ", file attachment" : ", link"})`).join("\n")
    : "(no assets available for this email)";

  return `CLIENT TYPE: ${clientType.name}
TONE NOTES: ${clientType.tone_notes || "(none given — use a direct, professional tone)"}
SKELETON TO FOLLOW:
${clientType.skeleton || "(no fixed skeleton — use a standard cold-email structure: hook referencing their situation, one-line value prop, one proof point, one clear CTA)"}

GOOD EXAMPLES FOR THIS CLIENT TYPE:
${exampleBlock}

THIS EMAIL'S ANGLE (sequence step): ${angle || "standalone / first touch"}
${subjectHint ? `SUBJECT LINE DIRECTION: ${subjectHint}` : ""}

PROSPECT FACTS:
${JSON.stringify(prospect, null, 2)}

AVAILABLE ASSETS (reference by exact label using {{asset:LABEL}}, only if relevant):
${assetBlock}`;
}

function fillAssetPlaceholders(body, assets) {
  const usedAssetIds = [];
  const filled = body.replace(/\{\{asset:([^}]+)\}\}/g, (match, label) => {
    const asset = assets.find(a => a.label.trim().toLowerCase() === label.trim().toLowerCase());
    if (!asset) return "";
    usedAssetIds.push(asset.id);
    return asset.kind === "link" ? asset.url : `(see attached: ${asset.file_name || asset.label})`;
  });
  return { filled, usedAssetIds };
}

// Full pipeline: brief -> draft pass -> critique/rewrite pass -> asset placeholders resolved.
// Returns the final subject/body plus which asset ids were actually referenced, so the
// caller can attach the right files and create tracked links only for links actually used.
async function generateEmail(userId, { contactId, clientTypeId, angle, subjectHint, extraContext }) {
  const { apiKey, model } = await openrouter.resolveCredentials(userId);
  if (!apiKey) throw new Error("No OpenRouter key available. Add one in Settings, or ask the operator to set a platform key.");

  const contactResult = await db.query(`SELECT * FROM contacts WHERE id = $1 AND user_id = $2`, [contactId, userId]);
  const contact = contactResult.rows[0];
  if (!contact) throw new Error("Contact not found.");

  const { clientType, examples } = await loadClientType(userId, clientTypeId);
  const assets = await selectAssets(userId, { clientTypeId, angle });

  const prospect = {
    name: contact.name,
    company: contact.company,
    email: contact.email,
    ...contact.custom_fields,
    ...(extraContext || {})
  };

  const brief = buildBriefBlock({ clientType, examples, prospect, angle, subjectHint, assets });

  const draftRaw = await openrouter.chat({
    apiKey, model,
    messages: [
      { role: "system", content: DRAFT_SYSTEM_PROMPT },
      { role: "user", content: brief }
    ]
  });
  const draft = safeParseJson(draftRaw);

  const critiqueRaw = await openrouter.chat({
    apiKey, model,
    messages: [
      { role: "system", content: CRITIQUE_SYSTEM_PROMPT },
      { role: "user", content: `BRIEF:\n${brief}\n\nDRAFT TO REVIEW:\n${JSON.stringify(draft)}` }
    ],
    temperature: 0.3
  });
  const final = safeParseJson(critiqueRaw);

  const { filled: finalBody, usedAssetIds } = fillAssetPlaceholders(final.body, assets);
  const { filled: draftBodyResolved } = fillAssetPlaceholders(draft.body, assets);

  return {
    subject: final.subject,
    body: finalBody,
    draftSubject: draft.subject,
    draftBody: draftBodyResolved,
    usedAssetIds,
    clientTypeId,
    contactId
  };
}

module.exports = { generateEmail, selectAssets, loadClientType, fillAssetPlaceholders };
