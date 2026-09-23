import assert from "node:assert/strict";
import test from "node:test";
import { runProductSettingsMigration } from "../src/product-settings-schema.js";
import {
  ProductSettingsValidationError,
  normalizeAlmaProductPriceInput,
} from "../src/product-settings-service.js";

function createClient() {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };
}

test("product settings migration creates Alma price storage non-destructively", async () => {
  const client = createClient();
  await runProductSettingsMigration(client);
  const sql = client.queries.map(({ sql: statement }) => statement).join("\n");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS product_settings/);
  assert.match(sql, /VALUES \('alma', \$1, 'BRL'\)/);
  assert.doesNotMatch(sql, /DROP\s+TABLE/i);
  assert.doesNotMatch(sql, /TRUNCATE/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM/i);
});

test("product price accepts integer cents and rejects invalid values", () => {
  assert.equal(normalizeAlmaProductPriceInput({ price_cents: 7990 }), 7990);

  for (const value of [0, -1, 1.5, "abc", 1000001]) {
    assert.throws(
      () => normalizeAlmaProductPriceInput({ price_cents: value }),
      (error) => error instanceof ProductSettingsValidationError,
    );
  }
});
