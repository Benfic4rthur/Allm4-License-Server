import { getPool } from "./db.js";
import { createPixOrder, extractPixDetails } from "./mercado-pago.js";

export const ALLM4_LICENSE_PRICE_CENTS = 999;

function mapPurchase(row) {
  return {
    id: row.id,
    provider: row.provider,
    provider_payment_id: row.provider_payment_id ?? null,
    payer_email: row.payer_email ?? null,
    amount_cents: row.amount_cents,
    currency: row.currency,
    status: row.status,
    paid_at: row.paid_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createPixPurchase({
  payerEmail,
  payerFirstName = null,
  fetchImpl = fetch,
}) {
  const inserted = await getPool().query(
    `INSERT INTO purchases (
      provider,
      payer_email,
      amount_cents,
      currency,
      status
    ) VALUES ('mercado_pago', $1, $2, 'BRL', 'pending')
    RETURNING id, provider, provider_payment_id, payer_email, amount_cents,
              currency, status, paid_at, created_at, updated_at`,
    [payerEmail, ALLM4_LICENSE_PRICE_CENTS],
  );

  const purchase = inserted.rows[0];
  const externalReference = `allm4_${purchase.id}`;

  const order = await createPixOrder({
    amountCents: ALLM4_LICENSE_PRICE_CENTS,
    externalReference,
    payerEmail,
    payerFirstName,
    fetchImpl,
  });

  const orderId = order?.id;
  if (!orderId || typeof orderId !== "string") {
    throw new Error("Mercado Pago order response did not include an id");
  }

  const updated = await getPool().query(
    `UPDATE purchases
     SET provider_payment_id = $2,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, provider, provider_payment_id, payer_email, amount_cents,
               currency, status, paid_at, created_at, updated_at`,
    [purchase.id, orderId],
  );

  return {
    purchase: mapPurchase(updated.rows[0]),
    pix: extractPixDetails(order),
  };
}
