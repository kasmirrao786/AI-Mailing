// Tracking. Two signals: an open pixel (best-effort — many clients block remote images,
// this is industry-standard "signal, not proof") and click tracking on every link in the
// email body, rewritten to redirect through this server first.
//
// Booking/demo links are tagged in `tracked_links.asset_id` so analytics can filter to
// "clicked the booking link" specifically — a much stronger signal than a generic click.
// Note this only proves the link was clicked, not that a meeting was actually booked;
// a real "booked" event needs a webhook from the booking tool itself (e.g. Cal.com),
// which is a follow-on piece, not something to fake from a click alone.
const db = require("./db");

const URL_REGEX = /https?:\/\/[^\s<>"')]+/g;

// A 1x1 transparent PNG, served as the open-tracking pixel.
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function publicUrl() {
  const base = process.env.PUBLIC_URL;
  return base ? base.replace(/\/+$/, "") : null;
}

// Rewrites every http(s) link in text/html to a tracked redirect URL, and appends an
// open pixel to the html version. If PUBLIC_URL isn't configured (e.g. local dev),
// this is a no-op — better to send working links than broken tracking ones.
async function prepareTrackedContent(userId, messageId, trackingId, { text, html }) {
  const base = publicUrl();
  if (!base) return { text, html };

  const urlToLinkId = new Map();

  async function trackedUrlFor(originalUrl) {
    if (urlToLinkId.has(originalUrl)) return urlToLinkId.get(originalUrl);
    const assetResult = await db.query(`SELECT id FROM assets WHERE user_id = $1 AND url = $2 LIMIT 1`, [userId, originalUrl]);
    const assetId = assetResult.rows[0] ? assetResult.rows[0].id : null;
    const result = await db.query(
      `INSERT INTO tracked_links (message_id, target_url, asset_id) VALUES ($1,$2,$3) RETURNING id`,
      [messageId, originalUrl, assetId]
    );
    const linkId = result.rows[0].id;
    urlToLinkId.set(originalUrl, linkId);
    return linkId;
  }

  async function rewrite(content) {
    if (!content) return content;
    const urls = [...new Set(content.match(URL_REGEX) || [])];
    let result = content;
    for (const url of urls) {
      const linkId = await trackedUrlFor(url);
      result = result.split(url).join(`${base}/t/c/${linkId}`);
    }
    return result;
  }

  const trackedText = await rewrite(text);
  let trackedHtml = await rewrite(html);
  const pixel = `<img src="${base}/t/o/${trackingId}" width="1" height="1" style="display:none" alt="" />`;
  trackedHtml = trackedHtml ? `${trackedHtml}${pixel}` : pixel;

  return { text: trackedText, html: trackedHtml };
}

async function recordOpen(trackingId) {
  const msgResult = await db.query(`SELECT * FROM messages WHERE tracking_id = $1`, [trackingId]);
  const message = msgResult.rows[0];
  if (!message) return;
  await db.query(
    `INSERT INTO events (user_id, message_id, contact_id, campaign_id, enrollment_id, type)
     VALUES ($1,$2,$3,$4,$5,'opened')`,
    [message.user_id, message.id, message.contact_id, message.campaign_id, message.enrollment_id]
  );
}

// Returns the original target URL to redirect to, after logging the click (and, for
// booking/demo assets, tagging the event so it's filterable in analytics).
async function recordClickAndGetTarget(linkId) {
  const linkResult = await db.query(
    `SELECT tl.*, m.user_id, m.contact_id, m.campaign_id, m.enrollment_id, a.category AS asset_category
     FROM tracked_links tl
     JOIN messages m ON m.id = tl.message_id
     LEFT JOIN assets a ON a.id = tl.asset_id
     WHERE tl.id = $1`,
    [linkId]
  );
  const link = linkResult.rows[0];
  if (!link) return null;

  await db.query(
    `INSERT INTO events (user_id, message_id, contact_id, campaign_id, enrollment_id, type, url, meta)
     VALUES ($1,$2,$3,$4,$5,'clicked',$6,$7)`,
    [link.user_id, link.message_id, link.contact_id, link.campaign_id, link.enrollment_id, link.target_url,
      JSON.stringify({ assetCategory: link.asset_category || null })]
  );
  return link.target_url;
}

module.exports = { prepareTrackedContent, recordOpen, recordClickAndGetTarget, TRANSPARENT_PNG };
