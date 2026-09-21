import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { normalizeDeviceId, SecurityConfigurationError } from "./security.js";

const TOKEN_PREFIX = "ALLM4L1";
const MANAGEMENT_TOKEN_PREFIX = "ALLM4M1";
const TOKEN_ISSUER = "allm4-license-server";
const TOKEN_KEY_ID = "primary-v1";
const TOKEN_VERSION = 1;

function readKeyMaterial(variableName) {
  const raw = process.env[variableName]?.trim();
  if (!raw) {
    throw new SecurityConfigurationError(variableName);
  }

  if (raw.includes("-----BEGIN")) {
    return raw.replaceAll("\\n", "\n");
  }

  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8").trim();
    if (!decoded.includes("-----BEGIN")) {
      throw new Error("decoded key is not PEM");
    }
    return decoded;
  } catch {
    throw new SecurityConfigurationError(variableName);
  }
}

function getPrivateKey() {
  try {
    return createPrivateKey(readKeyMaterial("LICENSE_PRIVATE_KEY"));
  } catch (error) {
    if (error instanceof SecurityConfigurationError) {
      throw error;
    }
    throw new SecurityConfigurationError("LICENSE_PRIVATE_KEY");
  }
}

function getPublicKey() {
  try {
    return createPublicKey(readKeyMaterial("LICENSE_PUBLIC_KEY"));
  } catch (error) {
    if (error instanceof SecurityConfigurationError) {
      throw error;
    }
    throw new SecurityConfigurationError("LICENSE_PUBLIC_KEY");
  }
}

function encodeBase64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return buffer.toString("base64url");
}

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url");
}

