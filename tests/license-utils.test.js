import assert from "node:assert/strict";
import test from "node:test";
import {
  generateLicenseKey,
  hashDeviceId,
  hashLicenseKey,
  normalizeDeviceId,
  normalizeLicenseKey,
} from "../src/license-utils.js";

test("generateLicenseKey creates a valid Allm4 license", () => {
  const key = generateLicenseKey();
  assert.match(key, /^ALLM4-(?:[A-HJ-NP-Z2-9]{5}-){4}[A-HJ-NP-Z2-9]{5}$/);
  assert.equal(normalizeLicenseKey(key)?.length, 30);
});

test("license hashing is stable across formatting and case", () => {
  const key = generateLicenseKey();
  const compactLowerCase = key.replaceAll("-", "").toLowerCase();
  assert.equal(hashLicenseKey(key), hashLicenseKey(compactLowerCase));
});

test("invalid license keys are rejected", () => {
  assert.equal(normalizeLicenseKey("ALLM4-AAAAA"), null);
  assert.equal(hashLicenseKey("invalid"), null);
});

test("device identifiers are normalized and hashed without storing the raw value", () => {
  const deviceId = "550e8400-e29b-41d4-a716-446655440000";
  assert.equal(normalizeDeviceId(`  ${deviceId}  `), deviceId);
  assert.equal(hashDeviceId(deviceId), hashDeviceId(`  ${deviceId}  `));
  assert.notEqual(hashDeviceId(deviceId), deviceId);
});
