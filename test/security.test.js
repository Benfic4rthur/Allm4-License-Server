import assert from "node:assert/strict";
import test from "node:test";
import {
  derivePurchaseLicenseKey,
  generateLicenseKey,
  hashDeviceId,
  hashLicenseKey,
  normalizeDeviceId,
  normalizeLicenseKey,
  verifyAdminSecret,
} from "../src/security.js";

process.env.LICENSE_HASH_SECRET =
  "test-license-hash-secret-with-at-least-32-characters";
process.env.ADMIN_SECRET = "test-admin-secret-with-at-least-32-characters";

test("generateLicenseKey returns canonical high-entropy format", () => {
  const keys = new Set();

  for (let index = 0; index < 100; index += 1) {
    const key = generateLicenseKey();
    assert.match(key, /^ALLM4(?:-[A-HJ-NP-Z2-9]{4}){7}$/);
    keys.add(key);
  }

  assert.equal(keys.size, 100);
});

test("derivePurchaseLicenseKey is deterministic and purchase-specific", () => {
  const purchaseId = "123e4567-e89b-42d3-a456-426614174000";
  const anotherPurchaseId = "123e4567-e89b-42d3-a456-426614174001";
  const key = derivePurchaseLicenseKey(purchaseId);

  assert.match(key, /^ALLM4(?:-[A-HJ-NP-Z2-9]{4}){7}$/);
  assert.equal(derivePurchaseLicenseKey(purchaseId.toUpperCase()), key);
  assert.notEqual(derivePurchaseLicenseKey(anotherPurchaseId), key);
  assert.throws(() => derivePurchaseLicenseKey("not-a-purchase-id"), TypeError);
});

test("normalizeLicenseKey accepts lowercase and separator variations", () => {
  const key = generateLicenseKey();
  const compact = key.replaceAll("-", "").toLowerCase();
  assert.equal(normalizeLicenseKey(compact), key);
  assert.equal(normalizeLicenseKey(`  ${key.toLowerCase()}  `), key);
});

test("normalizeLicenseKey rejects malformed keys", () => {
  assert.equal(normalizeLicenseKey("ALLM4-AAAA"), null);
  assert.equal(
    normalizeLicenseKey("ALLM4-OOOO-OOOO-OOOO-OOOO-OOOO-OOOO-OOOO"),
    null,
  );
});

test("license and device hashes are deterministic and domain separated", () => {
  const key = generateLicenseKey();
  const deviceId = "4e19d25d-7ce3-4d42-89f0-3ebcdb0ee171";
  const licenseHash = hashLicenseKey(key);
  const deviceHash = hashDeviceId(deviceId);

  assert.equal(hashLicenseKey(key), licenseHash);
  assert.equal(hashDeviceId(deviceId), deviceHash);
  assert.notEqual(licenseHash, deviceHash);
  assert.match(licenseHash, /^[a-f0-9]{64}$/);
  assert.match(deviceHash, /^[a-f0-9]{64}$/);
});

test("normalizeDeviceId enforces sane bounds", () => {
  assert.equal(normalizeDeviceId("short"), null);
  assert.equal(normalizeDeviceId("valid-device-id"), "valid-device-id");
  assert.equal(normalizeDeviceId(`device-${"x".repeat(300)}`), null);
});

test("verifyAdminSecret compares secrets safely", () => {
  assert.equal(
    verifyAdminSecret("test-admin-secret-with-at-least-32-characters"),
    true,
  );
  assert.equal(verifyAdminSecret("wrong-secret"), false);
});
