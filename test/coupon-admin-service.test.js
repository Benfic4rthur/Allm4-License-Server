import assert from "node:assert/strict";
import test from "node:test";
import {
  CouponAdminValidationError,
  normalizeCouponCreateInput,
  normalizeCouponUpdateInput,
} from "../src/coupon-admin-service.js";

test("coupon admin create defaults to active and one use per email", () => {
  const result = normalizeCouponCreateInput({
    code: "lancamento20",
    discount_type: "percent",
    discount_value: 20,
  });

  assert.deepEqual(result, {
    code: "LANCAMENTO20",
    discount_type: "percent",
    discount_value: 20,
    active: true,
    starts_at: null,
    expires_at: null,
    max_uses: null,
    max_uses_per_email: 1,
  });
});

test("coupon admin accepts controlled 100 percent coupons", () => {
  const result = normalizeCouponCreateInput({
    code: "CORTESIA100",
    discount_type: "percent",
    discount_value: 100,
    max_uses: 1,
    max_uses_per_email: 1,
    active: false,
  });

  assert.equal(result.code, "CORTESIA100");
  assert.equal(result.discount_value, 100);
  assert.equal(result.max_uses, 1);
  assert.equal(result.max_uses_per_email, 1);
  assert.equal(result.active, false);
});

test("coupon admin rejects percentage over 100", () => {
  assert.throws(
    () =>
      normalizeCouponCreateInput({
        code: "INVALIDO",
        discount_type: "percent",
        discount_value: 101,
      }),
    (error) => {
      assert.ok(error instanceof CouponAdminValidationError);
      assert.equal(error.fields.discount_value, "percent_must_be_at_most_100");
      return true;
    },
  );
});

test("coupon admin validates expiration after start", () => {
  assert.throws(
    () =>
      normalizeCouponCreateInput({
        code: "PRAZO20",
        discount_type: "percent",
        discount_value: 20,
        starts_at: "2026-10-10T12:00:00.000Z",
        expires_at: "2026-10-09T12:00:00.000Z",
      }),
    (error) => {
      assert.ok(error instanceof CouponAdminValidationError);
      assert.equal(error.fields.expires_at, "must_be_after_starts_at");
      return true;
    },
  );
});

test("coupon admin update only exposes operational fields", () => {
  const result = normalizeCouponUpdateInput({
    active: false,
    expires_at: null,
    max_uses: 50,
    max_uses_per_email: 1,
    code: "IGNORED",
    discount_value: 99,
  });

  assert.deepEqual(result, {
    active: false,
    expires_at: null,
    max_uses: 50,
    max_uses_per_email: 1,
  });
});

test("coupon admin update rejects empty patch", () => {
  assert.throws(
    () => normalizeCouponUpdateInput({}),
    (error) => {
      assert.ok(error instanceof CouponAdminValidationError);
      assert.equal(error.fields.body, "no_supported_fields");
      return true;
    },
  );
});
