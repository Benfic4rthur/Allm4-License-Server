import { ensureCouponStorage } from "./coupon-schema.js";
import { normalizeCouponCode } from "./coupon-service.js";
import { getPool, withTransaction } from "./db.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CouponAdminValidationError extends Error {
  constructor(reason, fields = {}) {
    super(reason);
    this.name = "CouponAdminValidationError";
    this.reason = reason;
    this.fields = fields;
  }
}

function normalizeNullablePositiveInteger(value, fieldName) {
  if (value === undefined) return { supplied: false, value: undefined };
  if (value === null || value === "") return { supplied: true, value: null };

  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new CouponAdminValidationError("invalid_request", {
      [fieldName]: "must_be_positive_integer_or_null",
    });
  }
  return { supplied: true, value: numeric };
}

function normalizeOptionalTimestamp(value, fieldName) {
  if (value === undefined) return { supplied: false, value: undefined };
  if (value === null || value === "") return { supplied: true, value: null };
  if (typeof value !== "string") {
    throw new CouponAdminValidationError("invalid_request", {
      [fieldName]: "must_be_iso_datetime_or_null",
    });
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CouponAdminValidationError("invalid_request", {
      [fieldName]: "must_be_iso_datetime_or_null",
    });
  }

  return { supplied: true, value: parsed.toISOString() };
}

function normalizeBoolean(value, fieldName) {
  if (value === undefined) return { supplied: false, value: undefined };
  if (typeof value !== "boolean") {
    throw new CouponAdminValidationError("invalid_request", {
      [fieldName]: "must_be_boolean",
    });
  }
  return { supplied: true, value };
}

function assertValidWindow(startsAt, expiresAt) {
  if (!startsAt || !expiresAt) return;
  if (new Date(expiresAt).getTime() >= new Date(startsAt).getTime()) return;
  throw new CouponAdminValidationError("invalid_request", {
    expires_at: "must_be_after_starts_at",
  });
}

function publicCoupon(row) {
  return {
    id: row.id,
    code: row.code,
    discount_type: row.discount_type,
    discount_value: Number(row.discount_value),
    active: row.active === true,
    starts_at: row.starts_at ?? null,
    expires_at: row.expires_at ?? null,
    max_uses: row.max_uses === null ? null : Number(row.max_uses),
    used_count: Number(row.used_count ?? 0),
    max_uses_per_email:
      row.max_uses_per_email === null ? null : Number(row.max_uses_per_email),
    reserved_count: Number(row.reserved_count ?? 0),
    redeemed_count: Number(row.redeemed_count ?? row.used_count ?? 0),
    released_count: Number(row.released_count ?? 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function couponSelectSql() {
  return `SELECT
      c.id,
      c.code,
      c.discount_type,
      c.discount_value,
      c.active,
      c.starts_at,
      c.expires_at,
      c.max_uses,
      c.used_count,
      c.max_uses_per_email,
      c.created_at,
      c.updated_at,
      COUNT(r.id) FILTER (WHERE r.status = 'reserved') AS reserved_count,
      COUNT(r.id) FILTER (WHERE r.status = 'redeemed') AS redeemed_count,
      COUNT(r.id) FILTER (WHERE r.status = 'released') AS released_count
    FROM coupons c
    LEFT JOIN coupon_redemptions r ON r.coupon_id = c.id`;
}

function couponGroupSql() {
  return `GROUP BY
      c.id,
      c.code,
      c.discount_type,
      c.discount_value,
      c.active,
      c.starts_at,
      c.expires_at,
      c.max_uses,
      c.used_count,
      c.max_uses_per_email,
      c.created_at,
      c.updated_at`;
}

export function normalizeCouponCreateInput(input = {}) {
  const code = normalizeCouponCode(input.code);
  const discountType =
    input.discount_type === "percent" || input.discount_type === "fixed"
      ? input.discount_type
      : null;
  const discountValue = Number(input.discount_value);
  const fields = {};

  if (!code) fields.code = "invalid";
  if (!discountType) fields.discount_type = "must_be_percent_or_fixed";
  if (!Number.isSafeInteger(discountValue) || discountValue <= 0) {
    fields.discount_value = "must_be_positive_integer";
  } else if (discountType === "percent" && discountValue > 100) {
    fields.discount_value = "percent_must_be_at_most_100";
  }

  if (Object.keys(fields).length > 0) {
    throw new CouponAdminValidationError("invalid_request", fields);
  }

  const active = normalizeBoolean(input.active, "active");
  const startsAt = normalizeOptionalTimestamp(input.starts_at, "starts_at");
  const expiresAt = normalizeOptionalTimestamp(input.expires_at, "expires_at");
  const maxUses = normalizeNullablePositiveInteger(input.max_uses, "max_uses");
  const perEmail = normalizeNullablePositiveInteger(
    input.max_uses_per_email,
    "max_uses_per_email",
  );

  const normalized = {
    code,
    discount_type: discountType,
    discount_value: discountValue,
    active: active.supplied ? active.value : true,
    starts_at: startsAt.supplied ? startsAt.value : null,
    expires_at: expiresAt.supplied ? expiresAt.value : null,
    max_uses: maxUses.supplied ? maxUses.value : null,
    max_uses_per_email: perEmail.supplied ? perEmail.value : 1,
  };

  assertValidWindow(normalized.starts_at, normalized.expires_at);
  return normalized;
}

export function normalizeCouponUpdateInput(input = {}) {
  const active = normalizeBoolean(input.active, "active");
  const startsAt = normalizeOptionalTimestamp(input.starts_at, "starts_at");
  const expiresAt = normalizeOptionalTimestamp(input.expires_at, "expires_at");
  const maxUses = normalizeNullablePositiveInteger(input.max_uses, "max_uses");
  const perEmail = normalizeNullablePositiveInteger(
    input.max_uses_per_email,
    "max_uses_per_email",
  );

  const supplied = [
    active.supplied,
    startsAt.supplied,
    expiresAt.supplied,
    maxUses.supplied,
    perEmail.supplied,
  ].some(Boolean);

  if (!supplied) {
    throw new CouponAdminValidationError("invalid_request", {
      body: "no_supported_fields",
    });
  }

  return {
    ...(active.supplied ? { active: active.value } : {}),
    ...(startsAt.supplied ? { starts_at: startsAt.value } : {}),
    ...(expiresAt.supplied ? { expires_at: expiresAt.value } : {}),
    ...(maxUses.supplied ? { max_uses: maxUses.value } : {}),
    ...(perEmail.supplied
      ? { max_uses_per_email: perEmail.value }
      : {}),
  };
}

export async function listAdminCoupons() {
  await ensureCouponStorage();
  const result = await getPool().query(
    `${couponSelectSql()}
     ${couponGroupSql()}
     ORDER BY c.created_at DESC, c.code ASC`,
  );
  return result.rows.map(publicCoupon);
}

export async function createAdminCoupon(input) {
  await ensureCouponStorage();
  const normalized = normalizeCouponCreateInput(input);

  try {
    return await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO coupons (
           code,
           discount_type,
           discount_value,
           active,
           starts_at,
           expires_at,
           max_uses,
           max_uses_per_email
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          normalized.code,
          normalized.discount_type,
          normalized.discount_value,
          normalized.active,
          normalized.starts_at,
          normalized.expires_at,
          normalized.max_uses,
          normalized.max_uses_per_email,
        ],
      );

      const selected = await client.query(
        `${couponSelectSql()}
         WHERE c.id = $1
         ${couponGroupSql()}`,
        [inserted.rows[0].id],
      );

      return publicCoupon(selected.rows[0]);
    });
  } catch (error) {
    if (error?.code === "23505") {
      throw new CouponAdminValidationError("coupon_code_exists", {
        code: "already_exists",
      });
    }
    throw error;
  }
}

