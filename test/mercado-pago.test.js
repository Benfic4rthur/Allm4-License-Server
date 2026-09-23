import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPixOrderPayload,
  createPixOrder,
  extractPixDetails,
  formatAmountFromCents,
  searchMercadoPagoPaymentsByExternalReference,
} from "../src/mercado-pago.js";

process.env.MERCADO_PAGO_ACCESS_TOKEN = "APP_USR-test-token";

test("formats Allm4 price in BRL decimal format", () => {
  assert.equal(formatAmountFromCents(999), "9.99");
});

test("builds Mercado Pago Orders payload for Pix", () => {
  const payload = buildPixOrderPayload({
    amountCents: 999,
    externalReference: "allm4_purchase_123",
    payerEmail: "buyer@example.com",
    payerFirstName: "Arthur",
  });

  assert.equal(payload.type, "online");
  assert.equal(payload.total_amount, "9.99");
  assert.equal(payload.external_reference, "allm4_purchase_123");
  assert.equal(payload.processing_mode, "automatic");
  assert.equal(payload.payer.email, "buyer@example.com");
  assert.equal(payload.payer.first_name, "Arthur");
  assert.equal(payload.transactions.payments[0].amount, "9.99");
  assert.equal(payload.transactions.payments[0].payment_method.id, "pix");
  assert.equal(
    payload.transactions.payments[0].payment_method.type,
    "bank_transfer",
  );
  assert.equal(payload.transactions.payments[0].expiration_time, "PT30M");
});

test("creates Pix order with authorization and idempotency headers", async () => {
  let capturedUrl;
  let capturedOptions;

  const order = await createPixOrder({
    amountCents: 999,
    externalReference: "allm4_purchase_456",
    payerEmail: "buyer@example.com",
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            id: "ORD_TEST_123",
            status: "action_required",
            status_detail: "waiting_transfer",
            transactions: {
              payments: [
                {
                  id: "PAY_TEST_123",
                  status: "action_required",
                  status_detail: "waiting_transfer",
                  payment_method: {
                    id: "pix",
                    type: "bank_transfer",
                    qr_code: "000201-test",
                    qr_code_base64: "base64-test",
                    ticket_url: "https://example.com/ticket",
                  },
                },
              ],
            },
          }),
      };
    },
  });

  assert.equal(capturedUrl, "https://api.mercadopago.com/v1/orders");
  assert.equal(capturedOptions.method, "POST");
  assert.equal(
    capturedOptions.headers.Authorization,
    "Bearer APP_USR-test-token",
  );
  assert.match(
    capturedOptions.headers["X-Idempotency-Key"],
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );

  const sentBody = JSON.parse(capturedOptions.body);
  assert.equal(sentBody.total_amount, "9.99");
  assert.equal(sentBody.payer.email, "buyer@example.com");

  const pix = extractPixDetails(order);
  assert.equal(pix.order_id, "ORD_TEST_123");
  assert.equal(pix.qr_code, "000201-test");
  assert.equal(pix.qr_code_base64, "base64-test");
  assert.equal(pix.ticket_url, "https://example.com/ticket");
});


test("searches payments by external reference for Orders API reconciliation", async () => {
  let capturedUrl;
  const result = await searchMercadoPagoPaymentsByExternalReference(
    "allm4_12345678-1234-4234-8234-123456789abc",
    {
      fetchImpl: async (url) => {
        capturedUrl = url;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              paging: { total: 1 },
              results: [{ id: 123456789, status: "approved" }],
            }),
        };
      },
    },
  );

  const url = new URL(capturedUrl);
  assert.equal(url.pathname, "/v1/payments/search");
  assert.equal(
    url.searchParams.get("external_reference"),
    "allm4_12345678-1234-4234-8234-123456789abc",
  );
  assert.equal(url.searchParams.get("sort"), "date_created");
  assert.equal(url.searchParams.get("criteria"), "desc");
  assert.equal(result.results[0].id, 123456789);
});
