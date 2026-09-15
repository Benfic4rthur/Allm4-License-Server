import { getPool } from "./db.js";
import { generateLicenseKey, hashDeviceId, hashLicenseKey } from "./license-utils.js";

async function withTransaction(callback) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function recordActivation(client, { licenseId = null, deviceId = null, eventType, metadata = {} }) {
  await client.query(
    `INSERT INTO activations (license_id, device_id, event_type, metadata)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [licenseId, deviceId, eventType, JSON.stringify(metadata)],
  );
}

function licenseResponse(license, extra = {}) {
  return {
    license_id: license.id,
    status: license.status,
    max_devices: license.max_devices,
    issued_at: license.issued_at,
    ...extra,
  };
}

async function countActiveDevices(client, licenseId) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM devices
     WHERE license_id = $1 AND deactivated_at IS NULL`,
    [licenseId],
  );

  return result.rows[0]?.count ?? 0;
}

export async function createLicense({ maxDevices = 3 } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const licenseKey = generateLicenseKey();
    const licenseKeyHash = hashLicenseKey(licenseKey);

    try {
      const result = await getPool().query(
        `INSERT INTO licenses (license_key_hash, max_devices)
         VALUES ($1, $2)
         RETURNING id, status, max_devices, issued_at`,
        [licenseKeyHash, maxDevices],
      );

      return {
        license_key: licenseKey,
        ...licenseResponse(result.rows[0]),
      };
    } catch (error) {
      if (error?.code !== "23505") {
        throw error;
      }
    }
  }

  throw new Error("Unable to generate a unique license key");
}

