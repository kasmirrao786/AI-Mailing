const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on("error", err => {
  console.error("Unexpected Postgres pool error:", err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
