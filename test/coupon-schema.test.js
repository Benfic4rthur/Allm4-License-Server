import assert from "node:assert/strict";
import test from "node:test";
import {
  runCouponSchemaMigration,
  runCouponSitePublishMigration,
} from "../src/coupon-schema.js";

function createClient({ alreadyApplied = false } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });

      if (sql.includes("FROM coupon_schema_migrations")) {
        return {
          rows: alreadyApplied ? [{ key: "coupon-schema-v1" }] : [],
        };
      }

      return { rows: [] };
    },
  };
}

test("coupon schema migration is rollback-compatible and non-destructive to data", async () => {
  const client = createClient();

  const result = await runCouponSchemaMigration(client);
  const sql = client.queries.map(({ sql: statement }) => statement).join("\n");

  assert.deepEqual(result, { applied: true, key: "coupon-schema-v1" });
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS coupons/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS coupon_id/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS coupon_redemptions/);
  assert.match(sql, /INSERT INTO coupon_schema_migrations/);

  assert.doesNotMatch(sql, /DROP\s+TABLE/i);
  assert.doesNotMatch(sql, /DROP\s+COLUMN/i);
  assert.doesNotMatch(sql, /TRUNCATE/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM/i);
});

test("coupon schema migration becomes a no-op after its migration key is recorded", async () => {
  const client = createClient({ alreadyApplied: true });

  const result = await runCouponSchemaMigration(client);
  const sql = client.queries.map(({ sql: statement }) => statement).join("\n");

  assert.deepEqual(result, { applied: false, key: "coupon-schema-v1" });
  assert.doesNotMatch(sql, /ALTER TABLE purchases/);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS coupons/);
});

test("coupon site publication migration adds a non-destructive publish flag", async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM coupon_schema_migrations")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const result = await runCouponSitePublishMigration(client);
  const sql = queries.map(({ sql: statement }) => statement).join("\n");

  assert.deepEqual(result, {
    applied: true,
    key: "coupon-site-publish-v1",
  });
  assert.match(sql, /ADD COLUMN IF NOT EXISTS published_on_site/);
  assert.match(sql, /idx_coupons_published_on_site/);
  assert.doesNotMatch(sql, /DROP\s+TABLE/i);
  assert.doesNotMatch(sql, /DROP\s+COLUMN/i);
  assert.doesNotMatch(sql, /TRUNCATE/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM/i);
});
