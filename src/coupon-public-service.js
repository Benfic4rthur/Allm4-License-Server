import { ensureCouponStorage } from "./coupon-schema.js";
import { getPool } from "./db.js";

function publicSiteCoupon(row) {
  return {
    code: row.code,
    discount_type: row.discount_type,
    discount_value: Number(row.discount_value),
    starts_at: row.starts_at ?? null,
    expires_at: row.expires_at ?? null,
  };
}

export async function listPublishedSiteCoupons() {
  await ensureCouponStorage();
  const result = await getPool().query(
    `SELECT
       code,
       discount_type,
       discount_value,
       starts_at,
       expires_at
     FROM coupons
     WHERE published_on_site = TRUE
       AND active = TRUE
       AND (starts_at IS NULL OR starts_at <= NOW())
       AND (expires_at IS NULL OR expires_at > NOW())
       AND (max_uses IS NULL OR used_count < max_uses)
     ORDER BY updated_at DESC, code ASC`,
  );

  return result.rows.map(publicSiteCoupon);
}
