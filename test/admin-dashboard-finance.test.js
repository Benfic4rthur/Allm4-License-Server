import assert from "node:assert/strict";
import test from "node:test";
import {
  extractMercadoPagoOrderPaymentId,
  inspectMercadoPagoPaymentFinancials,
} from "../src/mercado-pago.js";

test("prefers the processed payment reference id from Orders API", () => {
  assert.equal(
    extractMercadoPagoOrderPaymentId({
      transactions: {
        payments: [
          {
            id: "PAY01J49MMW3SSBK5PSV3DFR32959",
            reference_id: "123456789",
          },
        ],
      },
    }),
    "123456789",
  );
});

test("does not send PAY transaction ids to legacy Payments API", () => {
  assert.equal(
    extractMercadoPagoOrderPaymentId({
      transactions: {
        payments: [{ id: "PAY01J49MMW3SSBK5PSV3DFR32959" }],
      },
    }),
    null,
  );
});

test("keeps numeric order payment ids as a compatibility fallback", () => {
  assert.equal(
    extractMercadoPagoOrderPaymentId({
      transactions: { payments: [{ id: 123456789 }] },
    }),
    "123456789",
  );
});

test("uses the real Mercado Pago net received amount and fee", () => {
  const result = inspectMercadoPagoPaymentFinancials({
    id: 123456789,
    transaction_amount: 49.99,
    transaction_details: {
      net_received_amount: 49.5,
    },
    fee_details: [
      {
        type: "mercadopago_fee",
        fee_payer: "collector",
        amount: 0.49,
      },
    ],
  });

  assert.deepEqual(result, {
    valid: true,
    paymentId: "123456789",
    transactionAmountCents: 4999,
    netReceivedAmountCents: 4950,
    providerFeeCents: 49,
  });
});

test("uses gross minus net as the exact total deducted amount", () => {
  const result = inspectMercadoPagoPaymentFinancials({
    id: "pay-1",
    transaction_amount: "9.99",
    transaction_details: {
      net_received_amount: "9.91",
    },
  });

  assert.equal(result.valid, true);
  assert.equal(result.transactionAmountCents, 999);
  assert.equal(result.netReceivedAmountCents, 991);
  assert.equal(result.providerFeeCents, 8);
});

test("rejects payment finance data without net_received_amount", () => {
  assert.deepEqual(
    inspectMercadoPagoPaymentFinancials({
      id: "pay-2",
      transaction_amount: 49.99,
    }),
    {
      valid: false,
      reason: "missing_net_received_amount",
    },
  );
});
