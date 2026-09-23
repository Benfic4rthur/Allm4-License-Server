import express from "express";
import {
  CouponValidationError,
  previewCoupon,
} from "./coupon-service.js";
import { MercadoPagoApiError } from "./mercado-pago.js";
import {
  createPixPurchase,
  getPurchaseStatusForClient,
} from "./purchase-service.js";
import { getAlmaProductPriceCents } from "./product-settings-service.js";
import { SecurityConfigurationError } from "./security.js";

const router = express.Router();

function getObjectBody(req) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return {};
  }
  return req.body;
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

function normalizeOptionalFirstName(value) {
  if (value === undefined || value === null || value === "") return { value: null };
  if (typeof value !== "string") return { error: "must_be_string" };
  const normalized = value.trim();
  if (!normalized) return { value: null };
  if (normalized.length > 80) return { error: "too_long" };
  return { value: normalized };
}

function normalizeOptionalCouponCode(value) {
  if (value === undefined || value === null || value === "") return { value: null };
  if (typeof value !== "string") return { error: "must_be_string" };
  const normalized = value.trim();
  if (!normalized) return { value: null };
  if (normalized.length > 40) return { error: "too_long" };
  return { value: normalized };
}

function publicCoupon(coupon) {
  return {
    code: coupon.code,
    discount_type: coupon.discount_type,
    discount_value: coupon.discount_value,
    starts_at: coupon.starts_at,
    expires_at: coupon.expires_at,
    max_uses: coupon.max_uses,
    max_uses_per_email: coupon.max_uses_per_email,
  };
}

function sendError(res, error) {
  if (error instanceof CouponValidationError) {
    return res.status(400).json({
      ok: false,
      error: "invalid_coupon",
      reason: error.reason,
    });
  }
  if (error instanceof SecurityConfigurationError) {
    console.error("[Purchase API] required server secret is not configured", {
      variable: error.variableName,
    });
    return res.status(503).json({ ok: false, error: "server_not_configured" });
  }
  if (error instanceof MercadoPagoApiError) {
    console.error("[Purchase API] Mercado Pago request failed", {
      status: error.status,
      payload: error.payload,
    });
    return res.status(502).json({
      ok: false,
      error: "payment_provider_error",
      provider_status: error.status,
    });
  }
  console.error("[Purchase API] unexpected error", error);
  return res.status(500).json({ ok: false, error: "internal_error" });
}

router.post("/coupons/validate", async (req, res) => {
  try {
    const body = getObjectBody(req);
    const payerEmail = normalizeEmail(body.payer_email);
    const couponCode = normalizeOptionalCouponCode(body.coupon_code);
    const fields = {};

    if (!payerEmail) fields.payer_email = "invalid";
    if (!couponCode.value) {
      fields.coupon_code = couponCode.error ?? "required";
    }

    if (Object.keys(fields).length > 0) {
      return res.status(400).json({ ok: false, error: "invalid_request", fields });
    }

    const result = await previewCoupon({
      couponCode: couponCode.value,
      payerEmail,
      baseAmountCents: await getAlmaProductPriceCents(),
    });

    return res.status(200).json({
      ok: true,
      coupon: publicCoupon(result.coupon),
      pricing: result.pricing,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/purchases/pix", async (req, res) => {
  try {
    const body = getObjectBody(req);
    const payerEmail = normalizeEmail(body.payer_email);
    const payerFirstName = normalizeOptionalFirstName(body.payer_first_name);
    const couponCode = normalizeOptionalCouponCode(body.coupon_code);
    const fields = {};

    if (!payerEmail) fields.payer_email = "invalid";
    if (payerFirstName.error) fields.payer_first_name = payerFirstName.error;
    if (couponCode.error) fields.coupon_code = couponCode.error;

    if (Object.keys(fields).length > 0) {
      return res.status(400).json({ ok: false, error: "invalid_request", fields });
    }

    const created = await createPixPurchase({
      payerEmail,
      payerFirstName: payerFirstName.value,
      couponCode: couponCode.value,
    });
    return res.status(201).json({ ok: true, ...created });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/purchases/:purchaseId", async (req, res) => {
  try {
    const lookupToken =
      typeof req.query.lookup_token === "string" ? req.query.lookup_token.trim() : "";
    const result = await getPurchaseStatusForClient({
      purchaseId: req.params.purchaseId,
      lookupToken,
    });
    if (!result.ok) {
      console.warn("[Purchase API] purchase status lookup rejected", {
        purchase_id: req.params.purchaseId,
        reason: result.reason,
      });
      return res.status(404).json({ ok: false, error: "purchase_not_found" });
    }
    return res.status(200).json({ ok: true, purchase: result.purchase });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
