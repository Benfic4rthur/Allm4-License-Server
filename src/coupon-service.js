import { ensureCouponStorage } from "./coupon-schema.js";
import { getPool } from "./db.js";

export class CouponValidationError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "CouponValidationError";
    this.reason = reason;
  }
}

export function normalizeCouponCode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,40}$/.test(normalized)) return null;
  return normalized;
}

export function calculateCouponPricing({
  baseAmountCents,
  discountType,
  discountValue,
}) {
  if (!Number.isInteger(baseAmountCents) || baseAmountCents <= 0) {
    throw new TypeError("Invalid base amount");
  }
  if (!Number.isInteger(discountValue) || discountValue <= 0) {
    throw new TypeError("Invalid discount value");
  }

  let discountAmountCents;
  if (discountType === "percent") {
    if (discountValue > 100) {
      throw new TypeError("Invalid percentage discount");
    }
    discountAmountCents = Math.round(
      (baseAmountCents * discountValue) / 100,
    );
  } else if (discountType === "fixed") {
    discountAmountCents = discountValue;
  } else {
    throw new TypeError("Invalid discount type");
  }

  discountAmountCents = Math.min(baseAmountCents, discountAmountCents);

  return {
    original_amount_cents: baseAmountCents,
    discount_amount_cents: discountAmountCents,
    final_amount_cents: baseAmountCents - discountAmountCents,
  };
}

function assertCouponAvailable(
  coupon,
  {
    reservedCount = 0,
    emailUsageCount = 0,
    now = new Date(),
  } = {},
) {
  if (!coupon) {
    throw new CouponValidationError("coupon_not_found");
  }
  if (!coupon.active) {
    throw new CouponValidationError("coupon_inactive");
  }

  const startsAt = coupon.starts_at ? new Date(coupon.starts_at) : null;
  const expiresAt = coupon.expires_at ? new Date(coupon.expires_at) : null;

  if (startsAt && now < startsAt) {
    throw new CouponValidationError("coupon_not_started");
  }
  if (expiresAt && now >= expiresAt) {
    throw new CouponValidationError("coupon_expired");
  }

  const usedCount = Number(coupon.used_count ?? 0);
  const maxUses =
    coupon.max_uses === null || coupon.max_uses === undefined
      ? null
      : Number(coupon.max_uses);
  if (
    maxUses !== null &&
    usedCount + Number(reservedCount) >= maxUses
  ) {
    throw new CouponValidationError("coupon_usage_limit_reached");
  }

  const maxUsesPerEmail =
    coupon.max_uses_per_email === null ||
    coupon.max_uses_per_email === undefined
      ? null
      : Number(coupon.max_uses_per_email);
  if (
    maxUsesPerEmail !== null &&
    Number(emailUsageCount) >= maxUsesPerEmail
  ) {
    throw new CouponValidationError("coupon_email_limit_reached");
  }
}

function mapCoupon(coupon) {
  return {
    id: coupon.id,
    code: coupon.code,
    discount_type: coupon.discount_type,
    discount_value: coupon.discount_value,
    starts_at: coupon.starts_at ?? null,
    expires_at: coupon.expires_at ?? null,
    max_uses: coupon.max_uses ?? null,
    max_uses_per_email: coupon.max_uses_per_email ?? null,
  };
}

