import express from "express";
import {
  CouponAdminValidationError,
  createAdminCoupon,
  listAdminCoupons,
  updateAdminCoupon,
} from "./coupon-admin-service.js";
import {
  SecurityConfigurationError,
  verifyAdminSecret,
} from "./security.js";

const router = express.Router();

function getObjectBody(req) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return {};
  }
  return req.body;
}

function adminSecret(req) {
  const direct = req.get("x-admin-secret");
  if (direct && direct.trim()) return direct.trim();

  const authorization = req.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice(7).trim();
  }
  return "";
}

function sendError(res, error) {
  if (error instanceof SecurityConfigurationError) {
    console.error("[Coupon Admin API] required server secret is not configured", {
      variable: error.variableName,
    });
    return res.status(503).json({ ok: false, error: "server_not_configured" });
  }

  if (error instanceof CouponAdminValidationError) {
    const status = error.reason === "coupon_not_found" ? 404 : 400;
    return res.status(status).json({
      ok: false,
      error: error.reason,
      ...(Object.keys(error.fields || {}).length > 0
        ? { fields: error.fields }
        : {}),
    });
  }

  console.error("[Coupon Admin API] unexpected error", error);
  return res.status(500).json({ ok: false, error: "internal_error" });
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

router.get("/admin/coupons", requireAdmin, async (_req, res) => {
  try {
    const coupons = await listAdminCoupons();
    return res.status(200).json({ ok: true, coupons });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/admin/coupons", requireAdmin, async (req, res) => {
  try {
    const coupon = await createAdminCoupon(getObjectBody(req));
    return res.status(201).json({ ok: true, coupon });
  } catch (error) {
    return sendError(res, error);
  }
});

router.patch("/admin/coupons/:couponId", requireAdmin, async (req, res) => {
  try {
    const coupon = await updateAdminCoupon(
      req.params.couponId,
      getObjectBody(req),
    );
    return res.status(200).json({ ok: true, coupon });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
