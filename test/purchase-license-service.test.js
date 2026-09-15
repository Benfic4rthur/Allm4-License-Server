import assert from "node:assert/strict";
import test from "node:test";
import { ensurePurchaseLicense } from "../src/purchase-license-service.js";
import { hashLicenseKey } from "../src/security.js";

process.env.LICENSE_HASH_SECRET =
  "test-license-hash-secret-with-at-least-32-characters";

function createFakeClient() {
  const rowsByPurchase = new Map();
  let insertCount = 0;

  return {
    get insertCount() {
      return insertCount;
    },
    async query(sql, params) {
      if (sql.includes("INSERT INTO licenses")) {
        insertCount += 1;
        const [purchaseId, licenseKeyHash, maxDevices] = params;
        if (rowsByPurchase.has(purchaseId)) {
          return { rows: [] };
        }

        const row = {
          id: "9ea7c236-f85c-459b-a620-26d827b2419d",
          purchase_id: purchaseId,
          license_key_hash: licenseKeyHash,
          status: "active",
          max_devices: maxDevices,
          issued_at: new Date("2026-09-15T17:00:00.000Z"),
          revoked_at: null,
          revoke_reason: null,
        };
        rowsByPurchase.set(purchaseId, row);
        return { rows: [row] };
      }

      if (sql.includes("FROM licenses") && sql.includes("purchase_id = $1")) {
        return { rows: [rowsByPurchase.get(params[0])].filter(Boolean) };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

test("ensurePurchaseLicense issues exactly one recoverable license per purchase", async () => {
  const purchaseId = "123e4567-e89b-42d3-a456-426614174000";
  const client = createFakeClient();

  const first = await ensurePurchaseLicense(client, purchaseId);
  const second = await ensurePurchaseLicense(client, purchaseId);

  assert.equal(first.issued, true);
  assert.equal(first.recoverable, true);
  assert.equal(second.issued, false);
  assert.equal(second.recoverable, true);
  assert.equal(second.license.id, first.license.id);
  assert.equal(second.license_key, first.license_key);
  assert.equal(hashLicenseKey(first.license_key).length, 64);
  assert.equal(client.insertCount, 2);
});
