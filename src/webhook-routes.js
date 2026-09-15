import express from "express";
import {
  getMercadoPagoOrder,
  getMercadoPagoWebhookSignatureDiagnostics,
  MercadoPagoApiError,
  validateMercadoPagoWebhookSignature,
} from "./mercado-pago.js";
import { syncMercadoPagoPurchaseFromOrder } from "./purchase-service.js";
import { SecurityConfigurationError } from "./security.js";

const router = express.Router();

function getSingleString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

export function isMercadoPagoSandboxOrderNotification({
  dataId,
  bodyDataId,
  liveMode,
  type,
}) {
  return (
    liveMode === false &&
    type === "order" &&
    typeof dataId === "string" &&
    /^ORDTST[A-Z0-9]+$/.test(dataId) &&
    bodyDataId === dataId
  );
}

function sendError(res, error) {
  if (error instanceof SecurityConfigurationError) {
    console.error("[Mercado Pago webhook] required server secret is not configured", {
      variable: error.variableName,
    });
    return res.status(503).json({
      ok: false,
      error: "server_not_configured",
    });
  }

  if (error instanceof MercadoPagoApiError) {
    console.error("[Mercado Pago webhook] provider lookup failed", {
      status: error.status,
      payload: error.payload,
    });
    return res.status(502).json({
      ok: false,
      error: "payment_provider_error",
      provider_status: error.status,
    });
  }

  console.error("[Mercado Pago webhook] unexpected error", error);
  return res.status(500).json({
    ok: false,
    error: "internal_error",
  });
}

router.post("/webhooks/mercado-pago", async (req, res) => {
  const xSignature = getSingleString(req.get("x-signature"));
  const xRequestId = getSingleString(req.get("x-request-id"));
  const dataId = getSingleString(req.query["data.id"]);
  const type = getSingleString(req.query.type) ?? getSingleString(req.body?.type);
  const bodyDataId = getSingleString(req.body?.data?.id);
  const liveMode = req.body?.live_mode;

  if (!dataId) {
    return res.status(400).json({
      ok: false,
      error: "missing_order_id",
    });
  }

  try {
    const signatureValid = validateMercadoPagoWebhookSignature({
      xSignature,
      xRequestId,
      dataId,
    });
    const sandboxProviderFallback =
      !signatureValid &&
      isMercadoPagoSandboxOrderNotification({
        dataId,
        bodyDataId,
        liveMode,
        type,
      });

    if (!signatureValid) {
      console.warn(
        "[Mercado Pago webhook] invalid signature",
        getMercadoPagoWebhookSignatureDiagnostics({
          xSignature,
          xRequestId,
          dataId,
        }),
      );

      if (!sandboxProviderFallback) {
        return res.status(401).json({
          ok: false,
          error: "invalid_signature",
        });
      }

      console.warn(
        "[Mercado Pago webhook] sandbox signature mismatch, requiring provider verification",
        {
          request_id: xRequestId,
          order_id: dataId,
        },
      );
    }

    if (type && type !== "order") {
      console.info("[Mercado Pago webhook] ignored non-order event", {
        request_id: xRequestId,
        type,
      });
      return res.status(200).json({
        ok: true,
        received: true,
        ignored: true,
      });
    }

    const order = await getMercadoPagoOrder(dataId);
    if (order?.id !== dataId) {
      console.error("[Mercado Pago webhook] provider returned a different order id", {
        request_id: xRequestId,
        requested_order_id: dataId,
        returned_order_id: order?.id ?? null,
      });
      return res.status(502).json({
        ok: false,
        error: "payment_provider_mismatch",
      });
    }

    const synchronized = await syncMercadoPagoPurchaseFromOrder(order);

    if (synchronized.ignored) {
      console.warn("[Mercado Pago webhook] order ignored", {
        request_id: xRequestId,
        order_id: dataId,
        reason: synchronized.reason,
      });
    } else {
      console.info("[Mercado Pago webhook] purchase synchronized", {
        request_id: xRequestId,
        order_id: dataId,
        updated: synchronized.updated,
        purchase_status: synchronized.purchase?.status ?? null,
        license_issued: synchronized.license_issued ?? false,
        license_id: synchronized.license?.id ?? null,
        verification: sandboxProviderFallback
          ? "sandbox_provider_lookup"
          : "webhook_hmac",
      });
    }

    return res.status(200).json({
      ok: true,
      received: true,
      synchronized: !synchronized.ignored,
      updated: synchronized.updated,
      license_issued: synchronized.license_issued ?? false,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
