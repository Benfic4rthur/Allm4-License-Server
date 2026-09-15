import { createHash, randomBytes } from "node:crypto";

const LICENSE_PREFIX = "ALLM4";
const LICENSE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LICENSE_GROUPS = 5;
const LICENSE_GROUP_SIZE = 5;
const LICENSE_RANDOM_LENGTH = LICENSE_GROUPS * LICENSE_GROUP_SIZE;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function generateLicenseKey() {
  const bytes = randomBytes(LICENSE_RANDOM_LENGTH);
  let body = "";

  for (const byte of bytes) {
    body += LICENSE_ALPHABET[byte & 31];
  }

  const groups = [];
  for (let index = 0; index < body.length; index += LICENSE_GROUP_SIZE) {
    groups.push(body.slice(index, index + LICENSE_GROUP_SIZE));
  }

  return `${LICENSE_PREFIX}-${groups.join("-")}`;
}

export function normalizeLicenseKey(value) {
  if (typeof value !== "string") {
    return null;
  }

  const compact = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const expectedLength = LICENSE_PREFIX.length + LICENSE_RANDOM_LENGTH;

  if (compact.length !== expectedLength || !compact.startsWith(LICENSE_PREFIX)) {
    return null;
  }

  const body = compact.slice(LICENSE_PREFIX.length);
  if (![...body].every((character) => LICENSE_ALPHABET.includes(character))) {
    return null;
  }

  return compact;
}

export function hashLicenseKey(value) {
  const normalized = normalizeLicenseKey(value);
  return normalized ? sha256(normalized) : null;
}

export function normalizeDeviceId(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 256) {
    return null;
  }

  return normalized;
}

export function hashDeviceId(value) {
  const normalized = normalizeDeviceId(value);
  return normalized ? sha256(normalized) : null;
}

export function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
