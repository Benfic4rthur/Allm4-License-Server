import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPool } from "../src/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.join(__dirname, "..", "db", "schema.sql");

async function main() {
  const sql = await fs.readFile(schemaPath, "utf8");
  const pool = getPool();

  try {
    await pool.query("BEGIN");
    await pool.query(sql);
    await pool.query("COMMIT");
    console.log("Database migration completed successfully");
  } catch (error) {
    await pool.query("ROLLBACK");
    console.error("Database migration failed", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
