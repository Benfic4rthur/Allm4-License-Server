import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  buildMercadoPagoWebhookManifest,
  validateMercadoPagoWebhookSignature,
} from "../src/mercado-pago.js";
import {
  inspectMercadoPagoOrder,
  mapMercadoPagoOrderStatus,
} from "../src/purchase-service.js";

process.env.MERCADO_PAGO_WEBHOOK_SECRET = "test-webhook-secret";

test("builds Mercado Pago webhook manifest preserving data id case", () => {
  const manifest = buildMercadoPagoWebhookManifest({
    dataId: "ORD01ABCDEF",
    xRequestId: "request-123",
    timestamp: "1742505638683",
  });

  assert.equal(
    manifest,
    "id:ORD01ABCDEF;request-id:request-123;ts:1742505638683;",
  );
});

test("validates a Mercado Pago webhook HMAC signature preserving data id case", () => {
  const dataId = "ORD01ABCDEF";
  const xRequestId = "request-123";
  const timestamp = "1742505638683";
  const manifest =
    "id:ORD01ABCDEF;request-id:request-123;ts:1742505638683;";
  const hash = createHmac(
    "sha256",
    process.env.MERCADO_PAGO_WEBHOOK_SECRET,
  )
    .update(manifest, "utf8")
    .digest("hex");

  assert.equal(
    validateMercadoPagoWebhookSignature({
      xSignature: `ts=${timestamp},v1=${hash}`,
      xRequestId,
      dataId,
    }),
    true,
  );
});

test("rejects a Mercado Pago webhook when signed data is altered", () => {
  const timestamp = "1742505638683";
  const manifest =
    "id:ORD01ABCDEF;request-id:request-123;ts:1742505638683;";
  const hash = createHmac(
    "sha256",
    process.env.MERCADO_PAGO_WEBHOOK_SECRET,
  )
    .update(manifest, "utf8")
    .digest("hex");

  assert.equal(
    validateMercadoPagoWebhookSignature({
      xSignature: `ts=${timestamp},v1=${hash}`,
      xRequestId: "request-123",
      dataId: "ORD01TAMPERED",
    }),
    false,
  );
});

test("maps Orders API statuses to local purchase statuses", () => {
  assert.equal(
    mapMercadoPagoOrderStatus({
      status: "processed",
      status_detail: "accredited",
    }),
    "approved",
  );
  assert.equal(mapMercadoPagoOrderStatus({ status: "processing" }), "pending");
  assert.equal(mapMercadoPagoOrderStatus({ status: "failed" }), "rejected");
  assert.equal(mapMercadoPagoOrderStatus({ status: "expired" }), "cancelled");
  assert.equal(mapMercadoPagoOrderStatus({ status: "refunded" }), "refunded");
  assert.equal(
    mapMercadoPagoOrderStatus({ status: "charged_back" }),
    "charged_back",
  );
});

test("accepts only the expected Allm4 order amount, currency and reference", () => {
  const order = {
    id: "ORD01ABCDEF",
    external_reference: "allm4_123e4567-e89b-42d3-a456-426614174000",
    total_amount: "9.99",
    currency: "BRL",
    status: "processed",
    status_detail: "accredited",
  };

  assert.deepEqual(inspectMercadoPagoOrder(order), {
    valid: true,
    orderId: "ORD01ABCDEF",
    purchaseId: "123e4567-e89b-42d3-a456-426614174000",
    purchaseStatus: "approved",
    amountCents: 999,
    currency: "BRL",
  });

  assert.deepEqual(inspectMercadoPagoOrder({ ...order, total_amount: "10.00" }), {
    valid: false,
    reason: "unexpected_amount_or_currency",
  });
});
