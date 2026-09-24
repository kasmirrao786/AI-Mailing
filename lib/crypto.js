// Symmetric encryption for mailbox credentials at rest (AES-256-GCM).
// Requires CREDENTIAL_ENCRYPTION_KEY: a 32-byte key, base64-encoded, in the environment.
// Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
const crypto = require("crypto");

function getKey() {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with: " +
      `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return key;
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

function decrypt(payload) {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

module.exports = { encrypt, decrypt };
