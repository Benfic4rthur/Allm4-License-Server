import assert from "node:assert/strict";
import test from "node:test";
import {
  FREE_USAGE_LIMIT,
  mergeFreeUsageState,
} from "../src/free-usage-service.js";
import { hashDeviceId } from "../src/security.js";

process.env.LICENSE_HASH_SECRET =
  "test-license-hash-secret-with-at-least-32-characters";

function createFakeClient(initial = null) {
  let row = initial
    ? {
        device_hash: initial.device_hash,
        chat_used: initial.chat_used,
        image_used: initial.image_used,
        project_used: initial.project_used,
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
            chat_used: 0,
            image_used: 0,
            project_used: 0,
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
          chat_used: params[1],
          image_used: params[2],
          project_used: params[3],
          last_seen_at: new Date("2026-09-20T00:00:00.000Z"),
          updated_at: new Date("2026-09-20T00:00:00.000Z"),
        };
        return { rows: [row] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

test("each category has an independent allowance of ten successful uses", async () => {
  const client = createFakeClient();
  const result = await mergeFreeUsageState(client, {
    deviceId: "ALLM4D1.stable-device-for-test",
    chatUsed: 10,
    imageUsed: 4,
    projectUsed: 7,
  });

  assert.equal(FREE_USAGE_LIMIT, 10);
  assert.equal(result.chat.used, 10);
  assert.equal(result.chat.remaining, 0);
  assert.equal(result.chat.blocked, true);
  assert.equal(result.image.used, 4);
  assert.equal(result.image.remaining, 6);
  assert.equal(result.image.blocked, false);
  assert.equal(result.project.used, 7);
  assert.equal(result.project.remaining, 3);
  assert.equal(result.project.blocked, false);
});

test("server counters are monotonic and stale clients cannot restore free usage", async () => {
  const deviceId = "ALLM4D1.stable-device-for-test";
  const client = createFakeClient();

  const first = await mergeFreeUsageState(client, {
    deviceId,
    chatUsed: 6,
    imageUsed: 3,
    projectUsed: 8,
  });
  assert.equal(first.chat_used, 6);
  assert.equal(first.image_used, 3);
  assert.equal(first.project_used, 8);

  const stale = await mergeFreeUsageState(client, {
    deviceId,
    chatUsed: 0,
    imageUsed: 1,
    projectUsed: 2,
  });
  assert.equal(stale.chat_used, 6);
  assert.equal(stale.image_used, 3);
  assert.equal(stale.project_used, 8);
  assert.notEqual(client.insertedHash, deviceId);
  assert.equal(client.insertedHash.length, 64);
});

test("legacy device rows begin the v2 category counters at zero", async () => {
  const deviceId = "ALLM4D1.legacy-device";
  const client = createFakeClient({
    device_hash: hashDeviceId(deviceId),
    chat_used: undefined,
    image_used: undefined,
    project_used: undefined,
  });

  const result = await mergeFreeUsageState(client, {
    deviceId,
    chatUsed: 0,
    imageUsed: 0,
    projectUsed: 0,
  });

  assert.equal(result.chat.used, 0);
  assert.equal(result.image.used, 0);
  assert.equal(result.project.used, 0);
});
