import express from "express";
import { requireAdmin } from "./admin-auth.js";
import {
  activateLicense,
  createLicense,
  deactivateDevice,
  revokeLicense,
  validateLicense,
} from "./license-service.js";
import { isUuid, normalizeDeviceId, normalizeLicenseKey } from "./license-utils.js";

const router = express.Router();

function bodyObject(req, res) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    res.status(400).json({ ok: false, error: "invalid_json_body" });
    return null;
  }
  return req.body;
}

function optionalText(value, maxLength) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    return undefined;
  }
  return normalized;
}

function parseLicenseAndDevice(body, res) {
  const licenseKey = normalizeLicenseKey(body.license_key);
  if (!licenseKey) {
    res.status(400).json({ ok: false, error: "invalid_license_key" });
    return null;
  }

  const deviceId = normalizeDeviceId(body.device_id);
  if (!deviceId) {
    res.status(400).json({ ok: false, error: "invalid_device_id" });
    return null;
  }

  return { licenseKey, deviceId };
}

function sendServiceResult(res, result) {
  const { httpStatus = 200, ...payload } = result;
  return res.status(httpStatus).json(payload);
}

router.post("/api/licenses/activate", async (req, res) => {
  const body = bodyObject(req, res);
  if (!body) return;

  const credentials = parseLicenseAndDevice(body, res);
  if (!credentials) return;

  const deviceName = optionalText(body.device_name, 120);
  const platform = optionalText(body.platform, 64);
  if (deviceName === undefined || platform === undefined) {
    return res.status(400).json({ ok: false, error: "invalid_device_metadata" });
  }

  const result = await activateLicense({
    ...credentials,
    deviceName,
    platform,
  });
  return sendServiceResult(res, result);
});

router.post("/api/licenses/validate", async (req, res) => {
  const body = bodyObject(req, res);
  if (!body) return;

  const credentials = parseLicenseAndDevice(body, res);
  if (!credentials) return;

  const result = await validateLicense(credentials);
  return sendServiceResult(res, result);
});

router.post("/api/licenses/deactivate", async (req, res) => {
  const body = bodyObject(req, res);
  if (!body) return;

  const credentials = parseLicenseAndDevice(body, res);
  if (!credentials) return;

  const result = await deactivateDevice(credentials);
  return sendServiceResult(res, result);
});

router.post("/api/admin/licenses", requireAdmin, async (req, res) => {
  const body = bodyObject(req, res);
  if (!body) return;

  const maxDevices = body.max_devices ?? 3;
  if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 10) {
    return res.status(400).json({ ok: false, error: "invalid_max_devices" });
  }

  const license = await createLicense({ maxDevices });
  return res.status(201).json({
    ok: true,
    ...license,
    warning: "license_key_is_returned_once",
  });
});

router.post("/api/admin/licenses/:licenseId/revoke", requireAdmin, async (req, res) => {
  const { licenseId } = req.params;
  if (!isUuid(licenseId)) {
    return res.status(400).json({ ok: false, error: "invalid_license_id" });
  }

  const body = bodyObject(req, res);
  if (!body) return;

  const reason = optionalText(body.reason, 500);
  if (reason === undefined) {
    return res.status(400).json({ ok: false, error: "invalid_revoke_reason" });
  }

  const result = await revokeLicense({ licenseId, reason });
  return sendServiceResult(res, result);
});

export default router;
