import express from "express";
import { MercadoPagoApiError } from "./mercado-pago.js";
import {
  createPixPurchase,
  getPurchaseStatusForClient,
} from "./purchase-service.js";
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

function sendError(res, error) {
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

router.post("/purchases/pix", async (req, res) => {
  try {
    const body = getObjectBody(req);
    const payerEmail = normalizeEmail(body.payer_email);
    const payerFirstName = normalizeOptionalFirstName(body.payer_first_name);
    const fields = {};
    if (!payerEmail) fields.payer_email = "invalid";
    if (payerFirstName.error) fields.payer_first_name = payerFirstName.error;
    if (Object.keys(fields).length > 0) {
      return res.status(400).json({ ok: false, error: "invalid_request", fields });
    }
    const created = await createPixPurchase({
      payerEmail,
      payerFirstName: payerFirstName.value,
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
    const purchase = await getPurchaseStatusForClient({
      purchaseId: req.params.purchaseId,
      lookupToken,
    });
    if (!purchase) {
      return res.status(404).json({ ok: false, error: "purchase_not_found" });
    }
    return res.status(200).json({ ok: true, purchase });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
