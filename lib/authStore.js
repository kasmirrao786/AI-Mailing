const bcrypt = require("bcryptjs");
const db = require("./db");

async function createUser(email, password) {
  if (!email || !password) throw new Error("Email and password are required.");
  if (password.length < 8) throw new Error("Password must be at least 8 characters.");
  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = await db.query(`SELECT id FROM users WHERE email = $1`, [normalizedEmail]);
  if (existing.rows.length) throw new Error("An account with that email already exists.");
  const hash = await bcrypt.hash(password, 12);
  const result = await db.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email`,
    [normalizedEmail, hash]
  );
  return result.rows[0];
}

async function verifyUser(email, password) {
  if (!email || !password) return null;
  const normalizedEmail = String(email).trim().toLowerCase();
  const result = await db.query(`SELECT id, email, password_hash FROM users WHERE email = $1`, [normalizedEmail]);
  const user = result.rows[0];
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  return { id: user.id, email: user.email };
}

async function getUserById(id) {
  const result = await db.query(`SELECT id, email FROM users WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

module.exports = { createUser, verifyUser, getUserById };
