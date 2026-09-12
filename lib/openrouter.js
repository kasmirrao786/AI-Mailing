const fetch = require("node-fetch");
const store = require("./store");
const usage = require("./usage");

async function resolveCredentials(userId) {
  const s = await store.load(userId);

  const usingOwnKey = !!s.openrouterApiKey;
  const apiKey = s.openrouterApiKey || process.env.PLATFORM_OPENROUTER_API_KEY;
  const model =
    s.openrouterModel ||
    process.env.PLATFORM_OPENROUTER_MODEL ||
    "anthropic/claude-3.5-sonnet";

  return { apiKey, model, usingOwnKey };
}

async function callOpenRouter({ apiKey, model, prompt, maxTokens, temperature }) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter error (${res.status}): ${text}`);
  }

  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error("OpenRouter returned no content.");
  return content.trim();
}

function requireKey(apiKey) {
  if (!apiKey) {
    throw new Error(
      "No OpenRouter key available. The platform's shared key isn't configured — add your own in Settings, or the site operator needs to set PLATFORM_OPENROUTER_API_KEY."
    );
  }
}

async function reserveSharedKeySlot(userId, usingOwnKey) {
  if (usingOwnKey) return null;
  const result = await usage.reserve(userId);
  if (!result.allowed) {
    throw new Error(
      `You've hit today's limit (${result.limit}) for the free shared AI key. Add your own OpenRouter key in Settings for unlimited use, or try again tomorrow.`
    );
  }
  return userId;
}

// Writes the FULL outreach email body, following the user's own format
// instructions, grounded in their company/service info and optional
// collateral doc. The format is expected to use exact tokens for factual
// data — {{name}} {{companyName}} {{phone}} {{company}} {{contactName}} —
// which the caller fills in afterward with template.render(), so contact
// info is never hallucinated. Links from availableLinks are handed to the
// model as options, not requirements — it's told to weave at most one or two
// in as inline markdown links ([text](url)) only where they genuinely fit,
// rather than dumping a raw URL or a "Links:" list into the body.
async function generateEmail(userId, { company, contactName, notes, format, collateralText, extraInfo, stepInstructions, availableLinks }) {
  const { apiKey, model, usingOwnKey } = await resolveCredentials(userId);
  requireKey(apiKey);
  const reservedFor = await reserveSharedKeySlot(userId, usingOwnKey);

  const collateralSection = collateralText
    ? `\n\nOur company's collateral (one-pagers, brochures, case studies — possibly more than one
doc, each marked with its own "--- label ---" header below; use specific, real details from
this, do not invent products, features, pricing, or claims that don't appear here):\n"""\n${collateralText}\n"""`
    : "";

  const extraSection = extraInfo
    ? `\n\nAdditional context about what we offer, not in the brochure (positioning, pricing
notes, proof points, target customer profile, etc. — treat this as true and use it where
relevant):\n"""\n${extraInfo}\n"""`
    : "";

  const notesSection = notes
    ? `\n\nWhat we know about this specific prospect (use this to personalize — reference
something concrete from here, don't just restate their company name):\n"""\n${notes}\n"""`
    : "\n\n(No specific notes about this prospect — personalize based on their company name alone, and keep the opening line brief rather than inventing details about them.)";

  const stepSection = stepInstructions
    ? `\n\nThis is one step in a multi-email follow-up sequence to the same prospect. This
specific email's angle: "${stepInstructions}". Write ONLY this step's email — don't
reintroduce yourself as if this were the first contact unless the angle above says it is,
and don't repeat the exact same pitch verbatim as a first email would.`
    : "";

  const linksSection = availableLinks && availableLinks.length
    ? `\n\nLinks available to reference (use at most one or two of the MOST relevant ones — never
all of them, and never one that doesn't genuinely fit this specific email):\n` +
      availableLinks.map(l => `- ${l.label}: ${l.url}${l.preferred ? " [this prospect's specific client type — prefer this one over the general links below if it fits at all]" : " [general default link]"}`).join("\n") +
      `\nIf a link marked "this prospect's specific client type" is genuinely usable, use that one
instead of a general link — it was chosen deliberately for this kind of prospect. Use a
general link only if no client-type-specific link fits, or none were given. If you use a
link, weave it naturally into a sentence as an inline markdown link — e.g. "you can see it in
[a short demo](URL)" or "[book a call](URL) this week" — never paste a bare URL, never write
a separate "Links:" line or list, and don't force one in if none genuinely fits.
Never state a specific duration, time commitment, or other detail about a link unless it is
explicitly given in that link's label above — do not guess, assume, or reuse a number from
an example elsewhere in these instructions.`
    : "";

  const prompt = `${format}
${collateralSection}${extraSection}${notesSection}${stepSection}${linksSection}

---
Prospect company: ${company || "(not given)"}
Prospect contact name: ${contactName || "(not given)"}
---

Formatting rules — follow these no matter what the format above says, and no matter how
little or how much guidance the format above gives you:
- Put a blank line (an empty line — two newline characters) between the opening line, each
  separate body paragraph, and the closing line. Never run these together into one solid
  paragraph.
- Keep each paragraph short — 2-3 sentences at most.
- Plain text only: no markdown, no bullet points, no asterisks, no headers, no bold/italic
  markers of any kind — the ONE exception is a link from the list above, which must be
  written as [anchor text](URL), never as a bare URL and never in its own list.
- Do NOT write a sign-off, closing name, company name, phone number, or any kind of
  signature block of your own, even if the format above doesn't mention this. The app
  always appends the real signature automatically right after your text — end your email
  right after the closing line, with nothing else following it.

Write only the email body described above, following the format, instructions, and
formatting rules exactly. Do not include a subject line. Do not add any commentary, notes,
or markdown before or after the email — output the email text only.`;

  try {
    return await callOpenRouter({ apiKey, model, prompt, maxTokens: 600, temperature: 0.65 });
  } catch (e) {
    if (reservedFor) await usage.release(reservedFor);
    throw e;
  }
}

