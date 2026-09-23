import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("admin sales expose original price, paid amount and coupon definition", () => {
  const source = fs.readFileSync(
    path.join(root, "src/admin-dashboard-service.js"),
    "utf8",
  );

  assert.match(source, /original_amount_cents/);
  assert.match(source, /discount_amount_cents/);
  assert.match(source, /amount_cents/);
  assert.match(source, /coupon_discount_type/);
  assert.match(source, /coupon_discount_value/);
  assert.match(source, /c\.discount_type AS coupon_discount_type/);
  assert.match(source, /c\.discount_value AS coupon_discount_value/);
});
