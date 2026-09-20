import { getPool, withTransaction } from "./db.js";
import { hashDeviceId } from "./security.js";

export const FREE_USAGE_QUOTAS = Object.freeze([5, 4, 3, 2, 1]);

let storageReady = null;

export function allowedTotalForInstallations(installationCount) {
  const count = Math.max(0, Number(installationCount || 0));
  return FREE_USAGE_QUOTAS
    .slice(0, Math.min(count, FREE_USAGE_QUOTAS.length))
    .reduce((total, quota) => total + quota, 0);
}

export function minimumUsedForInstallations(installationCount) {
  return allowedTotalForInstallations(Math.max(0, Number(installationCount || 0) - 1));
}

function mapFreeUsage(row) {
  const installationCount = Math.max(1, Number(row.installation_count || 1));
  const usedCount = Math.max(
    0,
    Number(row.used_count || 0),
    minimumUsedForInstallations(installationCount),
  );
  const allowedTotal = allowedTotalForInstallations(installationCount);
  return {
    installation_count: installationCount,
    used_count: usedCount,
    allowed_total: allowedTotal,
    remaining: Math.max(0, allowedTotal - usedCount),
    blocked: usedCount >= allowedTotal,
    last_seen_at: row.last_seen_at ?? null,
  };
}

async function ensureFreeUsageStorage() {
  if (!storageReady) {
    storageReady = (async () => {
      const pool = getPool();
      await pool.query(
        `CREATE TABLE IF NOT EXISTS free_usage_devices (
          device_hash TEXT PRIMARY KEY,
          installation_count INTEGER NOT NULL DEFAULT 1 CHECK (installation_count >= 1),
          used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
          first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_free_usage_devices_last_seen
         ON free_usage_devices(last_seen_at DESC)`,
      );
    })().catch((error) => {
      storageReady = null;
      throw error;
    });
  }

  return storageReady;
}

export async function mergeFreeUsageState(
  client,
  { deviceId, installationCount, usedCount },
) {
  const deviceHash = hashDeviceId(deviceId);

  await client.query(
    `INSERT INTO free_usage_devices (
      device_hash,
      installation_count,
      used_count
    ) VALUES ($1, 1, 0)
    ON CONFLICT (device_hash) DO NOTHING`,
    [deviceHash],
  );

  const currentResult = await client.query(
    `SELECT device_hash, installation_count, used_count, first_seen_at, last_seen_at, updated_at
     FROM free_usage_devices
     WHERE device_hash = $1
     FOR UPDATE`,
    [deviceHash],
  );

  const current = currentResult.rows[0];
  if (!current) {
    throw new Error("free usage state unavailable after upsert");
  }

  const finalInstallationCount = Math.max(
    1,
    Number(current.installation_count || 1),
    installationCount,
  );
  const finalUsedCount = Math.max(
    0,
    Number(current.used_count || 0),
    usedCount,
    minimumUsedForInstallations(finalInstallationCount),
  );

  const updated = await client.query(
    `UPDATE free_usage_devices
     SET installation_count = $2,
         used_count = $3,
         last_seen_at = NOW(),
         updated_at = NOW()
     WHERE device_hash = $1
     RETURNING device_hash, installation_count, used_count, first_seen_at, last_seen_at, updated_at`,
    [deviceHash, finalInstallationCount, finalUsedCount],
  );

  return mapFreeUsage(updated.rows[0]);
}

export async function syncFreeUsage(input) {
  await ensureFreeUsageStorage();
  return withTransaction((client) => mergeFreeUsageState(client, input));
}