export async function activateLicense({ licenseKey, deviceId, deviceName = null, platform = null }) {
  const licenseKeyHash = hashLicenseKey(licenseKey);
  const deviceHash = hashDeviceId(deviceId);

  return withTransaction(async (client) => {
    const licenseResult = await client.query(
      `SELECT id, status, max_devices, issued_at, revoked_at, revoke_reason
       FROM licenses
       WHERE license_key_hash = $1
       FOR UPDATE`,
      [licenseKeyHash],
    );

    const license = licenseResult.rows[0];
    if (!license) {
      await recordActivation(client, {
        eventType: "rejected",
        metadata: { reason: "license_not_found" },
      });
      return { ok: false, httpStatus: 404, error: "license_not_found" };
    }

    if (license.status !== "active") {
      await recordActivation(client, {
        licenseId: license.id,
        eventType: "rejected",
        metadata: { reason: "license_revoked" },
      });
      return { ok: false, httpStatus: 403, error: "license_revoked" };
    }

    const deviceResult = await client.query(
      `SELECT id, deactivated_at
       FROM devices
       WHERE license_id = $1 AND device_hash = $2`,
      [license.id, deviceHash],
    );

    const existingDevice = deviceResult.rows[0];
    if (existingDevice && !existingDevice.deactivated_at) {
      await client.query(
        `UPDATE devices
         SET last_seen_at = NOW(),
             device_name = COALESCE($2, device_name),
             platform = COALESCE($3, platform)
         WHERE id = $1`,
        [existingDevice.id, deviceName, platform],
      );
      await recordActivation(client, {
        licenseId: license.id,
        deviceId: existingDevice.id,
        eventType: "validated",
        metadata: { source: "activate", existing_device: true },
      });

      const activeDevices = await countActiveDevices(client, license.id);
      return {
        ok: true,
        httpStatus: 200,
        activated: false,
        existing_device: true,
        device_id: existingDevice.id,
        active_devices: activeDevices,
        ...licenseResponse(license),
      };
    }

    const activeDevices = await countActiveDevices(client, license.id);
    if (activeDevices >= license.max_devices) {
      await recordActivation(client, {
        licenseId: license.id,
        deviceId: existingDevice?.id ?? null,
        eventType: "rejected",
        metadata: {
          reason: "device_limit_reached",
          active_devices: activeDevices,
          max_devices: license.max_devices,
        },
      });
      return {
        ok: false,
        httpStatus: 409,
        error: "device_limit_reached",
        active_devices: activeDevices,
        max_devices: license.max_devices,
      };
    }

    let device;
    if (existingDevice) {
      const reactivatedResult = await client.query(
        `UPDATE devices
         SET deactivated_at = NULL,
             last_seen_at = NOW(),
             device_name = COALESCE($2, device_name),
             platform = COALESCE($3, platform)
         WHERE id = $1
         RETURNING id`,
        [existingDevice.id, deviceName, platform],
      );
      device = reactivatedResult.rows[0];
    } else {
      const createdResult = await client.query(
        `INSERT INTO devices (license_id, device_hash, device_name, platform)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [license.id, deviceHash, deviceName, platform],
      );
      device = createdResult.rows[0];
    }

    await recordActivation(client, {
      licenseId: license.id,
      deviceId: device.id,
      eventType: "activated",
      metadata: { reactivated: Boolean(existingDevice) },
    });

    return {
      ok: true,
      httpStatus: 201,
      activated: true,
      reactivated: Boolean(existingDevice),
      device_id: device.id,
      active_devices: activeDevices + 1,
      ...licenseResponse(license),
    };
  });
}

export async function validateLicense({ licenseKey, deviceId }) {
  const licenseKeyHash = hashLicenseKey(licenseKey);
  const deviceHash = hashDeviceId(deviceId);

  return withTransaction(async (client) => {
    const licenseResult = await client.query(
      `SELECT id, status, max_devices, issued_at, revoked_at, revoke_reason
       FROM licenses
       WHERE license_key_hash = $1`,
      [licenseKeyHash],
    );

    const license = licenseResult.rows[0];
    if (!license) {
      await recordActivation(client, {
        eventType: "rejected",
        metadata: { reason: "license_not_found", source: "validate" },
      });
      return { ok: false, httpStatus: 404, error: "license_not_found" };
    }

    if (license.status !== "active") {
      await recordActivation(client, {
        licenseId: license.id,
        eventType: "rejected",
        metadata: { reason: "license_revoked", source: "validate" },
      });
      return { ok: false, httpStatus: 403, error: "license_revoked" };
    }

    const deviceResult = await client.query(
      `SELECT id, deactivated_at
       FROM devices
       WHERE license_id = $1 AND device_hash = $2`,
      [license.id, deviceHash],
    );
    const device = deviceResult.rows[0];

    if (!device || device.deactivated_at) {
      await recordActivation(client, {
        licenseId: license.id,
        deviceId: device?.id ?? null,
        eventType: "rejected",
        metadata: {
          reason: device ? "device_deactivated" : "device_not_activated",
          source: "validate",
        },
      });
      return {
        ok: false,
        httpStatus: 403,
        error: device ? "device_deactivated" : "device_not_activated",
      };
    }

    await client.query("UPDATE devices SET last_seen_at = NOW() WHERE id = $1", [device.id]);
    await recordActivation(client, {
      licenseId: license.id,
      deviceId: device.id,
      eventType: "validated",
    });

    const activeDevices = await countActiveDevices(client, license.id);
    return {
      ok: true,
      httpStatus: 200,
      valid: true,
      device_id: device.id,
      active_devices: activeDevices,
      ...licenseResponse(license),
    };
  });
}

export async function deactivateDevice({ licenseKey, deviceId }) {
  const licenseKeyHash = hashLicenseKey(licenseKey);
  const deviceHash = hashDeviceId(deviceId);

  return withTransaction(async (client) => {
    const licenseResult = await client.query(
      `SELECT id, status, max_devices, issued_at
       FROM licenses
       WHERE license_key_hash = $1
       FOR UPDATE`,
      [licenseKeyHash],
    );
    const license = licenseResult.rows[0];

    if (!license) {
      return { ok: false, httpStatus: 404, error: "license_not_found" };
    }

    const deviceResult = await client.query(
      `SELECT id, deactivated_at
       FROM devices
       WHERE license_id = $1 AND device_hash = $2`,
      [license.id, deviceHash],
    );
    const device = deviceResult.rows[0];

    if (!device) {
      return { ok: false, httpStatus: 404, error: "device_not_found" };
    }

    if (device.deactivated_at) {
      return {
        ok: true,
        httpStatus: 200,
        deactivated: true,
        already_deactivated: true,
        device_id: device.id,
      };
    }

    await client.query(
      "UPDATE devices SET deactivated_at = NOW(), last_seen_at = NOW() WHERE id = $1",
      [device.id],
    );
    await recordActivation(client, {
      licenseId: license.id,
      deviceId: device.id,
      eventType: "deactivated",
    });

    return {
      ok: true,
      httpStatus: 200,
      deactivated: true,
      already_deactivated: false,
      device_id: device.id,
      active_devices: Math.max((await countActiveDevices(client, license.id)), 0),
    };
  });
}

export async function revokeLicense({ licenseId, reason = null }) {
  return withTransaction(async (client) => {
    const licenseResult = await client.query(
      `SELECT id, status, max_devices, issued_at, revoked_at, revoke_reason
       FROM licenses
       WHERE id = $1
       FOR UPDATE`,
      [licenseId],
    );
    const license = licenseResult.rows[0];

    if (!license) {
      return { ok: false, httpStatus: 404, error: "license_not_found" };
    }

    if (license.status === "revoked") {
      return {
        ok: true,
        httpStatus: 200,
        revoked: true,
        already_revoked: true,
        license_id: license.id,
        revoked_at: license.revoked_at,
        revoke_reason: license.revoke_reason,
      };
    }

    const updatedResult = await client.query(
      `UPDATE licenses
       SET status = 'revoked', revoked_at = NOW(), revoke_reason = $2
       WHERE id = $1
       RETURNING id, revoked_at, revoke_reason`,
      [licenseId, reason],
    );
    const updated = updatedResult.rows[0];

    await recordActivation(client, {
      licenseId,
      eventType: "revoked",
      metadata: reason ? { reason } : {},
    });

    return {
      ok: true,
      httpStatus: 200,
      revoked: true,
      already_revoked: false,
      license_id: updated.id,
      revoked_at: updated.revoked_at,
      revoke_reason: updated.revoke_reason,
    };
  });
}
