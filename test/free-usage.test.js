import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedTotalForInstallations,
  mergeFreeUsageState,
  minimumUsedForInstallations,
} from "../src/free-usage-service.js";

process.env.LICENSE_HASH_SECRET =
  "test-license-hash-secret-with-at-least-32-characters";

function createFakeClient(initial = null) {
  let row = initial
    ? {
        device_hash: initial.device_hash,
        installation_count: initial.installation_count,
        used_count: initial.used_count,
        first_seen_at: new Date("2026-09-19T00:00:00.000Z"),
        last_seen_at: new Date("2026-09-19T00:00:00.000Z"),
        updated_at: new Date("2026-09-19T00:00:00.000Z"),
      }
    : null;
  let insertedHash = null;

  return {
    get row() {
      return row;
    },
    get insertedHash() {
      return insertedHash;
    },
    async query(sql, params) {
      if (sql.includes("INSERT INTO free_usage_devices")) {
        insertedHash = params[0];
        if (!row) {
          row = {
            device_hash: params[0],
            installation_count: 1,
            used_count: 0,
            first_seen_at: new Date("2026-09-19T00:00:00.000Z"),
            last_seen_at: new Date("2026-09-19T00:00:00.000Z"),
            updated_at: new Date("2026-09-19T00:00:00.000Z"),
          };
        }
        return { rows: [] };
      }

      if (sql.includes("FROM free_usage_devices") && sql.includes("FOR UPDATE")) {
        return { rows: row && row.device_hash === params[0] ? [row] : [] };
      }

      if (sql.includes("UPDATE free_usage_devices")) {
        row = {
          ...row,
          installation_count: params[1],
          used_count: params[2],
          last_seen_at: new Date("2026-09-20T00:00:00.000Z"),
          updated_at: new Date("2026-09-20T00:00:00.000Z"),
        };
        return { rows: [row] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

test("free usage quotas are cumulative and capped after the fifth installation", () => {
  assert.equal(allowedTotalForInstallations(1), 5);
  assert.equal(allowedTotalForInstallations(2), 9);
  assert.equal(allowedTotalForInstallations(5), 15);
  assert.equal(allowedTotalForInstallations(12), 15);
  assert.equal(minimumUsedForInstallations(1), 0);
  assert.equal(minimumUsedForInstallations(2), 5);
  assert.equal(minimumUsedForInstallations(6), 15);
});

test("free usage sync is monotonic and reinstallations cannot restore consumed quota", async () => {
  const deviceId = "ALLM4D1.stable-device-for-test";
  const client = createFakeClient();

  const first = await mergeFreeUsageState(client, {
    deviceId,
    installationCount: 1,
    usedCount: 2,
  });
  assert.equal(first.installation_count, 1);
  assert.equal(first.used_count, 2);
  assert.equal(first.remaining, 3);

  const second = await mergeFreeUsageState(client, {
    deviceId,
    installationCount: 2,
    usedCount: 2,
  });
  assert.equal(second.installation_count, 2);
  assert.equal(second.used_count, 5);
  assert.equal(second.allowed_total, 9);
  assert.equal(second.remaining, 4);

  const stale = await mergeFreeUsageState(client, {
    deviceId,
    installationCount: 1,
    usedCount: 0,
  });
  assert.equal(stale.installation_count, 2);
  assert.equal(stale.used_count, 5);
  assert.notEqual(client.insertedHash, deviceId);
  assert.equal(client.insertedHash.length, 64);
});
