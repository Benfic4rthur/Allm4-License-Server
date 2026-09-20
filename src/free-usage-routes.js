import express from "express";
import { syncFreeUsage } from "./free-usage-service.js";
import {
  normalizeDeviceId,
  SecurityConfigurationError,
} from "./security.js";

const router = express.Router();

function getObjectBody(req) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return {};
  }
  return req.body;
}

function validInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

router.post("/free-usage/sync", async (req, res) => {
  const body = getObjectBody(req);
  const deviceId = normalizeDeviceId(body.device_id);
  const installationCount = body.installation_count;
  const usedCount = body.used_count;
  const fields = {};

  if (!deviceId) {
    fields.device_id = "invalid";
  }
  if (!validInteger(installationCount, 1, 1000)) {
    fields.installation_count = "must_be_integer_between_1_and_1000";
  }
  if (!validInteger(usedCount, 0, 1000000)) {
    fields.used_count = "must_be_integer_between_0_and_1000000";
  }

  if (Object.keys(fields).length > 0) {
    return res.status(400).json({
      ok: false,
      error: "invalid_request",
      fields,
    });
  }

  try {
    const freeUsage = await syncFreeUsage({
      deviceId,
      installationCount,
      usedCount,
    });
    return res.status(200).json({
      ok: true,
      free_usage: freeUsage,
    });
  } catch (error) {
    if (error instanceof SecurityConfigurationError) {
      console.error("[Free Usage API] required server secret is not configured", {
        variable: error.variableName,
      });
      return res.status(503).json({
        ok: false,
        error: "server_not_configured",
      });
    }

    console.error("[Free Usage API] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
    });
  }
});

export default router;
