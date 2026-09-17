import assert from "node:assert/strict";
import test from "node:test";
import { getFreeUsageAllowance } from "../src/free-usage-service.js";

test("free usage allowance decreases per installation", () => {
  assert.deepEqual(getFreeUsageAllowance(1, 0), {
    installation_count: 1,
    used_count: 0,
    allowed_total: 5,
    remaining: 5,
    blocked: false,
  });

  assert.deepEqual(getFreeUsageAllowance(2, 0), {
    installation_count: 2,
    used_count: 5,
    allowed_total: 9,
    remaining: 4,
    blocked: false,
  });

  assert.equal(getFreeUsageAllowance(3, 0).remaining, 3);
  assert.equal(getFreeUsageAllowance(4, 0).remaining, 2);
  assert.equal(getFreeUsageAllowance(5, 0).remaining, 1);
  assert.equal(getFreeUsageAllowance(6, 0).remaining, 0);
  assert.equal(getFreeUsageAllowance(6, 0).blocked, true);
});

test("reinstalling early never restores unused allowance from an older installation", () => {
  assert.equal(getFreeUsageAllowance(2, 1).remaining, 4);
  assert.equal(getFreeUsageAllowance(3, 6).remaining, 3);
});

test("free usage blocks once the current allowance is consumed", () => {
  const status = getFreeUsageAllowance(2, 9);
  assert.equal(status.remaining, 0);
  assert.equal(status.blocked, true);
});
