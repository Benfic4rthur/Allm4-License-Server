import { getPool, withTransaction } from "./db.js";
import { hashDeviceId } from "./security.js";

export const FREE_USAGE_LIMIT = 10;
export const FREE_USAGE_CATEGORIES = Object.freeze(["chat", "image", "project"]);

let storageReady = null;

function counter(used) {
  const normalizedUsed = Math.max(0, Number(used || 0));
  return {
    used: normalizedUsed,
    limit: FREE_USAGE_LIMIT,
    remaining: Math.max(0, FREE_USAGE_LIMIT - normalizedUsed),
    blocked: normalizedUsed >= FREE_USAGE_LIMIT,
  };
}

function mapFreeUsage(row) {
  const chatUsed = Math.max(0, Number(row.chat_used || 0));
  const imageUsed = Math.max(0, Number(row.image_used || 0));
  const projectUsed = Math.max(0, Number(row.project_used || 0));
  return {
    limit: FREE_USAGE_LIMIT,
    chat_used: chatUsed,
    image_used: imageUsed,
    project_used: projectUsed,
    chat: counter(chatUsed),
    image: counter(imageUsed),
    project: counter(projectUsed),
    last_seen_at: row.last_seen_at ?? null,
  };
}

async function ensureFreeUsageStorage() {
  if (!storageReady) {
    storageReady = (async () => {
      const pool = getPool();
      await pool.query(
        `CREATE TABLE IF NOT EXISTS free_usage_devices (
          device_hash TEXT PRIMARY KEY,
          installation_count INTEGER NOT NULL DEFAULT 1 CHECK (installation_count >= 1),
          used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
          chat_used INTEGER NOT NULL DEFAULT 0 CHECK (chat_used >= 0),
          image_used INTEGER NOT NULL DEFAULT 0 CHECK (image_used >= 0),
          project_used INTEGER NOT NULL DEFAULT 0 CHECK (project_used >= 0),
          first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
      );
      await pool.query(
        `ALTER TABLE free_usage_devices
           ADD COLUMN IF NOT EXISTS chat_used INTEGER NOT NULL DEFAULT 0 CHECK (chat_used >= 0)`,
      );
      await pool.query(
        `ALTER TABLE free_usage_devices
           ADD COLUMN IF NOT EXISTS image_used INTEGER NOT NULL DEFAULT 0 CHECK (image_used >= 0)`,
      );
      await pool.query(
        `ALTER TABLE free_usage_devices
           ADD COLUMN IF NOT EXISTS project_used INTEGER NOT NULL DEFAULT 0 CHECK (project_used >= 0)`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_free_usage_devices_last_seen
         ON free_usage_devices(last_seen_at DESC)`,
      );
    })().catch((error) => {
      storageReady = null;
      throw error;
    });
  }

  return storageReady;
}

export async function mergeFreeUsageState(
  client,
  { deviceId, chatUsed, imageUsed, projectUsed },
) {
  const deviceHash = hashDeviceId(deviceId);

  await client.query(
    `INSERT INTO free_usage_devices (
      device_hash,
      chat_used,
      image_used,
      project_used
    ) VALUES ($1, 0, 0, 0)
    ON CONFLICT (device_hash) DO NOTHING`,
    [deviceHash],
  );

  const currentResult = await client.query(
    `SELECT device_hash, chat_used, image_used, project_used,
            first_seen_at, last_seen_at, updated_at
     FROM free_usage_devices
     WHERE device_hash = $1
     FOR UPDATE`,
    [deviceHash],
  );

  const current = currentResult.rows[0];
  if (!current) {
    throw new Error("free usage state unavailable after upsert");
  }

  const finalChatUsed = Math.max(0, Number(current.chat_used || 0), chatUsed);
  const finalImageUsed = Math.max(0, Number(current.image_used || 0), imageUsed);
  const finalProjectUsed = Math.max(0, Number(current.project_used || 0), projectUsed);

  const updated = await client.query(
    `UPDATE free_usage_devices
     SET chat_used = $2,
         image_used = $3,
         project_used = $4,
         last_seen_at = NOW(),
         updated_at = NOW()
     WHERE device_hash = $1
     RETURNING device_hash, chat_used, image_used, project_used,
               first_seen_at, last_seen_at, updated_at`,
    [deviceHash, finalChatUsed, finalImageUsed, finalProjectUsed],
  );

  return mapFreeUsage(updated.rows[0]);
}

export async function syncFreeUsage(input) {
  await ensureFreeUsageStorage();
  return withTransaction((client) => mergeFreeUsageState(client, input));
}
