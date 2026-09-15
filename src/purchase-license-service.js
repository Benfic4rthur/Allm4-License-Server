import { derivePurchaseLicenseKey, hashLicenseKey } from "./security.js";

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

export async function ensurePurchaseLicense(client, purchaseId, maxDevices = 3) {
  const licenseKey = derivePurchaseLicenseKey(purchaseId);
  const licenseKeyHash = hashLicenseKey(licenseKey);

  const inserted = await client.query(
    `INSERT INTO licenses (purchase_id, license_key_hash, max_devices)
     VALUES ($1, $2, $3)
     ON CONFLICT (purchase_id) DO NOTHING
     RETURNING id, purchase_id, license_key_hash, status, max_devices,
               issued_at, revoked_at, revoke_reason`,
    [purchaseId, licenseKeyHash, maxDevices],
  );

  if (inserted.rows[0]) {
    return {
      issued: true,
      recoverable: true,
      license_key: licenseKey,
      license: mapLicense(inserted.rows[0]),
    };
  }

  const existing = await client.query(
    `SELECT id, purchase_id, license_key_hash, status, max_devices,
            issued_at, revoked_at, revoke_reason
     FROM licenses
     WHERE purchase_id = $1
     FOR UPDATE`,
    [purchaseId],
  );

  const license = existing.rows[0];
  if (!license) {
    throw new Error("Purchase license conflict could not be resolved");
  }

  return {
    issued: false,
    recoverable: license.license_key_hash === licenseKeyHash,
    license_key: license.license_key_hash === licenseKeyHash ? licenseKey : null,
    license: mapLicense(license),
  };
}
