import { getPool } from "./db.js";
import {
  DEFAULT_ALMA_PRICE_CENTS,
  ensureProductSettingsStorage,
} from "./product-settings-schema.js";

export const MAX_ALMA_PRODUCT_PRICE_CENTS = 1_000_000;

export class ProductSettingsValidationError extends Error {
  constructor(reason, fields = {}) {
    super(reason);
    this.name = "ProductSettingsValidationError";
    this.reason = reason;
    this.fields = fields;
  }
}

function mapProduct(row) {
  return {
    key: "alma",
    price_cents: Number(row?.price_cents ?? DEFAULT_ALMA_PRICE_CENTS),
    currency: row?.currency ?? "BRL",
    updated_at: row?.updated_at ?? null,
  };
}

export async function getAlmaProductSettings() {
  await ensureProductSettingsStorage();
  const result = await getPool().query(
    `SELECT product_key, price_cents, currency, updated_at
     FROM product_settings
     WHERE product_key = 'alma'`,
  );
  return mapProduct(result.rows[0]);
}

export async function getAlmaProductPriceCents() {
  return (await getAlmaProductSettings()).price_cents;
}

export async function updateAlmaProductPrice(input = {}) {
  const priceCents = Number(input.price_cents);
  if (
    !Number.isSafeInteger(priceCents) ||
    priceCents <= 0 ||
    priceCents > MAX_ALMA_PRODUCT_PRICE_CENTS
  ) {
    throw new ProductSettingsValidationError("invalid_request", {
      price_cents: "must_be_positive_integer_within_limit",
    });
  }

  await ensureProductSettingsStorage();
  const result = await getPool().query(
    `UPDATE product_settings
     SET price_cents = $1, updated_at = NOW()
     WHERE product_key = 'alma'
     RETURNING product_key, price_cents, currency, updated_at`,
    [priceCents],
  );
  return mapProduct(result.rows[0]);
}
