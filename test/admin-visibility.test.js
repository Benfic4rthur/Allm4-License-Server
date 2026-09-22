import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(process.cwd());
const visibility = fs.readFileSync(
  path.join(root, "src", "admin-visibility-schema.js"),
  "utf8",
);
const dashboard = fs.readFileSync(
  path.join(root, "src", "admin-dashboard-service.js"),
  "utf8",
);

test("prelaunch cleanup preserves the three declared real purchases", () => {
  assert.match(visibility, /natacha-inacio@hotmail\.com/);
  assert.match(visibility, /arthur_benfica@hotmail\.com/);
  assert.match(visibility, /2026-09-21 00:25:00/);
  assert.match(visibility, /2026-09-15 18:11:00/);
  assert.match(visibility, /2026-09-15 18:16:00/);
  assert.match(visibility, /amount_cents = 4999/);
  assert.match(visibility, /amount_cents = 999/);
});

test("admin dashboard hides archived purchases by default", () => {
  assert.match(dashboard, /includeArchived = false/);
  assert.match(dashboard, /admin_archived_at IS NULL/);
  assert.match(dashboard, /setAdminSaleArchived/);
});

test("reconciliation excludes archived test purchases", () => {
  assert.match(
    dashboard,
    /status = 'approved'[\s\S]*admin_archived_at IS NULL[\s\S]*net_received_amount_cents IS NULL/,
  );
});


test("legacy paid purchases are resolved without being counted as pending", () => {
  assert.match(visibility, /admin_financial_resolved_at/);
  assert.match(visibility, /resolve-preserved-legacy-finance-2026-09-22-v1/);
  assert.match(dashboard, /net_unavailable_count/);
  assert.match(
    dashboard,
    /admin_financial_resolved_at IS NULL[\s\S]*net_received_amount_cents IS NULL/,
  );
});
