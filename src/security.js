import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const LICENSE_PREFIX = "ALLM4";
const LICENSE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LICENSE_GROUP_SIZE = 4;
const LICENSE_GROUP_COUNT = 7;
const LICENSE_BODY_LENGTH = LICENSE_GROUP_SIZE * LICENSE_GROUP_COUNT;
const LICENSE_BODY_PATTERN = new RegExp(
  `^[A-HJ-NP-Z2-9]{${LICENSE_BODY_LENGTH}}$`,
);

export class SecurityConfigurationError extends Error {
  constructor(variableName) {
    super(`${variableName} is not configured securely`);
    this.name = "SecurityConfigurationError";
    this.code = "server_not_configured";
    this.variableName = variableName;
  }
}

function getRequiredSecret(variableName, minimumLength = 32) {
  const value = process.env[variableName]?.trim();
  if (!value || value.length < minimumLength) {
    throw new SecurityConfigurationError(variableName);
  }
  return value;
}

function hmac(scope, value) {
  const secret = getRequiredSecret("LICENSE_HASH_SECRET");
  return createHmac("sha256", secret)
    .update(`${scope}:${value}`, "utf8")
    .digest("hex");
}

function constantTimeStringEquals(left, right) {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function generateLicenseKey() {
  const bytes = randomBytes(LICENSE_BODY_LENGTH);
  let body = "";

  for (let index = 0; index < bytes.length; index += 1) {
    body += LICENSE_ALPHABET[bytes[index] & 31];
  }

  const groups = body.match(new RegExp(`.{${LICENSE_GROUP_SIZE}}`, "g"));
  return `${LICENSE_PREFIX}-${groups.join("-")}`;
}

export function normalizeLicenseKey(value) {
  if (typeof value !== "string") {
    return null;
  }

  const compact = value.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!compact.startsWith(LICENSE_PREFIX)) {
    return null;
  }

  const body = compact.slice(LICENSE_PREFIX.length);
  if (!LICENSE_BODY_PATTERN.test(body)) {
    return null;
  }

  const groups = body.match(new RegExp(`.{${LICENSE_GROUP_SIZE}}`, "g"));
  return `${LICENSE_PREFIX}-${groups.join("-")}`;
}

export function normalizeDeviceId(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 256) {
    return null;
  }

  if(/[\u0000-\u001F\u007F]/.test(normalized)) {
    return null;
  }

  return normalized;
}

export function hashLicenseKey(value) {
  const normalized = normalizeLicenseKey(value);
  if (!normalized) {
    throw new TypeError("Invalid license key");
  }
  return hmac("license", normalized);
}

export function hashDeviceId(value) {
  const normalized = normalizeDeviceId(value);
  if (!normalized) {
    throw new TypeError("Invalid device id");
  }
  return hmac("device", normalized);
}

export function hashRequestIp(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return hmac("ip", value.trim());
}

export function verifyAdminSecret(candidate) {
  const expected = getRequiredSecret("ADMIN_SECRET");
  const received = typeof candidate === "string" ? candidate.trim() : "";
  return received.length > 0 && constantTimeStringEquals(received, expected);
}