// Picks which client-type profile best fits a prospect, from the user's own
// list (company + notes vs. each profile's label/description). Best-effort:
// no profiles, no key, a bad response, or any API error all just mean "fall
// back to the account's default pitch" rather than blocking generation — this
// is a cheap, low-stakes classification step, not the main event, so it never
// reserves a shared-key usage slot the way an actual email generation does.
async function classifyClientProfile(userId, { company, notes }, profiles) {
  if (!profiles || !profiles.length) return null;
  const { apiKey, model } = await resolveCredentials(userId);
  if (!apiKey) return null;

  const optionsList = profiles
    .map(p => `- id: "${p.id}" — label: "${p.label}"${p.description ? ` — description: "${p.description}"` : ""}`)
    .join("\n");

  const prompt = `We send outreach emails to different kinds of prospects. Each "client type" below
has its own pitch, links, and format. Given the prospect info, pick the id of the SINGLE
best-matching client type.

Client types:
${optionsList}

Prospect company: ${company || "(not given)"}
Notes about this prospect: ${notes || "(none)"}

Respond with ONLY the matching id exactly as written above, nothing else. If nothing is a
clear match, respond with exactly: none`;

  try {
    const raw = await callOpenRouter({ apiKey, model, prompt, maxTokens: 20, temperature: 0 });
    const cleaned = raw.trim().replace(/^["'`]|["'`]$/g, "");
    const match = profiles.find(p => p.id === cleaned);
    return match ? match.id : null;
  } catch (e) {
    return null;
  }
}

// Pulls {company, contactName, notes} out of arbitrary pasted text (e.g. a
// LinkedIn profile blurb, a company description, a note about a lead).
async function extractProspectInfo(userId, pastedText) {
  const { apiKey, model, usingOwnKey } = await resolveCredentials(userId);
  requireKey(apiKey);
  const reservedFor = await reserveSharedKeySlot(userId, usingOwnKey);

  const prompt = `Extract prospect/lead details from the text below.

Respond with ONLY valid JSON, no markdown code fences, no extra commentary, in exactly this shape:
{"company": "", "contactName": "", "notes": ""}

Rules:
- "company": the prospect's company name if identifiable, else "".
- "contactName": the contact person's name if identifiable, else "".
- "notes": anything useful for personalizing an outreach email to them — what they do,
  recent news, pain points, context — cleaned up, else "".

Text:
"""
${pastedText}
"""`;

  try {
    const raw = await callOpenRouter({ apiKey, model, prompt, maxTokens: 500, temperature: 0.2 });
    const cleaned = raw.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      company: parsed.company || "",
      contactName: parsed.contactName || "",
      notes: parsed.notes || ""
    };
  } catch (e) {
    if (reservedFor) await usage.release(reservedFor);
    throw e;
  }
}

module.exports = { generateEmail, extractProspectInfo, classifyClientProfile, resolveCredentials };