async function getUsageCounts(client, couponId, payerEmail) {
  const usage = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'reserved') AS reserved_count,
       COUNT(*) FILTER (
         WHERE payer_email = $2
           AND status IN ('reserved', 'redeemed')
       ) AS email_usage_count
     FROM coupon_redemptions
     WHERE coupon_id = $1`,
    [couponId, payerEmail],
  );

  return {
    reservedCount: Number(usage.rows[0]?.reserved_count ?? 0),
    emailUsageCount: Number(usage.rows[0]?.email_usage_count ?? 0),
  };
}

export async function previewCoupon({
  couponCode,
  payerEmail,
  baseAmountCents,
}) {
  await ensureCouponStorage();
  const code = normalizeCouponCode(couponCode);
  if (!code) {
    throw new CouponValidationError("invalid_coupon_code");
  }

  const client = getPool();
  const selected = await client.query(
    `SELECT id, code, discount_type, discount_value, active, starts_at,
            expires_at, max_uses, used_count, max_uses_per_email
     FROM coupons
     WHERE code = $1`,
    [code],
  );
  const coupon = selected.rows[0] ?? null;
  if (!coupon) {
    throw new CouponValidationError("coupon_not_found");
  }

  const usage = await getUsageCounts(client, coupon.id, payerEmail);
  assertCouponAvailable(coupon, usage);

  return {
    coupon: mapCoupon(coupon),
    pricing: calculateCouponPricing({
      baseAmountCents,
      discountType: coupon.discount_type,
      discountValue: coupon.discount_value,
    }),
  };
}

export async function lockCouponForPurchase(
  client,
  {
    couponCode,
    payerEmail,
    baseAmountCents,
  },
) {
  const code = normalizeCouponCode(couponCode);
  if (!code) {
    throw new CouponValidationError("invalid_coupon_code");
  }

  const selected = await client.query(
    `SELECT id, code, discount_type, discount_value, active, starts_at,
            expires_at, max_uses, used_count, max_uses_per_email
     FROM coupons
     WHERE code = $1
     FOR UPDATE`,
    [code],
  );
  const coupon = selected.rows[0] ?? null;
  if (!coupon) {
    throw new CouponValidationError("coupon_not_found");
  }

  const usage = await getUsageCounts(client, coupon.id, payerEmail);
  assertCouponAvailable(coupon, usage);

  return {
    coupon: mapCoupon(coupon),
    pricing: calculateCouponPricing({
      baseAmountCents,
      discountType: coupon.discount_type,
      discountValue: coupon.discount_value,
    }),
  };
}

export async function recordCouponRedemption(
  client,
  {
    couponId,
    purchaseId,
    payerEmail,
    redeemed = false,
  },
) {
  const status = redeemed ? "redeemed" : "reserved";
  await client.query(
    `INSERT INTO coupon_redemptions (
       coupon_id, purchase_id, payer_email, status, redeemed_at
     )
     VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'redeemed' THEN NOW() ELSE NULL END)`,
    [couponId, purchaseId, payerEmail, status],
  );

  if (redeemed) {
    await client.query(
      `UPDATE coupons
       SET used_count = used_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [couponId],
    );
  }
}

export async function finalizeCouponRedemption(
  client,
  {
    purchaseId,
    purchaseStatus,
  },
) {
  const selected = await client.query(
    `SELECT r.id, r.status, r.coupon_id
     FROM coupon_redemptions r
     JOIN coupons c ON c.id = r.coupon_id
     WHERE r.purchase_id = $1
     FOR UPDATE OF r, c`,
    [purchaseId],
  );
  const redemption = selected.rows[0];
  if (!redemption) {
    return { updated: false, status: null };
  }

  if (purchaseStatus === "approved") {
    if (redemption.status === "redeemed") {
      return { updated: false, status: "redeemed" };
    }

    await client.query(
      `UPDATE coupon_redemptions
       SET status = 'redeemed',
           redeemed_at = COALESCE(redeemed_at, NOW()),
           released_at = NULL
       WHERE id = $1`,
      [redemption.id],
    );
    await client.query(
      `UPDATE coupons
       SET used_count = used_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [redemption.coupon_id],
    );
    return { updated: true, status: "redeemed" };
  }

  if (
    redemption.status === "reserved" &&
    ["rejected", "cancelled", "refunded", "charged_back"].includes(
      purchaseStatus,
    )
  ) {
    await client.query(
      `UPDATE coupon_redemptions
       SET status = 'released', released_at = NOW()
       WHERE id = $1`,
      [redemption.id],
    );
    return { updated: true, status: "released" };
  }

  return { updated: false, status: redemption.status };
}
