import { getPool, withTransaction } from "./db.js";
import {
  generateLicenseKey,
  hashDeviceId,
  hashLicenseKey,
  hashRequestIp,
} from "./security.js";
import { verifyManagementToken } from "./license-token.js";

export class LicenseServiceError extends Error {
  constructor(code, status, details = undefined) {
    super(code);
    this.name = "LicenseServiceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function mapLicense(row) {
  return {
    id: row.id,
    status: row.status,
    max_devices: row.max_devices,
    issued_at: row.issued_at,
    revoked_at: row.revoked_at ?? null,
    revoke_reason: row.revoke_reason ?? null,
  };
}

function mapDevice(row) {
  return {
    id: row.id,
    device_name: row.device_name ?? null,
    platform: row.platform ?? null,
    first_activated_at: row.first_activated_at,
    last_seen_at: row.last_seen_at,
    blocked_at: row.blocked_at ?? null,
    deactivated_at: row.deactivated_at ?? null,
  };
}

async function recordActivation(
  client,
  {
    licenseId = null,
    deviceId = null,
    eventType,
    ipHash = null,
    metadata = {},
  },
) {
  await client.query(
    `INSERT INTO activations (
      license_id,
      device_id,
      event_type,
      ip_hash,
      metadata
    ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [licenseId, deviceId, eventType, ipHash, JSON.stringify(metadata)],
  );
}

async function countActiveDevices(client, licenseId) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM devices
     WHERE license_id = $1
       AND deactivated_at IS NULL
       AND blocked_at IS NULL`,
    [licenseId],
  );

  return result.rows[0]?.count ?? 0;
}

let managementSchemaReady = null;

async function ensureDeviceManagementSchema() {
  if (!managementSchemaReady) {
    managementSchemaReady = withTransaction(async (client) => {
      await client.query(
        `ALTER TABLE licenses
         ADD COLUMN IF NOT EXISTS primary_device_id UUID`,
      );
      await client.query(
        `ALTER TABLE devices
         ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ`,
      );
      await client.query(
        `DO $allm4$
         BEGIN
           ALTER TABLE licenses
             ADD CONSTRAINT licenses_primary_device_fk
             FOREIGN KEY (primary_device_id) REFERENCES devices(id) ON DELETE SET NULL;
         EXCEPTION
           WHEN duplicate_object THEN NULL;
         END $allm4$;`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS license_schema_migrations (
           key TEXT PRIMARY KEY,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      );
      await client.query(
        `WITH migration AS (
           INSERT INTO license_schema_migrations (key)
           VALUES ('primary-device-purchase-origin-v2')
           ON CONFLICT (key) DO NOTHING
           RETURNING key
         )
         UPDATE licenses AS l
         SET primary_device_id = COALESCE(
           (
             SELECT a.device_id
             FROM activations AS a
             JOIN devices AS d
               ON d.id = a.device_id
              AND d.license_id = l.id
             WHERE a.license_id = l.id
               AND a.event_type = 'activated'
               AND a.device_id IS NOT NULL
             ORDER BY a.created_at ASC
             LIMIT 1
           ),
           (
             SELECT d.id
             FROM devices AS d
             WHERE d.license_id = l.id
             ORDER BY d.first_activated_at ASC, d.id ASC
             LIMIT 1
           )
         )
         WHERE l.purchase_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM migration)
           AND EXISTS (
             SELECT 1
             FROM devices AS d
             WHERE d.license_id = l.id
           )`,
      );
      await client.query(
        `UPDATE licenses AS l
         SET primary_device_id = (
           SELECT d.id
           FROM devices AS d
           WHERE d.license_id = l.id
           ORDER BY
             CASE WHEN d.deactivated_at IS NULL THEN 0 ELSE 1 END,
             d.last_seen_at DESC,
             d.first_activated_at DESC,
             d.id DESC
           LIMIT 1
         )
         WHERE l.primary_device_id IS NULL
           AND EXISTS (
             SELECT 1
             FROM devices AS d
             WHERE d.license_id = l.id
           )`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_devices_available_active
         ON devices(license_id)
         WHERE deactivated_at IS NULL AND blocked_at IS NULL`,
      );
    }).catch((error) => {
      managementSchemaReady = null;
      throw error;
    });
  }

  return managementSchemaReady;
}

async function claimPrimaryDevice(client, license, deviceId) {
  if (license.primary_device_id) {
    return license.primary_device_id;
  }

  const claimed = await client.query(
    `UPDATE licenses
     SET primary_device_id = $2
     WHERE id = $1
       AND primary_device_id IS NULL
     RETURNING primary_device_id`,
    [license.id, deviceId],
  );

  const primaryDeviceId = claimed.rows[0]?.primary_device_id ?? deviceId;
  license.primary_device_id = primaryDeviceId;
  return primaryDeviceId;
}

async function businessFailure(
  client,
  {
    code,
    status,
    licenseId = null,
    deviceId = null,
    eventType = "rejected",
    ipHash = null,
    metadata = {},
    details = undefined,
  },
) {
  await recordActivation(client, {
    licenseId,
    deviceId,
    eventType,
    ipHash,
    metadata,
  });

  return {
    ok: false,
    error: new LicenseServiceError(code, status, details),
  };
}

function unwrap(result) {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

export async function issueLicense({ purchaseId = null, maxDevices = 3 } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const licenseKey = generateLicenseKey();
    const licenseKeyHash = hashLicenseKey(licenseKey);

    try {
      const result = await getPool().query(
        `INSERT INTO licenses (purchase_id, license_key_hash, max_devices)
         VALUES ($1, $2, $3)
         RETURNING id, status, max_devices, issued_at, revoked_at, revoke_reason`,
        [purchaseId, licenseKeyHash, maxDevices],
      );

      return {
        license_key: licenseKey,
        license: mapLicense(result.rows[0]),
      };
    } catch (error) {
      if (error?.code === "23505" && attempt < 2) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("Unable to generate a unique license key");
}

export async function activateLicense({
  licenseKey,
  deviceId,
  deviceName = null,
  platform = null,
  requestIp = null,
}) {
  await ensureDeviceManagementSchema();
  const licenseHash = hashLicenseKey(licenseKey);
  const deviceHash = hashDeviceId(deviceId);
  const ipHash = hashRequestIp(requestIp);

  const result = await withTransaction(async (client) => {
    const licenseResult = await client.query(
      `SELECT id, status, max_devices, primary_device_id, issued_at, revoked_at, revoke_reason
       FROM licenses
       WHERE license_key_hash = $1
       FOR UPDATE`,
      [licenseHash],
    );

    const license = licenseResult.rows[0];
    if (!license) {
      return businessFailure(client, {
        code: "license_not_found",
        status: 404,
        ipHash,
        metadata: { action: "activate", reason: "license_not_found" },
      });
    }

    if (license.status !== "active") {
      return businessFailure(client, {
        code: "license_revoked",
        status: 403,
        licenseId: license.id,
        eventType: "revoked",
        ipHash,
        metadata: { action: "activate", reason: "license_revoked" },
      });
    }

    const deviceResult = await client.query(
      `SELECT id, device_name, platform, first_activated_at, last_seen_at, blocked_at, deactivated_at
       FROM devices
       WHERE license_id = $1
         AND device_hash = $2
       FOR UPDATE`,
      [license.id, deviceHash],
    );

    let device = deviceResult.rows[0];
    let activationState = "activated";

    if (device?.blocked_at) {
      return businessFailure(client, {
        code: "device_removed_by_primary",
        status: 403,
        licenseId: license.id,
        deviceId: device.id,
        ipHash,
        metadata: { action: "activate", reason: "device_removed_by_primary" },
      });
    }

    if (device && !device.deactivated_at) {
      const updated = await client.query(
        `UPDATE devices
         SET last_seen_at = NOW(),
             device_name = COALESCE($3, device_name),
             platform = COALESCE($4, platform)
         WHERE license_id = $1
           AND device_hash = $2
         RETURNING id, device_name, platform, first_activated_at, last_seen_at, blocked_at, deactivated_at`,
        [license.id, deviceHash, deviceName, platform],
      );

      device = updated.rows[0];
      activationState = "already_active";

      await recordActivation(client, {
        licenseId: license.id,
        deviceId: device.id,
        eventType: "validated",
        ipHash,
        metadata: { action: "activate", state: activationState },
      });
    } else {
      const activeDevices = await countActiveDevices(client, license.id);
      if (activeDevices >= license.max_devices) {
        return businessFailure(client, {
          code: "device_limit_reached",
          status: 409,
          licenseId: license.id,
          deviceId: device?.id ?? null,
          ipHash,
          metadata: {
            action: "activate",
            reason: "device_limit_reached",
            active_devices: activeDevices,
            max_devices: license.max_devices,
          },
          details: {
            active_devices: activeDevices,
            max_devices: license.max_devices,
          },
        });
      }

      if (device) {
        const reactivated = await client.query(
          `UPDATE devices
           SET deactivated_at = NULL,
               last_seen_at = NOW(),
               device_name = COALESCE($3, device_name),
               platform = COALESCE($4, platform)
           WHERE license_id = $1
             AND device_hash = $2
           RETURNING id, device_name, platform, first_activated_at, last_seen_at, blocked_at, deactivated_at`,
          [license.id, deviceHash, deviceName, platform],
        );
        device = reactivated.rows[0];
        activationState = "reactivated";
      } else {
        const inserted = await client.query(
          `INSERT INTO devices (license_id, device_hash, device_name, platform)
           VALUES ($1, $2, $3, $4)
           RETURNING id, device_name, platform, first_activated_at, last_seen_at, blocked_at, deactivated_at`,
          [license.id, deviceHash, deviceName, platform],
        );
        device = inserted.rows[0];
      }

      await recordActivation(client, {
        licenseId: license.id,
        deviceId: device.id,
        eventType: "activated",
        ipHash,
        metadata: { action: "activate", state: activationState },
      });
    }

    const primaryDeviceId = await claimPrimaryDevice(client, license, device.id);

    return {
      ok: true,
      value: {
        license: mapLicense(license),
        device: mapDevice(device),
        activation_state: activationState,
        is_primary_device: primaryDeviceId === device.id,
      },
    };
  });

  return unwrap(result);
}

export async function validateLicense({
  licenseKey,
  deviceId,
  deviceName = null,
  platform = null,
  requestIp = null,
}) {
  await ensureDeviceManagementSchema();
  const licenseHash = hashLicenseKey(licenseKey);
  const deviceHash = hashDeviceId(deviceId);
  const ipHash = hashRequestIp(requestIp);

  const result = await withTransaction(async (client) => {
    const licenseResult = await client.query(
      `SELECT id, status, max_devices, primary_device_id, issued_at, revoked_at, revoke_reason
       FROM licenses
       WHERE license_key_hash = $1
       FOR SHARE`,
      [licenseHash],
    );

    const license = licenseResult.rows[0];
    if (!license) {
      return businessFailure(client, {
        code: "license_not_found",
        status: 404,
        ipHash,
        metadata: { action: "validate", reason: "license_not_found" },
      });
    }

    if (license.status !== "active") {
      return businessFailure(client, {
        code: "license_revoked",
        status: 403,
        licenseId: license.id,
        eventType: "revoked",
        ipHash,
        metadata: { action: "validate", reason: "license_revoked" },
      });
    }

    const deviceResult = await client.query(
      `SELECT id, device_name, platform, first_activated_at, last_seen_at, blocked_at, deactivated_at
       FROM devices
       WHERE license_id = $1
         AND device_hash = $2
       FOR UPDATE`,
      [license.id, deviceHash],
    );

    const device = deviceResult.rows[0];
    if (device?.blocked_at) {
      return businessFailure(client, {
        code: "device_removed_by_primary",
        status: 403,
        licenseId: license.id,
        deviceId: device.id,
        ipHash,
        metadata: { action: "validate", reason: "device_removed_by_primary" },
      });
    }

    if (!device || device.deactivated_at) {
      return businessFailure(client, {
        code: "device_not_active",
        status: 403,
        licenseId: license.id,
        deviceId: device?.id ?? null,
        ipHash,
        metadata: { action: "validate", reason: "device_not_active" },
      });
    }

    const updated = await client.query(
      `UPDATE devices
       SET last_seen_at = NOW(),
           device_name = COALESCE($3, device_name),
           platform = COALESCE($4, platform)
       WHERE license_id = $1
         AND device_hash = $2
       RETURNING id, device_name, platform, first_activated_at, last_seen_at, blocked_at, deactivated_at`,
      [license.id, deviceHash, deviceName, platform],
    );

    await recordActivation(client, {
      licenseId: license.id,
      deviceId: updated.rows[0].id,
      eventType: "validated",
      ipHash,
      metadata: { action: "validate" },
    });

    const primaryDeviceId = await claimPrimaryDevice(client, license, updated.rows[0].id);

    return {
      ok: true,
      value: {
        valid: true,
        license: mapLicense(license),
        device: mapDevice(updated.rows[0]),
        is_primary_device: primaryDeviceId === updated.rows[0].id,
      },
    };
  });

  return unwrap(result);
}

export async function deactivateLicense({
  licenseKey,
  deviceId,
  requestIp = null,
}) {
  await ensureDeviceManagementSchema();
  const licenseHash = hashLicenseKey(licenseKey);
  const deviceHash = hashDeviceId(deviceId);
  const ipHash = hashRequestIp(requestIp);

  const result = await withTransaction(async (client) => {
    const licenseResult = await client.query(
      `SELECT id, status, max_devices, primary_device_id, issued_at, revoked_at, revoke_reason
       FROM licenses
       WHERE license_key_hash = $1
       FOR SHARE`,
      [licenseHash],
    );

    const license = licenseResult.rows[0];
    if (!license) {
      return businessFailure(client, {
        code: "license_not_found",
        status: 404,
        ipHash,
        metadata: { action: "deactivate", reason: "license_not_found" },
      });
    }

    if (license.status !== "active") {
      return businessFailure(client, {
        code: "license_revoked",
        status: 403,
        licenseId: license.id,
        eventType: "revoked",
        ipHash,
        metadata: { action: "deactivate", reason: "license_revoked" },
      });
    }

    const deviceResult = await client.query(
      `SELECT id, device_name, platform, first_activated_at, last_seen_at, blocked_at, deactivated_at
       FROM devices
       WHERE license_id = $1
         AND device_hash = $2
       FOR UPDATE`,
      [license.id, deviceHash],
    );

    const device = deviceResult.rows[0];
    if (!device) {
      return businessFailure(client, {
        code: "device_not_found",
        status: 404,
        licenseId: license.id,
        ipHash,
        metadata: { action: "deactivate", reason: "device_not_found" },
      });
    }

    if (device.id === license.primary_device_id) {
      return businessFailure(client, {
        code: "primary_device_cannot_deactivate_self",
        status: 409,
        licenseId: license.id,
        deviceId: device.id,
        ipHash,
        metadata: { action: "deactivate", reason: "primary_device" },
      });
    }

    if (device.deactivated_at) {
      await recordActivation(client, {
        licenseId: license.id,
        deviceId: device.id,
        eventType: "deactivated",
        ipHash,
        metadata: { action: "deactivate", already_deactivated: true },
      });

      return {
        ok: true,
        value: {
          deactivated: true,
          already_deactivated: true,
          license: mapLicense(license),
          device: mapDevice(device),
        },
      };
    }

    const updated = await client.query(
      `UPDATE devices
       SET deactivated_at = NOW(),
           last_seen_at = NOW()
       WHERE id = $1
       RETURNING id, device_name, platform, first_activated_at, last_seen_at, blocked_at, deactivated_at`,
      [device.id],
    );

    await recordActivation(client, {
      licenseId: license.id,
      deviceId: device.id,
      eventType: "deactivated",
      ipHash,
      metadata: { action: "deactivate", already_deactivated: false },
    });

    return {
      ok: true,
      value: {
        deactivated: true,
        already_deactivated: false,
        license: mapLicense(license),
        device: mapDevice(updated.rows[0]),
      },
    };
  });

  return unwrap(result);
}


async function authorizePrimaryManagement(
  client,
  { licenseKey, deviceId, managementToken, requestIp = null },
) {
  const licenseHash = hashLicenseKey(licenseKey);
  const deviceHash = hashDeviceId(deviceId);
  const ipHash = hashRequestIp(requestIp);

  const licenseResult = await client.query(
    `SELECT id, status, max_devices, primary_device_id, issued_at, revoked_at, revoke_reason
     FROM licenses
     WHERE license_key_hash = $1
     FOR SHARE`,
    [licenseHash],
  );
  const license = licenseResult.rows[0];

  if (!license) {
    return businessFailure(client, {
      code: "license_not_found",
      status: 404,
      ipHash,
      metadata: { action: "manage_devices", reason: "license_not_found" },
    });
  }

  if (license.status !== "active") {
    return businessFailure(client, {
      code: "license_revoked",
      status: 403,
      licenseId: license.id,
      eventType: "revoked",
      ipHash,
      metadata: { action: "manage_devices", reason: "license_revoked" },
    });
  }

  const deviceResult = await client.query(
    `SELECT id, device_name, platform, first_activated_at, last_seen_at, blocked_at, deactivated_at
     FROM devices
     WHERE license_id = $1
       AND device_hash = $2
     FOR SHARE`,
    [license.id, deviceHash],
  );
  const device = deviceResult.rows[0];

  if (
    !device ||
    device.deactivated_at ||
    device.blocked_at ||
    device.id !== license.primary_device_id
  ) {
    return businessFailure(client, {
      code: "primary_device_required",
      status: 403,
      licenseId: license.id,
      deviceId: device?.id ?? null,
      ipHash,
      metadata: { action: "manage_devices", reason: "primary_device_required" },
    });
  }

  const token = verifyManagementToken(managementToken, {
    licenseId: license.id,
    deviceId,
  });
  if (!token.valid) {
    return businessFailure(client, {
      code: "invalid_management_token",
      status: 403,
      licenseId: license.id,
      deviceId: device.id,
      ipHash,
      metadata: {
        action: "manage_devices",
        reason: "invalid_management_token",
        token_error: token.error,
      },
    });
  }

  return {
    ok: true,
    value: { license, device, ipHash },
  };
}

export async function listManagedDevices({
  licenseKey,
  deviceId,
  managementToken,
  requestIp = null,
}) {
  await ensureDeviceManagementSchema();

  const result = await withTransaction(async (client) => {
    const authorized = await authorizePrimaryManagement(client, {
      licenseKey,
      deviceId,
      managementToken,
      requestIp,
    });
    if (!authorized.ok) return authorized;

    const { license, device } = authorized.value;
    const devices = await client.query(
      `SELECT id, device_name, platform, first_activated_at, last_seen_at, blocked_at, deactivated_at
       FROM devices
       WHERE license_id = $1
       ORDER BY
         CASE WHEN id = $2 THEN 0 ELSE 1 END,
         first_activated_at ASC,
         id ASC`,
      [license.id, device.id],
    );

    return {
      ok: true,
      value: {
        max_devices: license.max_devices,
        active_devices: await countActiveDevices(client, license.id),
        devices: devices.rows.map((row) => ({
          ...mapDevice(row),
          is_primary: row.id === license.primary_device_id,
          is_current: row.id === device.id,
          status: row.blocked_at
            ? "removed"
            : row.deactivated_at
              ? "inactive"
              : "active",
        })),
      },
    };
  });

  return unwrap(result);
}

export async function setManagedDeviceBlocked({
  licenseKey,
  deviceId,
  managementToken,
  targetDeviceId,
  blocked,
  requestIp = null,
}) {
  await ensureDeviceManagementSchema();

  const result = await withTransaction(async (client) => {
    const authorized = await authorizePrimaryManagement(client, {
      licenseKey,
      deviceId,
      managementToken,
      requestIp,
    });
    if (!authorized.ok) return authorized;

    const { license, device: primaryDevice, ipHash } = authorized.value;
    const targetResult = await client.query(
      `SELECT id, device_name, platform, first_activated_at, last_seen_at, blocked_at, deactivated_at
       FROM devices
       WHERE license_id = $1
         AND id = $2
       FOR UPDATE`,
      [license.id, targetDeviceId],
    );
    const target = targetResult.rows[0];

    if (!target) {
      return businessFailure(client, {
        code: "device_not_found",
        status: 404,
        licenseId: license.id,
        deviceId: primaryDevice.id,
        ipHash,
        metadata: { action: "manage_devices", reason: "device_not_found" },
      });
    }

    if (target.id === license.primary_device_id) {
      return businessFailure(client, {
        code: "primary_device_cannot_be_removed",
        status: 409,
        licenseId: license.id,
        deviceId: primaryDevice.id,
        ipHash,
        metadata: { action: "manage_devices", reason: "primary_device_target" },
      });
    }

    if (!blocked && (target.blocked_at || target.deactivated_at)) {
      const activeDevices = await countActiveDevices(client, license.id);
      if (activeDevices >= license.max_devices) {
        return businessFailure(client, {
          code: "device_limit_reached",
          status: 409,
          licenseId: license.id,
          deviceId: target.id,
          ipHash,
          metadata: {
            action: "managed_allow",
            reason: "device_limit_reached",
            active_devices: activeDevices,
            max_devices: license.max_devices,
          },
          details: {
            active_devices: activeDevices,
            max_devices: license.max_devices,
          },
        });
      }
    }

    const updated = blocked
      ? await client.query(
          `UPDATE devices
           SET blocked_at = COALESCE(blocked_at, NOW()),
               deactivated_at = COALESCE(deactivated_at, NOW()),
               last_seen_at = NOW()
           WHERE id = $1
           RETURNING id, device_name, platform, first_activated_at, last_seen_at, blocked_at, deactivated_at`,
          [target.id],
        )
      : await client.query(
          `UPDATE devices
           SET blocked_at = NULL,
               deactivated_at = NULL,
               last_seen_at = NOW()
           WHERE id = $1
           RETURNING id, device_name, platform, first_activated_at, last_seen_at, blocked_at, deactivated_at`,
          [target.id],
        );

    await recordActivation(client, {
      licenseId: license.id,
      deviceId: target.id,
      eventType: blocked ? "deactivated" : "activated",
      ipHash,
      metadata: {
        action: blocked ? "managed_remove" : "managed_allow",
        primary_device_id: primaryDevice.id,
      },
    });

    return {
      ok: true,
      value: {
        device: {
          ...mapDevice(updated.rows[0]),
          is_primary: false,
          is_current: false,
          status: blocked ? "removed" : "active",
        },
        max_devices: license.max_devices,
        active_devices: await countActiveDevices(client, license.id),
      },
    };
  });

  return unwrap(result);
}

export async function revokeLicense({ licenseId, reason = null }) {
  const result = await withTransaction(async (client) => {
    const licenseResult = await client.query(
      `SELECT id, status, max_devices, issued_at, revoked_at, revoke_reason
       FROM licenses
       WHERE id = $1
       FOR UPDATE`,
      [licenseId],
    );

    const existing = licenseResult.rows[0];
    if (!existing) {
      return {
        ok: false,
        error: new LicenseServiceError("license_not_found", 404),
      };
    }

    let license = existing;
    let alreadyRevoked = existing.status === "revoked";

    if (!alreadyRevoked) {
      const updated = await client.query(
        `UPDATE licenses
         SET status = 'revoked',
             revoked_at = NOW(),
             revoke_reason = $2
         WHERE id = $1
         RETURNING id, status, max_devices, issued_at, revoked_at, revoke_reason`,
        [licenseId, reason],
      );
      license = updated.rows[0];
    } else if (reason && reason !== existing.revoke_reason) {
      const updated = await client.query(
        `UPDATE licenses
         SET revoke_reason = $2
         WHERE id = $1
         RETURNING id, status, max_devices, issued_at, revoked_at, revoke_reason`,
        [licenseId, reason],
      );
      license = updated.rows[0];
    }

    await recordActivation(client, {
      licenseId,
      eventType: "revoked",
      metadata: {
        action: "revoke",
        already_revoked: alreadyRevoked,
        reason: license.revoke_reason ?? null,
      },
    });

    return {
      ok: true,
      value: {
        already_revoked: alreadyRevoked,
        license: mapLicense(license),
      },
    };
  });

  return unwrap(result);
}
