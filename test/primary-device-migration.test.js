import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("primary device schema migration uses a valid PostgreSQL dollar quote", () => {
  const schema = read("db/schema.sql");
  const service = read("src/license-service.js");

  assert.match(schema, /DO \$allm4\$/);
  assert.match(schema, /END \$allm4\$;/);
  assert.match(service, /DO \$allm4\$/);
  assert.match(service, /END \$allm4\$;/);

  assert.doesNotMatch(schema, /DO \$\n/);
  assert.doesNotMatch(service, /DO \$\n/);
});

test("unassigned license fallback prefers the most recently seen active device", () => {
  const schema = read("db/schema.sql");
  const service = read("src/license-service.js");

  for (const source of [schema, service]) {
    assert.match(source, /CASE WHEN d\.deactivated_at IS NULL THEN 0 ELSE 1 END/);
    assert.match(source, /d\.last_seen_at DESC/);
    assert.match(source, /d\.first_activated_at DESC/);
  }
});


test("purchased licenses are repaired once from the original activation", () => {
  const schema = read("db/schema.sql");
  const service = read("src/license-service.js");

  for (const source of [schema, service]) {
    assert.match(source, /primary-device-purchase-origin-v2/);
    assert.match(source, /a\.event_type = 'activated'/);
    assert.match(source, /ORDER BY a\.created_at ASC/);
    assert.match(source, /l\.purchase_id IS NOT NULL/);
  }
});
