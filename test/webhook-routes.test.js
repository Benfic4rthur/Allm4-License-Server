import assert from "node:assert/strict";
import test from "node:test";
import { isMercadoPagoSandboxOrderNotification } from "../src/webhook-routes.js";

const valid = {
  dataId: "ORDTST01M2K1WRC09Z4R8CWS5Y1CQZ0W",
  bodyDataId: "ORDTST01M2K1WRC09Z4R8CWS5Y1CQZ0W",
  liveMode: false,
  type: "order",
};

test("allows provider verification fallback only for matching Mercado Pago sandbox Orders", () => {
  assert.equal(isMercadoPagoSandboxOrderNotification(valid), true);
});

test("does not allow sandbox fallback for production notifications", () => {
  assert.equal(
    isMercadoPagoSandboxOrderNotification({ ...valid, liveMode: true }),
    false,
  );
});

test("does not allow sandbox fallback when query and body order ids differ", () => {
  assert.equal(
    isMercadoPagoSandboxOrderNotification({
      ...valid,
      bodyDataId: "ORDTST01DIFFERENT",
    }),
    false,
  );
});

test("does not allow sandbox fallback for non-test order ids or non-order topics", () => {
  assert.equal(
    isMercadoPagoSandboxOrderNotification({
      ...valid,
      dataId: "ORD01PRODUCTION",
      bodyDataId: "ORD01PRODUCTION",
    }),
    false,
  );
  assert.equal(
    isMercadoPagoSandboxOrderNotification({ ...valid, type: "payment" }),
    false,
  );
});
