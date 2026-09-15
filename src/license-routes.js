import express from "express";
import {
  activateLicense,
  deactivateLicense,
  issueLicense,
  LicenseServiceError,
  revokeLicense,
  validateLicense,
} from "./license-service.js";
import { maybeIssueOfflineLicenseToken } from "./license-token.js";
import {
  normalizeDeviceId,
  normalizeLicenseKey,
  SecurityConfigurationError,
  verifyAdminSecret,
} from "./security.js";

const router = express.Router();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getObjectBody(req) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return {};
  }
  return req.body;
}

function normalizeOptionalText(value, maxLength) {
  if (value === undefined || value === null || value === "") {
    return { value: null };
  }

  if (typeof value !== "string") {
    return { error: "must_be_string" };
  }

  const normalized = value.trim();
  if (!normalized) {
    return { value: null };
  }

  if (normalized.length > maxLength) {
    return { error: "too_long" };
  }

  return { value: normalized };
}

function parseDeviceRequest(req) {
  const body = getObjectBody(req);
  const licenseKey = normalizeLicenseKey(body.license_key);
  const deviceId = normalizeDeviceId(body.device_id);
  const deviceName = normalizeOptionalText(body.device_name, 160);
  const platform = normalizeOptionalText(body.platform, 80);
  const fields = {};

  if (!licenseKey) {
    fields.license_key = "invalid";
  }
  if (!deviceId) {
    fields.device_id = "invalid";
  }
  if (deviceName.error) {
    fields.device_name = deviceName.error;
  }
  if (platform.error) {
    fields.platform = platform.error;
  }

  if (Object.keys(fields).length > 0) {
    return { error: fields };
  }

  return {
    value: {
      licenseKey,
      deviceId,
      deviceName: deviceName.value,
      platform: platform.value,
      requestIp: getRequestIp(req),
    },
  };
}

function getRequestIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.trim();
  }

  return req.ip || req.socket?.remoteAddress || null;
}

function extractAdminSecret(req) {
  const headerSecret = req.headers["x-admin-secret"];
  if (typeof headerSecret === "string" && headerSecret.trim()) {
    return headerSecret;
  }

  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice(7);
  }

  return "";
}

function requireAdmin(req, res, next) {
  try {
    if (!verifyAdminSecret(extractAdminSecret(req))) {
      return res.status(401).json({
        ok: false,
        error: "unauthorized",
      });
    }

    return next();
  } catch (error) {
    return sendError(res, error);
  }
}

function attachOfflineLicense(result, deviceId) {
  const token = maybeIssueOfflineLicenseToken({
    licenseId: result.license.id,
    deviceId,
    licenseIssuedAt: result.license.issued_at,
  });

  return {
    ...result,
    offline_ready: Boolean(token),
    offline_token: token,
  };
}

function sendError(res, error) {
  if (error instanceof LicenseServiceError) {
    const payload = {
      ok: false,
      error: error.code,
    };

    if (error.details) {
      payload.details = error.details;
    }

    return res.status(error.status).json(payload);
  }

  if (error instanceof SecurityConfigurationError) {
    console.error("[License API] required server secret is not configured", {
      variable: error.variableName,
    });
    return res.status(503).json({
      ok: false,
      error: "server_not_configured",
    });
  }

  console.error("[License API] unexpected error", error);
  return res.status(500).json({
    ok: false,
    error: "internal_error",
  });
}

router.post("/admin/licenses", requireAdmin, async (req, res) => {
  try {
    const body = getObjectBody(req);
    const maxDevices = body.max_devices ?? 3;

    if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 10) {
      return res.status(400).json({
        ok: false,
        error: "invalid_request",
        fields: { max_devices: "must_be_integer_between_1_and_10" },
      });
    }

    const issued = await issueLicense({ maxDevices });
    return res.status(201).json({
      ok: true,
      license: {
        ...issued.license,
        license_key: issued.license_key,
      },
      license_key_returned_once: true,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/admin/licenses/:licenseId/revoke", requireAdmin, async (req, res) => {
  try {
    const { licenseId } = req.params;
    if (!UUID_PATTERN.test(licenseId)) {
      return res.status(400).json({
        ok: false,
        error: "invalid_request",
        fields: { license_id: "invalid" },
      });
    }

    const body = getObjectBody(req);
    const reason = normalizeOptionalText(body.reason, 500);
    if (reason.error) {
      return res.status(400).json({
        ok: false,
        error: "invalid_request",
        fields: { reason: reason.error },
      });
    }

    const revoked = await revokeLicense({
      licenseId,
      reason: reason.value,
    });

    return res.status(200).json({
      ok: true,
      ...revoked,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/licenses/activate", async (req, res) => {
  try {
    const parsed = parseDeviceRequest(req);
    if (parsed.error) {
      return res.status(400).json({
        ok: false,
        error: "invalid_request",
        fields: parsed.error,
      });
    }

    const activated = await activateLicense(parsed.value);
    return res.status(200).json({
      ok: true,
      ...attachOfflineLicense(activated, parsed.value.deviceId),
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/licenses/validate", async (req, res) => {
  try {
    const parsed = parseDeviceRequest(req);
    if (parsed.error) {
      return res.status(400).json({
        ok: false,
        error: "invalid_request",
        fields: parsed.error,
      });
    }

    const validated = await validateLicense(parsed.value);
    return res.status(200).json({
      ok: true,
      ...attachOfflineLicense(validated, parsed.value.deviceId),
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/licenses/deactivate", async (req, res) => {
  try {
    const parsed = parseDeviceRequest(req);
    if (parsed.error) {
      return res.status(400).json({
        ok: false,
        error: "invalid_request",
        fields: parsed.error,
      });
    }

    const deactivated = await deactivateLicense({
      licenseKey: parsed.value.licenseKey,
      deviceId: parsed.value.deviceId,
      requestIp: parsed.value.requestIp,
    });

    return res.status(200).json({
      ok: true,
      ...deactivated,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
