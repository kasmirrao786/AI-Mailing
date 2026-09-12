// A minimal 1x1 transparent PNG, served at the open-tracking endpoint.
const TRACKING_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const URL_REGEX = /\bhttps?:\/\/[^\s<>"')]+/g;
const TRAILING_PUNCT_REGEX = /[.,;:!?)\]}]+$/;

// Matches the AI-generated inline hyperlink syntax: [anchor text](https://...).
// Used both to build a real <a> tag (HTML) and a readable "text (url)" fallback
// (plain text), so a link like "[a quick demo](https://x.com/demo)" never shows
// up as raw markdown or as a blank/bare URL in either version of the email.
const MD_LINK_REGEX = /\[([^\[\]]{1,120})\]\((https?:\/\/[^\s)]+)\)/g;

function linkify(text) {
  return text.replace(URL_REGEX, rawUrl => {
    const trailingMatch = rawUrl.match(TRAILING_PUNCT_REGEX);
    const trailing = trailingMatch ? trailingMatch[0] : "";
    const url = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl;
    return `<a href="${url}">${url}</a>${trailing}`;
  });
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Pulls every [label](url) out of already-HTML-escaped text and swaps it for a
// null-byte placeholder token, returning the built <a> tags separately. This
// has to happen *before* the bare-URL linkifier runs, or the URL sitting
// inside href="..." would get matched and wrapped a second time, corrupting
// the markup. Placeholder tokens contain no "http" substring, so they're safe
// to pass through linkify() untouched.
function extractMarkdownLinks(escapedText) {
  const anchors = [];
  const withPlaceholders = escapedText.replace(MD_LINK_REGEX, (match, label, url) => {
    const token = `\u0000LINK${anchors.length}\u0000`;
    anchors.push(`<a href="${url}" style="color:#2563eb;text-decoration:underline;">${label}</a>`);
    return token;
  });
  return { withPlaceholders, anchors };
}

function restoreAnchors(text, anchors) {
  return text.replace(/\u0000LINK(\d+)\u0000/g, (match, i) => anchors[parseInt(i, 10)]);
}

// Turns plain-text email body (with \n paragraph breaks) into simple HTML:
// each blank-line-separated block becomes a <p>, single newlines within a
// block become <br>. Bare URLs become real links, and [label](url) markdown
// links become real, readably-labeled links instead of raw URL text.
function textToHtml(text) {
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const htmlBlocks = blocks.map(block => {
    const escaped = escapeHtml(block).replace(/\n/g, "<br>");
    const { withPlaceholders, anchors } = extractMarkdownLinks(escaped);
    const linked = linkify(withPlaceholders);
    const restored = restoreAnchors(linked, anchors);
    return `<p style="margin:0 0 16px;">${restored}</p>`;
  });
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5;">${htmlBlocks.join("\n")}</div>`;
}

// Companion to textToHtml for the plain-text alternative part of the email:
// "[a quick demo](https://x.com/demo)" becomes "a quick demo (https://x.com/demo)"
// instead of showing the raw markdown syntax to clients that render text/plain.
function markdownLinksToPlainText(text) {
  return String(text || "").replace(MD_LINK_REGEX, (match, label, url) => `${label} (${url})`);
}

// Rewrites every <a href="..."> to route through the click-tracking
// redirect, and appends an invisible open-tracking pixel at the end.
// onClickLink(url) is called once per distinct link and must resolve to the
// opaque id that will resolve back to that url at click time (see
// lib/trackedLinks.js) — the real destination is never put in the link
// itself, only the opaque id, so the link can't be flagged by recipient
// mail providers as the "URL embedded in a URL" open-redirect shape that
// spam/phishing scanners commonly block.
async function injectTracking(html, { trackingId, baseUrl, trackOpens, trackClicks, onClickLink }) {
  let result = html;

  if (trackClicks) {
    const hrefRegex = /href="([^"]+)"/g;
    const urls = [...new Set([...result.matchAll(hrefRegex)].map(m => m[1]).filter(url => /^https?:\/\//i.test(url)))];
    const idByUrl = new Map();
    for (const url of urls) {
      idByUrl.set(url, await onClickLink(url));
    }
    result = result.replace(hrefRegex, (match, url) => {
      if (!idByUrl.has(url)) return match; // leave mailto:, anchors, etc. alone
      return `href="${baseUrl}/t/click/${idByUrl.get(url)}"`;
    });
  }

  if (trackOpens) {
    const pixel = `<img src="${baseUrl}/t/open/${trackingId}.png" width="1" height="1" alt="" style="display:none;border:0;" />`;
    result += `\n${pixel}`;
  }

  return result;
}

module.exports = { TRACKING_PIXEL_PNG, textToHtml, injectTracking, markdownLinksToPlainText };
