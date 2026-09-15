import pg from "pg";

const { Pool } = pg;

let pool;

function getDatabaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error("DATABASE_URL is not configured");
  }
  return value;
}

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl(),
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: { rejectUnauthorized: false },
    });
  }

  return pool;
}

export async function checkDatabaseConnection() {
  const result = await getPool().query("SELECT NOW() AS now");
  return result.rows[0]?.now ?? null;
}
