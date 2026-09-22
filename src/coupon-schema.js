import { withTransaction } from "./db.js";

const COUPON_SCHEMA_MIGRATION_KEY = "coupon-schema-v1";
const COUPON_SCHEMA_LOCK_KEY = "allm4-coupon-schema-v1";

let couponStorageReady = null;

export async function runCouponSchemaMigration(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    COUPON_SCHEMA_LOCK_KEY,
  ]);

  await client.query(
    `CREATE TABLE IF NOT EXISTS coupon_schema_migrations (
       key TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );

  const alreadyApplied = await client.query(
    `SELECT key
     FROM coupon_schema_migrations
     WHERE key = $1`,
    [COUPON_SCHEMA_MIGRATION_KEY],
  );

  if (alreadyApplied.rows.length > 0) {
    return { applied: false, key: COUPON_SCHEMA_MIGRATION_KEY };
  }

  await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");

  await client.query(
    `CREATE TABLE IF NOT EXISTS coupons (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       code TEXT UNIQUE NOT NULL CHECK (
         code = UPPER(code)
         AND code ~ '^[A-Z0-9_-]{3,40}$'
       ),
       discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
       discount_value INTEGER NOT NULL CHECK (discount_value > 0),
       active BOOLEAN NOT NULL DEFAULT TRUE,
       starts_at TIMESTAMPTZ,
       expires_at TIMESTAMPTZ,
       max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
       used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
       max_uses_per_email INTEGER CHECK (
         max_uses_per_email IS NULL OR max_uses_per_email > 0
       ),
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       CHECK (discount_type <> 'percent' OR discount_value <= 100),
       CHECK (expires_at IS NULL OR starts_at IS NULL OR expires_at > starts_at)
     )`,
  );

  await client.query(
    `ALTER TABLE purchases
       ADD COLUMN IF NOT EXISTS coupon_id UUID`,
  );
  await client.query(
    `ALTER TABLE purchases
       ADD COLUMN IF NOT EXISTS original_amount_cents INTEGER`,
  );
  await client.query(
    `ALTER TABLE purchases
       ADD COLUMN IF NOT EXISTS discount_amount_cents INTEGER NOT NULL DEFAULT 0`,
  );

  await client.query(
    `UPDATE purchases
     SET original_amount_cents = amount_cents
     WHERE original_amount_cents IS NULL`,
  );

  await client.query(
    `ALTER TABLE purchases
       ALTER COLUMN original_amount_cents SET NOT NULL`,
  );
  await client.query(
    `ALTER TABLE purchases
       ALTER COLUMN original_amount_cents SET DEFAULT 4999`,
  );

  await client.query(
    `ALTER TABLE purchases
       DROP CONSTRAINT IF EXISTS purchases_amount_cents_check`,
  );
  await client.query(
    `ALTER TABLE purchases
       ADD CONSTRAINT purchases_amount_cents_check CHECK (amount_cents >= 0)`,
  );

  await client.query(
    `DO $allm4$
     BEGIN
       ALTER TABLE purchases
         ADD CONSTRAINT purchases_original_amount_cents_check
         CHECK (original_amount_cents > 0);
     EXCEPTION
       WHEN duplicate_object THEN NULL;
     END $allm4$;`,
  );

  await client.query(
    `DO $allm4$
     BEGIN
       ALTER TABLE purchases
         ADD CONSTRAINT purchases_discount_amount_cents_check
         CHECK (discount_amount_cents >= 0);
     EXCEPTION
       WHEN duplicate_object THEN NULL;
     END $allm4$;`,
  );

  await client.query(
    `DO $allm4$
     BEGIN
       ALTER TABLE purchases
         ADD CONSTRAINT purchases_pricing_consistency_check
         CHECK (
           discount_amount_cents <= original_amount_cents
           AND amount_cents = original_amount_cents - discount_amount_cents
         );
     EXCEPTION
       WHEN duplicate_object THEN NULL;
     END $allm4$;`,
  );

  await client.query(
    `DO $allm4$
     BEGIN
       ALTER TABLE purchases
         ADD CONSTRAINT purchases_coupon_fk
         FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE SET NULL;
     EXCEPTION
       WHEN duplicate_object THEN NULL;
     END $allm4$;`,
  );

  await client.query(
    `CREATE TABLE IF NOT EXISTS coupon_redemptions (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       coupon_id UUID NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
       purchase_id UUID UNIQUE NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
       payer_email TEXT NOT NULL,
       status TEXT NOT NULL CHECK (status IN ('reserved', 'redeemed', 'released')),
       redeemed_at TIMESTAMPTZ,
       released_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );

  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_purchases_coupon_id
     ON purchases(coupon_id)`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon_status
     ON coupon_redemptions(coupon_id, status)`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon_email
     ON coupon_redemptions(coupon_id, payer_email, status)`,
  );

  await client.query(
    `INSERT INTO coupon_schema_migrations (key)
     VALUES ($1)
     ON CONFLICT (key) DO NOTHING`,
    [COUPON_SCHEMA_MIGRATION_KEY],
  );

  return { applied: true, key: COUPON_SCHEMA_MIGRATION_KEY };
}

export async function ensureCouponStorage() {
  if (!couponStorageReady) {
    couponStorageReady = withTransaction((client) =>
      runCouponSchemaMigration(client),
    ).catch((error) => {
      couponStorageReady = null;
      throw error;
    });
  }

  return couponStorageReady;
}