function parsePayload(encodedPayload) {
  try {
    const parsed = JSON.parse(decodeBase64Url(encodedPayload).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function isOfflineSigningConfigured() {
  const hasPrivate = Boolean(process.env.LICENSE_PRIVATE_KEY?.trim());
  const hasPublic = Boolean(process.env.LICENSE_PUBLIC_KEY?.trim());

  if (hasPrivate !== hasPublic) {
    throw new SecurityConfigurationError(
      hasPrivate ? "LICENSE_PUBLIC_KEY" : "LICENSE_PRIVATE_KEY",
    );
  }

  return hasPrivate && hasPublic;
}

export function createDeviceBinding(deviceId) {
  const normalized = normalizeDeviceId(deviceId);
  if (!normalized) {
    throw new TypeError("Invalid device id");
  }

  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function issueOfflineLicenseToken({
  licenseId,
  deviceId,
  licenseIssuedAt,
  issuedAt = new Date(),
}) {
  if (typeof licenseId !== "string" || !licenseId.trim()) {
    throw new TypeError("Invalid license id");
  }

  const payload = {
    v: TOKEN_VERSION,
    iss: TOKEN_ISSUER,
    kid: TOKEN_KEY_ID,
    license_id: licenseId,
    license_type: "lifetime",
    device_binding: createDeviceBinding(deviceId),
    license_issued_at: new Date(licenseIssuedAt).toISOString(),
    issued_at: new Date(issuedAt).toISOString(),
  };

  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signingInput = `${TOKEN_PREFIX}.${encodedPayload}`;
  const signature = sign(null, Buffer.from(signingInput, "utf8"), getPrivateKey());

  return `${signingInput}.${encodeBase64Url(signature)}`;
}

export function verifyOfflineLicenseToken(token, { deviceId } = {}) {
  if (typeof token !== "string") {
    return { valid: false, error: "invalid_token" };
  }

  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    return { valid: false, error: "invalid_token" };
  }

  const [, encodedPayload, encodedSignature] = parts;
  const payload = parsePayload(encodedPayload);
  if (!payload) {
    return { valid: false, error: "invalid_payload" };
  }

  const signingInput = `${TOKEN_PREFIX}.${encodedPayload}`;
  let signatureValid = false;

  try {
    signatureValid = verify(
      null,
      Buffer.from(signingInput, "utf8"),
      getPublicKey(),
      decodeBase64Url(encodedSignature),
    );
  } catch {
    return { valid: false, error: "invalid_signature" };
  }

  if (!signatureValid) {
    return { valid: false, error: "invalid_signature" };
  }

  if (
    payload.v !== TOKEN_VERSION ||
    payload.iss !== TOKEN_ISSUER ||
    payload.kid !== TOKEN_KEY_ID ||
    payload.license_type !== "lifetime" ||
    typeof payload.license_id !== "string" ||
    typeof payload.device_binding !== "string" ||
    typeof payload.issued_at !== "string" ||
    typeof payload.license_issued_at !== "string"
  ) {
    return { valid: false, error: "invalid_claims" };
  }

  if (deviceId !== undefined) {
    let expectedBinding;
    try {
      expectedBinding = createDeviceBinding(deviceId);
    } catch {
      return { valid: false, error: "device_mismatch" };
    }

    if (payload.device_binding !== expectedBinding) {
      return { valid: false, error: "device_mismatch" };
    }
  }

  return {
    valid: true,
    payload,
  };
}

export function issueManagementToken({
  licenseId,
  deviceId,
  issuedAt = new Date(),
}) {
  if (typeof licenseId !== "string" || !licenseId.trim()) {
    throw new TypeError("Invalid license id");
  }

  const payload = {
    v: TOKEN_VERSION,
    iss: TOKEN_ISSUER,
    kid: TOKEN_KEY_ID,
    scope: "device_management",
    license_id: licenseId,
    device_binding: createDeviceBinding(deviceId),
    issued_at: new Date(issuedAt).toISOString(),
  };

  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signingInput = `${MANAGEMENT_TOKEN_PREFIX}.${encodedPayload}`;
  const signature = sign(null, Buffer.from(signingInput, "utf8"), getPrivateKey());

  return `${signingInput}.${encodeBase64Url(signature)}`;
}

export function verifyManagementToken(
  token,
  { licenseId = undefined, deviceId = undefined } = {},
) {
  if (typeof token !== "string") {
    return { valid: false, error: "invalid_token" };
  }

  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== MANAGEMENT_TOKEN_PREFIX) {
    return { valid: false, error: "invalid_token" };
  }

  const [, encodedPayload, encodedSignature] = parts;
  const payload = parsePayload(encodedPayload);
  if (!payload) {
    return { valid: false, error: "invalid_payload" };
  }

  const signingInput = `${MANAGEMENT_TOKEN_PREFIX}.${encodedPayload}`;
  let signatureValid = false;

  try {
    signatureValid = verify(
      null,
      Buffer.from(signingInput, "utf8"),
      getPublicKey(),
      decodeBase64Url(encodedSignature),
    );
  } catch {
    return { valid: false, error: "invalid_signature" };
  }

  if (!signatureValid) {
    return { valid: false, error: "invalid_signature" };
  }

  if (
    payload.v !== TOKEN_VERSION ||
    payload.iss !== TOKEN_ISSUER ||
    payload.kid !== TOKEN_KEY_ID ||
    payload.scope !== "device_management" ||
    typeof payload.license_id !== "string" ||
    typeof payload.device_binding !== "string" ||
    typeof payload.issued_at !== "string"
  ) {
    return { valid: false, error: "invalid_claims" };
  }

  if (licenseId !== undefined && payload.license_id !== licenseId) {
    return { valid: false, error: "license_mismatch" };
  }

  if (deviceId !== undefined) {
    let expectedBinding;
    try {
      expectedBinding = createDeviceBinding(deviceId);
    } catch {
      return { valid: false, error: "device_mismatch" };
    }

    if (payload.device_binding !== expectedBinding) {
      return { valid: false, error: "device_mismatch" };
    }
  }

  return {
    valid: true,
    payload,
  };
}

export function maybeIssueOfflineLicenseToken(input) {
  if (!isOfflineSigningConfigured()) {
    return null;
  }
  return issueOfflineLicenseToken(input);
}

export function maybeIssueManagementToken(input) {
  if (!isOfflineSigningConfigured()) {
    return null;
  }
  return issueManagementToken(input);
}
