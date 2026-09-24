const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
require("dotenv").config();

async function runMigrations(pool) {
  const p = pool || new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await p.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;"); // for gen_random_uuid()
  await p.query(sql);
  if (!pool) await p.end();
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log("Migrations applied.");
      process.exit(0);
    })
    .catch(err => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

module.exports = { runMigrations };
