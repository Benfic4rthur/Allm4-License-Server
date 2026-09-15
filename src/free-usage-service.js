import { getPool } from "./db.js";
import { hashDeviceId, normalizeDeviceId } from "./security.js";

export const FREE_USAGE_QUOTAS = Object.freeze([5, 4, 3, 2, 1]);

function parseInteger(value, { min, max, name }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`Invalid ${name}`);
  }
  return parsed;
}

function allowedTotalForInstallations(installationCount) {
  return FREE_USAGE_QUOTAS
    .slice(0, Math.min(installationCount, FREE_USAGE_QUOTAS.length))
    .reduce((total, quota) => total + quota, 0);
}

function minimumUsedForInstallations(installationCount) {
  return allowedTotalForInstallations(Math.max(0, installationCount - 1));
}

export function getFreeUsageAllowance(installationCount, usedCount) {
  const installations = parseInteger(installationCount, {
    min: 1,
    max: 1000,
    name: "installation count",
  });
  const reportedUsed = parseInteger(usedCount, {
    min: 0,
    max: 1000000,
    name: "used count",
  });

  const allowedTotal = allowedTotalForInstallations(installations);
  const used = Math.max(
    reportedUsed,
    minimumUsedForInstallations(installations),
  );
  const remaining = Math.max(0, allowedTotal - used);

  return {
    installation_count: installations,
    used_count: used,
    allowed_total: allowedTotal,
    remaining,
    blocked: remaining === 0,
  };
}

export async function syncFreeUsage({
  deviceId,
  installationCount,
  usedCount,
}) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);
  if (!normalizedDeviceId) throw new TypeError("Invalid device id");

  const installations = parseInteger(installationCount, {
    min: 1,
    max: 1000,
    name: "installation count",
  });
  const reportedUsed = parseInteger(usedCount, {
    min: 0,
    max: 1000000,
    name: "used count",
  });
  const used = Math.max(
    reportedUsed,
    minimumUsedForInstallations(installations),
  );
  const deviceHash = hashDeviceId(normalizedDeviceId);

  const result = await getPool().query(
    `
      INSERT INTO free_usage_devices (
        device_hash,
        installation_count,
        used_count,
        first_seen_at,
        last_seen_at,
        updated_at
      )
      VALUES ($1, $2, $3, NOW(), NOW(), NOW())
      ON CONFLICT (device_hash)
      DO UPDATE SET
        installation_count = GREATEST(
          free_usage_devices.installation_count,
          EXCLUDED.installation_count
        ),
        used_count = GREATEST(
          free_usage_devices.used_count,
          EXCLUDED.used_count
        ),
        last_seen_at = NOW(),
        updated_at = NOW()
      RETURNING installation_count, used_count, last_seen_at
    `,
    [deviceHash, installations, used],
  );

  const row = result.rows[0];
  const allowance = getFreeUsageAllowance(
    Number(row.installation_count),
    Number(row.used_count),
  );

  return {
    ...allowance,
    synced_at: row.last_seen_at,
  };
}
