import express from "express";
import {
  ProductSettingsValidationError,
  getAlmaProductSettings,
  updateAlmaProductPrice,
} from "./product-settings-service.js";
import {
  SecurityConfigurationError,
  verifyAdminSecret,
} from "./security.js";

const router = express.Router();

function adminSecret(req) {
  const direct = req.get("x-admin-secret");
  if (direct && direct.trim()) return direct.trim();
  const authorization = req.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice(7).trim();
  }
  return "";
}

function requireAdmin(req, res, next) {
  try {
    if (!verifyAdminSecret(adminSecret(req))) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    return next();
  } catch (error) {
    return sendError(res, error);
  }
}

function sendError(res, error) {
  if (error instanceof SecurityConfigurationError) {
    return res.status(503).json({ ok: false, error: "server_not_configured" });
  }
  if (error instanceof ProductSettingsValidationError) {
    return res.status(400).json({
      ok: false,
      error: error.reason,
      fields: error.fields,
    });
  }
  console.error("[Product Admin API] unexpected error", error);
  return res.status(500).json({ ok: false, error: "internal_error" });
}

router.get("/admin/product", requireAdmin, async (_req, res) => {
  try {
    const product = await getAlmaProductSettings();
    return res.status(200).json({ ok: true, product });
  } catch (error) {
    return sendError(res, error);
  }
});

router.patch("/admin/product", requireAdmin, async (req, res) => {
  try {
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body
        : {};
    const product = await updateAlmaProductPrice(body);
    return res.status(200).json({ ok: true, product });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
