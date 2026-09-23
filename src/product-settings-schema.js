import { withTransaction } from "./db.js";

const PRODUCT_SETTINGS_MIGRATION_KEY = "product-settings-v1";
const PRODUCT_SETTINGS_LOCK_KEY = "allm4-product-settings-v1";
export const DEFAULT_ALMA_PRICE_CENTS = 4999;

let productSettingsReady = null;

export async function runProductSettingsMigration(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    PRODUCT_SETTINGS_LOCK_KEY,
  ]);

  await client.query(
    `CREATE TABLE IF NOT EXISTS product_settings_migrations (
       key TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );

  await client.query(
    `CREATE TABLE IF NOT EXISTS product_settings (
       product_key TEXT PRIMARY KEY,
       price_cents INTEGER NOT NULL CHECK (price_cents > 0),
       currency TEXT NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );

  await client.query(
    `INSERT INTO product_settings (product_key, price_cents, currency)
     VALUES ('alma', $1, 'BRL')
     ON CONFLICT (product_key) DO NOTHING`,
    [DEFAULT_ALMA_PRICE_CENTS],
  );

  await client.query(
    `INSERT INTO product_settings_migrations (key)
     VALUES ($1)
     ON CONFLICT (key) DO NOTHING`,
    [PRODUCT_SETTINGS_MIGRATION_KEY],
  );

  return { applied: true, key: PRODUCT_SETTINGS_MIGRATION_KEY };
}

export async function ensureProductSettingsStorage() {
  if (!productSettingsReady) {
    productSettingsReady = withTransaction((client) =>
      runProductSettingsMigration(client),
    ).catch((error) => {
      productSettingsReady = null;
      throw error;
    });
  }
  return productSettingsReady;
}
