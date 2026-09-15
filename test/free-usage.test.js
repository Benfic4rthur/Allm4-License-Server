import assert from "node:assert/strict";
import test from "node:test";
import { getFreeUsageAllowance } from "../src/free-usage-service.js";

test("free usage allowance decreases by installation and stops growing after the fifth", () => {
  assert.deepEqual(getFreeUsageAllowance(1, 0), {
    installation_count: 1,
    used_count: 0,
    allowed_total: 5,
    remaining: 5,
    blocked: false,
  });
  assert.equal(getFreeUsageAllowance(2, 0).allowed_total, 9);
  assert.equal(getFreeUsageAllowance(3, 0).allowed_total, 12);
  assert.equal(getFreeUsageAllowance(4, 0).allowed_total, 14);
  assert.equal(getFreeUsageAllowance(5, 0).allowed_total, 15);
  assert.equal(getFreeUsageAllowance(6, 0).allowed_total, 15);
});

test("free usage blocks once the accumulated allowance is consumed", () => {
  const status = getFreeUsageAllowance(2, 9);
  assert.equal(status.remaining, 0);
  assert.equal(status.blocked, true);
});
