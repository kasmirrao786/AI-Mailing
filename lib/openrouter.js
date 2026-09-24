const fetch = require("node-fetch");
const db = require("./db");
const crypto = require("./crypto");

async function resolveCredentials(userId) {
  const result = await db.query(
    `SELECT openrouter_api_key_enc, openrouter_model FROM user_settings WHERE user_id = $1`,
    [userId]
  );
  const row = result.rows[0];
  if (row && row.openrouter_api_key_enc) {
    return {
      apiKey: crypto.decrypt(row.openrouter_api_key_enc),
      model: row.openrouter_model || process.env.PLATFORM_OPENROUTER_MODEL || "anthropic/claude-3.5-sonnet",
      usingOwnKey: true
    };
  }
  return {
    apiKey: process.env.PLATFORM_OPENROUTER_API_KEY || null,
    model: process.env.PLATFORM_OPENROUTER_MODEL || "anthropic/claude-3.5-sonnet",
    usingOwnKey: false
  };
}

async function chat({ apiKey, model, messages, temperature = 0.6, maxTokens = 700 }) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter error (${res.status}): ${text}`);
  }
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error("OpenRouter returned an empty response.");
  return content;
}

module.exports = { resolveCredentials, chat };
