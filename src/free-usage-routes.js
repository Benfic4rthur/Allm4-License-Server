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

function validCounter(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1000000;
}

router.post("/free-usage/sync", async (req, res) => {
  const body = getObjectBody(req);
  const deviceId = normalizeDeviceId(body.device_id);
  const isV2 = body.chat_used !== undefined || body.image_used !== undefined || body.project_used !== undefined;
  const chatUsed = isV2 ? body.chat_used : 0;
  const imageUsed = isV2 ? body.image_used : 0;
  const projectUsed = isV2 ? body.project_used : 0;
  const fields = {};

  if (!deviceId) fields.device_id = "invalid";
  if (isV2) {
    if (!validCounter(chatUsed)) fields.chat_used = "must_be_non_negative_integer";
    if (!validCounter(imageUsed)) fields.image_used = "must_be_non_negative_integer";
    if (!validCounter(projectUsed)) fields.project_used = "must_be_non_negative_integer";
  } else {
    if (!Number.isInteger(body.installation_count) || body.installation_count < 1) {
      fields.installation_count = "must_be_positive_integer";
    }
    if (!validCounter(body.used_count)) fields.used_count = "must_be_non_negative_integer";
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
      chatUsed,
      imageUsed,
      projectUsed,
    });
    if (!isV2) {
      freeUsage.installation_count = 1;
      freeUsage.used_count = 0;
    }
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
