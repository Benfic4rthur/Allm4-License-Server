import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateCouponPricing,
  finalizeCouponRedemption,
  normalizeCouponCode,
} from "../src/coupon-service.js";

test("normalizes coupon codes without accepting unsafe formats", () => {
  assert.equal(normalizeCouponCode(" desc20 "), "DESC20");
  assert.equal(normalizeCouponCode("PROMO_100"), "PROMO_100");
  assert.equal(normalizeCouponCode("ab"), null);
  assert.equal(normalizeCouponCode("DESC 20"), null);
  assert.equal(normalizeCouponCode(null), null);
});

test("calculates percentage discounts on the server price", () => {
  assert.deepEqual(
    calculateCouponPricing({
      baseAmountCents: 4999,
      discountType: "percent",
      discountValue: 20,
    }),
    {
      original_amount_cents: 4999,
      discount_amount_cents: 1000,
      final_amount_cents: 3999,
    },
  );
});

test("supports 100 percent coupons without producing a negative price", () => {
  assert.deepEqual(
    calculateCouponPricing({
      baseAmountCents: 4999,
      discountType: "percent",
      discountValue: 100,
    }),
    {
      original_amount_cents: 4999,
      discount_amount_cents: 4999,
      final_amount_cents: 0,
    },
  );

  assert.deepEqual(
    calculateCouponPricing({
      baseAmountCents: 4999,
      discountType: "fixed",
      discountValue: 9999,
    }),
    {
      original_amount_cents: 4999,
      discount_amount_cents: 4999,
      final_amount_cents: 0,
    },
  );
});

function createFinalizeClient(status = "reserved") {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });

      if (sql.includes("FROM coupon_redemptions r")) {
        return {
          rows: [
            {
              id: "redemption-1",
              status,
              coupon_id: "coupon-1",
            },
          ],
        };
      }

      if (sql.includes("UPDATE coupon_redemptions")) {
        return { rows: [] };
      }

      if (sql.includes("UPDATE coupons")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

test("redeems a reserved coupon exactly when purchase becomes approved", async () => {
  const client = createFinalizeClient();

  const result = await finalizeCouponRedemption(client, {
    purchaseId: "purchase-1",
    purchaseStatus: "approved",
  });

  assert.deepEqual(result, { updated: true, status: "redeemed" });
  assert.equal(
    client.queries.some(({ sql }) => sql.includes("used_count = used_count + 1")),
    true,
  );
});

test("releases a reserved coupon when payment is cancelled", async () => {
  const client = createFinalizeClient();

  const result = await finalizeCouponRedemption(client, {
    purchaseId: "purchase-1",
    purchaseStatus: "cancelled",
  });

  assert.deepEqual(result, { updated: true, status: "released" });
  assert.equal(
    client.queries.some(({ sql }) => sql.includes("released_at = NOW()")),
    true,
  );
  assert.equal(
    client.queries.some(({ sql }) => sql.includes("used_count = used_count + 1")),
    false,
  );
});