export async function updateAdminCoupon(couponId, input) {
  await ensureCouponStorage();
  const id = typeof couponId === "string" ? couponId.trim().toLowerCase() : "";
  if (!UUID_PATTERN.test(id)) {
    throw new CouponAdminValidationError("coupon_not_found");
  }

  const patch = normalizeCouponUpdateInput(input);

  return withTransaction(async (client) => {
    const currentResult = await client.query(
      `SELECT id, starts_at, expires_at, max_uses, used_count
       FROM coupons
       WHERE id = $1
       FOR UPDATE`,
      [id],
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw new CouponAdminValidationError("coupon_not_found");
    }

    const startsAt =
      Object.prototype.hasOwnProperty.call(patch, "starts_at")
        ? patch.starts_at
        : current.starts_at;
    const expiresAt =
      Object.prototype.hasOwnProperty.call(patch, "expires_at")
        ? patch.expires_at
        : current.expires_at;
    assertValidWindow(startsAt, expiresAt);

    if (Object.prototype.hasOwnProperty.call(patch, "max_uses")) {
      const reservedResult = await client.query(
        `SELECT COUNT(*) AS reserved_count
         FROM coupon_redemptions
         WHERE coupon_id = $1 AND status = 'reserved'`,
        [id],
      );
      const consumed =
        Number(current.used_count ?? 0) +
        Number(reservedResult.rows[0]?.reserved_count ?? 0);
      if (patch.max_uses !== null && patch.max_uses < consumed) {
        throw new CouponAdminValidationError("invalid_request", {
          max_uses: "below_current_usage",
        });
      }
    }

    const updates = [];
    const values = [];
    for (const [field, value] of Object.entries(patch)) {
      values.push(value);
      updates.push(`${field} = $${values.length}`);
    }
    values.push(id);

    await client.query(
      `UPDATE coupons
       SET ${updates.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length}`,
      values,
    );

    const selected = await client.query(
      `${couponSelectSql()}
       WHERE c.id = $1
       ${couponGroupSql()}`,
      [id],
    );

    return publicCoupon(selected.rows[0]);
  });
}
