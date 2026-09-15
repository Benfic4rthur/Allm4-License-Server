import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  createDeviceBinding,
  isOfflineSigningConfigured,
  issueOfflineLicenseToken,
  verifyOfflineLicenseToken,
} from "../src/license-token.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();

function configureKeys() {
  process.env.LICENSE_PRIVATE_KEY = Buffer.from(privatePem, "utf8").toString("base64");
  process.env.LICENSE_PUBLIC_KEY = Buffer.from(publicPem, "utf8").toString("base64");
}

configureKeys();

test("offline signing configuration requires both keys", () => {
  assert.equal(isOfflineSigningConfigured(), true);
});

test("device binding is deterministic and non-reversible SHA-256", () => {
  const binding = createDeviceBinding("allm4-installation-test-001");
  assert.match(binding, /^[a-f0-9]{64}$/);
  assert.equal(binding, createDeviceBinding("allm4-installation-test-001"));
  assert.notEqual(binding, createDeviceBinding("allm4-installation-test-002"));
});

test("offline lifetime token signs and verifies for the same device", () => {
  const token = issueOfflineLicenseToken({
    licenseId: "338abbdb-dd79-4c05-bd9a-4eaf5e50ee8f",
    deviceId: "allm4-installation-test-001",
    licenseIssuedAt: "2026-09-15T14:44:44.548Z",
    issuedAt: new Date("2026-09-15T15:00:00.000Z"),
  });

  assert.match(token, /^ALLM4L1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const result = verifyOfflineLicenseToken(token, {
    deviceId: "allm4-installation-test-001",
  });

  assert.equal(result.valid, true);
  assert.equal(result.payload.license_type, "lifetime");
  assert.equal(result.payload.license_id, "338abbdb-dd79-4c05-bd9a-4eaf5e50ee8f");
  assert.equal(result.payload.issued_at, "2026-09-15T15:00:00.000Z");
});

test("offline token is rejected on another device", () => {
  const token = issueOfflineLicenseToken({
    licenseId: "338abbdb-dd79-4c05-bd9a-4eaf5e50ee8f",
    deviceId: "allm4-installation-test-001",
    licenseIssuedAt: "2026-09-15T14:44:44.548Z",
  });

  const result = verifyOfflineLicenseToken(token, {
    deviceId: "allm4-installation-test-999",
  });

  assert.deepEqual(result, {
    valid: false,
    error: "device_mismatch",
  });
});

test("tampered offline token fails signature verification", () => {
  const token = issueOfflineLicenseToken({
    licenseId: "338abbdb-dd79-4c05-bd9a-4eaf5e50ee8f",
    deviceId: "allm4-installation-test-001",
    licenseIssuedAt: "2026-09-15T14:44:44.548Z",
  });

  const [prefix, payload, signature] = token.split(".");
  const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;
  const result = verifyOfflineLicenseToken(
    `${prefix}.${tamperedPayload}.${signature}`,
    { deviceId: "allm4-installation-test-001" },
  );

  assert.equal(result.valid, false);
});
