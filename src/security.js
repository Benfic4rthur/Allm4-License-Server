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
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function formatLicenseBody(bytes) {
  let body = "";
  for (let index = 0; index < LICENSE_BODY_LENGTH; index += 1) {
    body += LICENSE_ALPHABET[bytes[index] & 31];
  }
  const groups = body.match(new RegExp(`.{${LICENSE_GROUP_SIZE}}`, "g"));
  return `${LICENSE_PREFIX}-${groups.join("-")}`;
}

function constantTimeStringEquals(left, right) {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function normalizePurchaseId(purchaseId) {
  const normalized = typeof purchaseId === "string" ? purchaseId.trim().toLowerCase() : "";
  if (!UUID_PATTERN.test(normalized)) {
    throw new TypeError("Invalid purchase id");
  }
  return normalized;
}

export function generateLicenseKey() {
  return formatLicenseBody(randomBytes(LICENSE_BODY_LENGTH));
}

export function derivePurchaseLicenseKey(purchaseId) {
  const normalizedPurchaseId = normalizePurchaseId(purchaseId);
  const secret = getRequiredSecret("LICENSE_HASH_SECRET");
  const digest = createHmac("sha256", secret)
    .update(`purchase-license-key:${normalizedPurchaseId}`, "utf8")
    .digest();
  return formatLicenseBody(digest);
}

export function derivePurchaseLookupToken(purchaseId) {
  const normalizedPurchaseId = normalizePurchaseId(purchaseId);
  const secret = getRequiredSecret("LICENSE_HASH_SECRET");
  return createHmac("sha256", secret)
    .update(`purchase-lookup-token:${normalizedPurchaseId}`, "utf8")
    .digest("base64url");
}

export function verifyPurchaseLookupToken(purchaseId, candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return false;
  let expected;
  try {
    expected = derivePurchaseLookupToken(purchaseId);
  } catch {
    return false;
  }
  return constantTimeStringEquals(candidate.trim(), expected);
}

export function normalizeLicenseKey(value) {
  if (typeof value !== "string") return null;
  const compact = value.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!compact.startsWith(LICENSE_PREFIX)) return null;
  const body = compact.slice(LICENSE_PREFIX.length);
  if (!LICENSE_BODY_PATTERN.test(body)) return null;
  const groups = body.match(new RegExp(`.{${LICENSE_GROUP_SIZE}}`, "g"));
  return `${LICENSE_PREFIX}-${groups.join("-")}`;
}

export function normalizeDeviceId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 256) return null;
  if(/[\u0000-\u001F\u007F]/.test(normalized)) return null;
  return normalized;
}

export function hashLicenseKey(value) {
  const normalized = normalizeLicenseKey(value);
  if (!normalized) throw new TypeError("Invalid license key");
  return hmac("license", normalized);
}

export function hashDeviceId(value) {
  const normalized = normalizeDeviceId(value);
  if (!normalized) throw new TypeError("Invalid device id");
  return hmac("device", normalized);
}

export function hashRequestIp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return hmac("ip", value.trim());
}

export function verifyAdminSecret(candidate) {
  const expected = getRequiredSecret("ADMIN_SECRET");
  const received = typeof candidate === "string" ? candidate.trim() : "";
  return received.length > 0 && constantTimeStringEquals(received, expected);
}

export function verifyBugMaintainerSecret(candidate) {
  const expected = getRequiredSecret("BUG_MAINTAINER_SECRET");
  const received = typeof candidate === "string" ? candidate.trim() : "";
  return received.length > 0 && constantTimeStringEquals(received, expected);
}

export function hashBugTrackingToken(value) {
  const token = typeof value === "string" ? value.trim() : "";
  if (token.length < 24 || token.length > 256) {
    throw new TypeError("Invalid bug tracking token");
  }
  const secret = getRequiredSecret("BUG_REPORT_SECRET");
  return createHmac("sha256", secret)
    .update(`bug-tracking:${token}`, "utf8")
    .digest("hex");
}

export function generateBugTrackingToken() {
  return randomBytes(32).toString("base64url");
}
