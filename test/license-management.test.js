import assert from "node:assert/strict";
import fs from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  issueManagementToken,
  verifyManagementToken,
} from "../src/license-token.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
process.env.LICENSE_PRIVATE_KEY = Buffer.from(
  privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  "utf8",
).toString("base64");
process.env.LICENSE_PUBLIC_KEY = Buffer.from(
  publicKey.export({ format: "pem", type: "spki" }).toString(),
  "utf8",
).toString("base64");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("management token is bound to the primary device and license", () => {
  const licenseId = "338abbdb-dd79-4c05-bd9a-4eaf5e50ee8f";
  const deviceId = "allm4-primary-machine-001";
  const token = issueManagementToken({
    licenseId,
    deviceId,
    issuedAt: new Date("2026-09-21T03:00:00.000Z"),
  });

  assert.match(token, /^ALLM4M1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const valid = verifyManagementToken(token, { licenseId, deviceId });
  assert.equal(valid.valid, true);
  assert.equal(valid.payload.scope, "device_management");

  assert.deepEqual(
    verifyManagementToken(token, {
      licenseId,
      deviceId: "allm4-secondary-machine-002",
    }),
    { valid: false, error: "device_mismatch" },
  );

  assert.deepEqual(
    verifyManagementToken(token, {
      licenseId: "9ea7c236-f85c-459b-a620-26d827b2419d",
      deviceId,
    }),
    { valid: false, error: "license_mismatch" },
  );
});

test("schema migrates existing licenses to the most recently seen active device and supports managed removal", () => {
  const schema = read("db/schema.sql");

  assert.match(schema, /primary_device_id UUID/);
  assert.match(schema, /blocked_at TIMESTAMPTZ/);
  assert.match(schema, /WHERE l\.primary_device_id IS NULL/);
  assert.match(schema, /last_seen_at DESC/);
  assert.match(schema, /first_activated_at DESC/);
  assert.match(schema, /licenses_primary_device_fk/);
});

test("managed removal cannot be bypassed by re-entering the license key", () => {
  const service = read("src/license-service.js");

  assert.match(service, /device_removed_by_primary/);
  assert.match(service, /if \(device\?\.blocked_at\)/);
  assert.match(service, /blocked_at = COALESCE\(blocked_at, NOW\(\)\)/);
  assert.match(service, /primary_device_required/);
  assert.match(service, /primary_device_cannot_be_removed/);
});

test("only the primary-device API exposes device administration", () => {
  const routes = read("src/license-routes.js");

  assert.match(routes, /\/licenses\/devices/);
  assert.match(routes, /management_token/);
  assert.match(routes, /maybeIssueManagementToken/);
  assert.match(routes, /setManagedDeviceBlocked/);
});
