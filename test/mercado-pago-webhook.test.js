import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  buildMercadoPagoWebhookManifest,
  getMercadoPagoWebhookSignatureDiagnostics,
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

test("validates a Mercado Pago webhook HMAC signature using lowercase data id compatibility", () => {
  const dataId = "ORD01ABCDEF";
  const xRequestId = "request-123";
  const timestamp = "1742505638683";
  const manifest =
    "id:ord01abcdef;request-id:request-123;ts:1742505638683;";
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

test("webhook signature diagnostics expose manifests but not secrets or full hashes", () => {
  const dataId = "ORD01ABCDEF";
  const xRequestId = "request-123";
  const timestamp = "1742505638683";
  const manifest =
    "id:ORD01ABCDEF;request-id:request-123;ts:1742505638683;";
  const lowercaseManifest =
    "id:ord01abcdef;request-id:request-123;ts:1742505638683;";
  const withoutRequestIdManifest = "id:ORD01ABCDEF;ts:1742505638683;";
  const lowercaseWithoutRequestIdManifest =
    "id:ord01abcdef;ts:1742505638683;";
  const hash = createHmac(
    "sha256",
    process.env.MERCADO_PAGO_WEBHOOK_SECRET,
  )
    .update(manifest, "utf8")
    .digest("hex");

  const diagnostics = getMercadoPagoWebhookSignatureDiagnostics({
    xSignature: `ts=${timestamp},v1=${hash}`,
    xRequestId,
    dataId,
  });
  const serialized = JSON.stringify(diagnostics);

  assert.equal(diagnostics.signature_format_valid, true);
  assert.equal(diagnostics.exact_manifest, manifest);
  assert.equal(diagnostics.lowercase_manifest, lowercaseManifest);
  assert.equal(
    diagnostics.exact_without_request_id_manifest,
    withoutRequestIdManifest,
  );
  assert.equal(
    diagnostics.lowercase_without_request_id_manifest,
    lowercaseWithoutRequestIdManifest,
  );
  assert.equal(diagnostics.received_v1_prefix, hash.slice(0, 12));
  assert.equal(diagnostics.computed_exact_prefix, hash.slice(0, 12));
  assert.equal(diagnostics.secret_fingerprint.length, 12);
  assert.equal(serialized.includes(process.env.MERCADO_PAGO_WEBHOOK_SECRET), false);
  assert.equal(serialized.includes(hash), false);
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

test("accepts persisted Allm4 prices up to the base amount, currency and reference", () => {
  const order = {
    id: "ORD01ABCDEF",
    external_reference: "allm4_123e4567-e89b-42d3-a456-426614174000",
    total_amount: "49.99",
    currency: "BRL",
    status: "processed",
    status_detail: "accredited",
  };

  assert.deepEqual(inspectMercadoPagoOrder(order), {
    valid: true,
    orderId: "ORD01ABCDEF",
    purchaseId: "123e4567-e89b-42d3-a456-426614174000",
    purchaseStatus: "approved",
    amountCents: 4999,
    currency: "BRL",
  });

  assert.deepEqual(
    inspectMercadoPagoOrder({ ...order, total_amount: "39.99" }),
    {
      valid: true,
      orderId: "ORD01ABCDEF",
      purchaseId: "123e4567-e89b-42d3-a456-426614174000",
      purchaseStatus: "approved",
      amountCents: 3999,
      currency: "BRL",
    },
  );

  assert.deepEqual(inspectMercadoPagoOrder({ ...order, total_amount: "50.00" }), {
    valid: false,
    reason: "unexpected_amount_or_currency",
  });
});
