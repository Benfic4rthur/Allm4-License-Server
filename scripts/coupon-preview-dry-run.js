import assert from "node:assert/strict";
import { getPool } from "../src/db.js";
import { runCouponSchemaMigration } from "../src/coupon-schema.js";
import {
  lockCouponForPurchase,
  recordCouponRedemption,
} from "../src/coupon-service.js";
import { ensurePurchaseLicense } from "../src/purchase-license-service.js";

const pool = getPool();
const client = await pool.connect();
const schema = `coupon_preview_dry_run_${Date.now()}_${process.pid}`;

if (!/^[a-z0-9_]+$/.test(schema)) {
  throw new Error("Unsafe dry-run schema name");
}

let began = false;

try {
  await client.query("BEGIN");
  began = true;

  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}", public`);

  await client.query(
    `CREATE TABLE purchases (
       id UUID PRIMARY KEY,
       provider TEXT NOT NULL DEFAULT 'mercado_pago',
       provider_payment_id TEXT UNIQUE,
       payer_email TEXT,
       amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
       currency TEXT NOT NULL DEFAULT 'BRL',
       status TEXT NOT NULL DEFAULT 'pending' CHECK (
         status IN ('pending', 'approved', 'rejected', 'cancelled', 'refunded', 'charged_back')
       ),
       paid_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );

  const legacyPurchaseId = "11111111-1111-4111-8111-111111111111";
  await client.query(
    `INSERT INTO purchases (id, payer_email, amount_cents, status)
     VALUES ($1, 'legacy@example.com', 4999, 'approved')`,
    [legacyPurchaseId],
  );

  const migration = await runCouponSchemaMigration(client);
  assert.deepEqual(migration, { applied: true, key: "coupon-schema-v1" });

  const migratedPurchase = await client.query(
    `SELECT amount_cents, original_amount_cents, discount_amount_cents
     FROM purchases
     WHERE id = $1`,
    [legacyPurchaseId],
  );
  assert.deepEqual(migratedPurchase.rows[0], {
    amount_cents: 4999,
    original_amount_cents: 4999,
    discount_amount_cents: 0,
  });

  await client.query(
    `INSERT INTO coupons (code, discount_type, discount_value, max_uses_per_email)
     VALUES
       ('PREVIEW50', 'percent', 50, 1),
       ('PREVIEW100', 'percent', 100, 1)`,
  );

  const fifty = await lockCouponForPurchase(client, {
    couponCode: "PREVIEW50",
    payerEmail: "preview50@example.com",
    baseAmountCents: 4999,
  });
  assert.deepEqual(fifty.pricing, {
    original_amount_cents: 4999,
    discount_amount_cents: 2500,
    final_amount_cents: 2499,
  });

  const hundred = await lockCouponForPurchase(client, {
    couponCode: "PREVIEW100",
    payerEmail: "preview100@example.com",
    baseAmountCents: 4999,
  });
  assert.deepEqual(hundred.pricing, {
    original_amount_cents: 4999,
    discount_amount_cents: 4999,
    final_amount_cents: 0,
  });

  const freePurchaseId = "22222222-2222-4222-8222-222222222222";
  await client.query(
    `INSERT INTO purchases (
       id, provider, payer_email, coupon_id, original_amount_cents,
       discount_amount_cents, amount_cents, currency, status, paid_at
     )
     VALUES ($1, 'coupon', $2, $3, 4999, 4999, 0, 'BRL', 'approved', NOW())`,
    [freePurchaseId, "preview100@example.com", hundred.coupon.id],
  );

  await recordCouponRedemption(client, {
    couponId: hundred.coupon.id,
    purchaseId: freePurchaseId,
    payerEmail: "preview100@example.com",
    redeemed: true,
  });

  await client.query(
    `CREATE TABLE licenses (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       purchase_id UUID UNIQUE REFERENCES purchases(id) ON DELETE SET NULL,
       license_key_hash TEXT UNIQUE NOT NULL,
       status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
       max_devices INTEGER NOT NULL DEFAULT 3 CHECK (max_devices > 0),
       issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       revoked_at TIMESTAMPTZ,
       revoke_reason TEXT
     )`,
  );

  const issued = await ensurePurchaseLicense(client, freePurchaseId);
  assert.equal(issued.issued, true);
  assert.equal(issued.recoverable, true);
  assert.match(issued.license_key, /^ALLM4-/);

  const redemption = await client.query(
    `SELECT r.status, c.used_count
     FROM coupon_redemptions r
     JOIN coupons c ON c.id = r.coupon_id
     WHERE r.purchase_id = $1`,
    [freePurchaseId],
  );
  assert.deepEqual(redemption.rows[0], {
    status: "redeemed",
    used_count: 1,
  });

  const secondRun = await runCouponSchemaMigration(client);
  assert.deepEqual(secondRun, { applied: false, key: "coupon-schema-v1" });

  console.log("Coupon preview dry-run passed");
} finally {
  if (began) {
    try {
      await client.query("ROLLBACK");
    } catch {}
  }
  client.release();
  await pool.end();
}
