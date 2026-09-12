const store = require("./store");
const clientProfiles = require("./clientProfiles");
const openrouter = require("./openrouter");
const { render, cleanupEmptyFields } = require("./template");
const { textToHtml, injectTracking } = require("./tracking");
const trackedLinks = require("./trackedLinks");

// Generates the text body only (no tracking baked in yet — that happens at
// send time once we have a tracking_id). Throws on failure.
//
// Client-type resolution: if the caller doesn't pass an explicit
// clientProfileId, and the user has defined any client-type profiles, the AI
// is asked to classify this prospect into the best-fitting one from their
// company/notes. Whatever links/format/extraInfo/collateral that profile
// defines are used instead of the account defaults for just this email; any
// field a profile leaves blank still falls back to the account default.
// Classification is best-effort — if it fails or nothing matches, generation
// proceeds on the account default pitch exactly as before profiles existed.
async function generateForProspect(userId, {
  company, contactName, notes, collateralId, collateralIds, settings, collateral,
  stepInstructions, subjectOverride, clientProfileId, profiles, providedBody
}) {
  const s = settings || (await store.load(userId));
  const allProfiles = profiles || (await clientProfiles.list(userId));

  let profile = null;
  if (clientProfileId) {
    profile = allProfiles.find(p => p.id === clientProfileId) || null;
  } else if (allProfiles.length) {
    try {
      const matchedId = await openrouter.classifyClientProfile(userId, { company, notes }, allProfiles);
      profile = matchedId ? allProfiles.find(p => p.id === matchedId) || null : null;
    } catch (e) {
      profile = null; // classification is best-effort — fall back to the account default
    }
  }

  const links = ((profile && profile.links) || []).map(l => ({ ...l, preferred: true }));
  const defaultLinks = (s.links || [])
    .filter(l => !links.some(pl => pl.url === l.url))
    .map(l => ({ ...l, preferred: false }));
  const allLinks = [...links, ...defaultLinks];

  const subjectTemplate = subjectOverride || (profile && profile.subjectTemplate) || s.subjectTemplate;

  // Multiple collateral docs can ground/attach to one email now, not just
  // one. Explicit ids from the caller win; otherwise the matched client
  // type's own set; otherwise the account default set (store.js falls back
  // further to "first uploaded doc" if even that's empty). This resolution
  // runs the same way whether the body is AI-written or provided — a
  // pre-written row still gets the right attachments.
  const explicitIds = (collateralIds && collateralIds.length) ? collateralIds : (collateralId ? [collateralId] : undefined);
  const profileCollateralIds = (profile && profile.defaultCollateralIds && profile.defaultCollateralIds.length)
    ? profile.defaultCollateralIds
    : undefined;
  const effectiveCollateralIds = explicitIds || profileCollateralIds;

  const availableLinks = allLinks.filter(l => l.label && l.url);
  const linksBlock = availableLinks.map(l => `${l.label}: ${l.url}`).join("\n");

  const vars = {
    company: company || "your company",
    contactName: contactName || "",
    name: s.name || "",
    companyName: s.companyName || "",
    phone: s.phone || "",
    links: linksBlock // kept for backward-compat with custom formats that still use {{links}}
  };

  // A pre-written body (e.g. from a CSV "body" column) skips the AI
  // entirely — no generation call, no collateral text grounding needed —
  // but still gets the same token substitution, signature, subject
  // templating, and collateral/link resolution as any other row, so a
  // batch can freely mix generated and pre-written rows.
  if (providedBody && providedBody.trim()) {
    const resolvedCollateralList = collateral !== undefined ? collateral : await store.getCollateralTexts(userId, effectiveCollateralIds);
    const textBody = appendSignature(cleanupEmptyFields(render(providedBody, vars)).trimEnd(), s, vars);
    const subject = render(subjectTemplate, vars);
    return {
      subject,
      textBody,
      clientProfile: profile ? { id: profile.id, label: profile.label } : null,
      collateralIds: resolvedCollateralList.map(c => c.id).filter(Boolean),
      wasGenerated: false
    };
  }

  const format = (profile && profile.emailFormat) || s.emailFormat;
  const extraInfo = (profile && profile.extraInfo) || s.extraInfo;
  const resolvedCollateralList = collateral !== undefined ? collateral : await store.getCollateralTexts(userId, effectiveCollateralIds);

  // Multiple docs' text get concatenated with a labeled header each, so the
  // model can tell which fact came from which doc rather than blending them
  // into one undifferentiated block.
  const collateralText = resolvedCollateralList
    .filter(c => c && c.text)
    .map(c => `--- ${c.label} ---\n${c.text}`)
    .join("\n\n");

  const rawBody = await openrouter.generateEmail(userId, {
    company,
    contactName,
    notes,
    format,
    collateralText,
    extraInfo,
    stepInstructions,
    availableLinks
  });

  const textBody = appendSignature(cleanupEmptyFields(render(rawBody, vars)).trimEnd(), s, vars);
  const subject = render(subjectTemplate, vars);

  return {
    subject,
    textBody,
    clientProfile: profile ? { id: profile.id, label: profile.label } : null,
    collateralIds: resolvedCollateralList.map(c => c.id).filter(Boolean),
    wasGenerated: true
  };
}

// The signature is never left up to the AI or to whatever the format field
// happens to say — it's appended here in code every time. Uses your custom
// Signature field from Settings if you've set one (with {{name}}
// {{companyName}} {{phone}} tokens filled in), otherwise auto-builds one
// line per non-empty field. This is what stayed broken before: the old
// approach relied on the AI reliably including a literal {{name}} block
// because the prompt told it to, which fell apart the moment the format
// field was edited, cleared, or a weaker model stopped following it.
function appendSignature(textBody, s, vars) {
  const signature = (s.signature && s.signature.trim())
    ? render(s.signature.trim(), vars)
    : [s.name, s.companyName, s.phone].filter(v => v && String(v).trim()).join("\n");
  if (!signature) return textBody;
  // Guards against a stale custom format that still explicitly instructs the
  // AI to write out {{name}}/{{companyName}}/{{phone}} itself — don't double
  // up the signature in that case.
  if (textBody.endsWith(signature)) return textBody;
  return `${textBody}\n\n${signature}`;
}

// Wraps a generated text body into the final HTML + tracked version, ready
// to hand to the mailer. Called at send time once a tracking_id exists.
// Async because each distinct link gets persisted (lib/trackedLinks.js) so
// the sent link is just an opaque id, never the real destination URL.
async function buildTrackedVersion(textBody, { trackingId, baseUrl, trackOpens, trackClicks }) {
  const html = textToHtml(textBody);
  const htmlBody = await injectTracking(html, {
    trackingId,
    baseUrl,
    trackOpens,
    trackClicks,
    onClickLink: url => trackedLinks.save(trackingId, url)
  });
  return htmlBody;
}

module.exports = { generateForProspect, buildTrackedVersion };
