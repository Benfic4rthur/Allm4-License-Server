import { createHash, randomBytes } from "node:crypto";
import { getPool, withTransaction } from "./db.js";
import { createPixOrder, extractPixDetails } from "./mercado-pago.js";
import { ensurePurchaseLicense } from "./purchase-license-service.js";
import { derivePurchaseLicenseKey, hashLicenseKey } from "./security.js";

export const ALLM4_LICENSE_PRICE_CENTS = 999;

const PURCHASE_ID_PATTERN =
  /^allm4_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function amountToCents(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [units, decimal = ""] = normalized.split(".");
  const cents = Number(units) * 100 + Number(decimal.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

function hashLookupToken(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function generatePurchaseLookupToken() {
  return randomBytes(32).toString("base64url");
}

export function mapMercadoPagoOrderStatus(order) {
  const status = order?.status;
  const statusDetail = order?.status_detail;
  if (status === "processed" && statusDetail === "accredited") return "approved";
  if (status === "refunded") return "refunded";
  if (status === "processed" && statusDetail === "refunded") return "refunded";
  if (status === "charged_back") return "charged_back";
  if (status === "canceled" || status === "expired") return "cancelled";
  if (status === "failed") return "rejected";
  if (status === "created" || status === "processing" || status === "action_required") return "pending";
  return null;
}

export function inspectMercadoPagoOrder(order) {
  const orderId = typeof order?.id === "string" ? order.id.trim() : "";
  const externalReference = typeof order?.external_reference === "string" ? order.external_reference.trim() : "";
  const referenceMatch = externalReference.match(PURCHASE_ID_PATTERN);
  const amountCents = amountToCents(order?.total_amount);
  const currency = order?.currency ?? order?.currency_id ?? null;
  const purchaseStatus = mapMercadoPagoOrderStatus(order);
  if (!orderId) return { valid: false, reason: "missing_order_id" };
  if (!referenceMatch) return { valid: false, reason: "invalid_external_reference" };
  if (amountCents !== ALLM4_LICENSE_PRICE_CENTS || currency !== "BRL") return { valid: false, reason: "unexpected_amount_or_currency" };
  if (!purchaseStatus) return { valid: false, reason: "unsupported_order_status" };
  return {
    valid: true,
    orderId,
    purchaseId: referenceMatch[1].toLowerCase(),
    purchaseStatus,
    amountCents,
    currency,
  };
}

export async function createPixPurchase({ payerEmail, payerFirstName = null, fetchImpl = fetch }) {
  const lookupToken = generatePurchaseLookupToken();
  const lookupTokenHash = hashLookupToken(lookupToken);
  const inserted = await getPool().query(
    `INSERT INTO purchases (provider, payer_email, amount_cents, currency, status, lookup_token_hash)
     VALUES ('mercado_pago', $1, $2, 'BRL', 'pending', $3)
     RETURNING id, provider, provider_payment_id, payer_email, amount_cents,
               currency, status, paid_at, created_at, updated_at`,
    [payerEmail, ALLM4_LICENSE_PRICE_CENTS, lookupTokenHash],
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
  if (!orderId || typeof orderId !== "string") throw new Error("Mercado Pago order response did not include an id");
  const updated = await getPool().query(
    `UPDATE purchases SET provider_payment_id = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, provider, provider_payment_id, payer_email, amount_cents,
               currency, status, paid_at, created_at, updated_at`,
    [purchase.id, orderId],
  );
  return {
    purchase: mapPurchase(updated.rows[0]),
    lookup_token: lookupToken,
    pix: extractPixDetails(order),
  };
}

export async function getPurchaseStatusForClient({ purchaseId, lookupToken }) {
  if (typeof purchaseId !== "string" || !UUID_PATTERN.test(purchaseId)) return null;
  if (typeof lookupToken !== "string" || lookupToken.length < 32 || lookupToken.length > 256) return null;
  const lookupTokenHash = hashLookupToken(lookupToken);
  const result = await getPool().query(
    `SELECT p.id, p.status, p.amount_cents, p.currency, p.paid_at,
            l.id AS license_id, l.license_key_hash, l.status AS license_status
     FROM purchases p
     LEFT JOIN licenses l ON l.purchase_id = p.id
     WHERE p.id = $1 AND p.lookup_token_hash = $2`,
    [purchaseId, lookupTokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  const response = {
    purchase_id: row.id,
    status: row.status,
    amount_cents: row.amount_cents,
    currency: row.currency,
    paid_at: row.paid_at ?? null,
    license_ready: false,
  };
  if (row.status === "approved" && row.license_id && row.license_status === "active") {
    const licenseKey = derivePurchaseLicenseKey(row.id);
    if (hashLicenseKey(licenseKey) === row.license_key_hash) {
      response.license_ready = true;
      response.license_key = licenseKey;
    }
  }
  return response;
}

export async function syncMercadoPagoPurchaseFromOrder(order) {
  const inspected = inspectMercadoPagoOrder(order);
  if (!inspected.valid) return { updated: false, ignored: true, reason: inspected.reason };
  return withTransaction(async (client) => {
    const selected = await client.query(
      `SELECT id, provider, provider_payment_id, payer_email, amount_cents,
              currency, status, paid_at, created_at, updated_at
       FROM purchases WHERE id = $1 FOR UPDATE`,
      [inspected.purchaseId],
    );
    const purchase = selected.rows[0];
    if (!purchase) return { updated: false, ignored: true, reason: "purchase_not_found" };
    if (purchase.provider !== "mercado_pago" || purchase.amount_cents !== ALLM4_LICENSE_PRICE_CENTS || purchase.currency !== "BRL") {
      return { updated: false, ignored: true, reason: "purchase_mismatch" };
    }
    if (purchase.provider_payment_id && purchase.provider_payment_id !== inspected.orderId) {
      return { updated: false, ignored: true, reason: "provider_order_mismatch" };
    }
    const alreadySynchronized = purchase.provider_payment_id === inspected.orderId && purchase.status === inspected.purchaseStatus;
    let synchronizedPurchase = purchase;
    if (!alreadySynchronized) {
      const updated = await client.query(
        `UPDATE purchases
         SET provider_payment_id = COALESCE(provider_payment_id, $2),
             status = $3,
             paid_at = CASE WHEN $3 = 'approved' THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, provider, provider_payment_id, payer_email, amount_cents,
                   currency, status, paid_at, created_at, updated_at`,
        [inspected.purchaseId, inspected.orderId, inspected.purchaseStatus],
      );
      synchronizedPurchase = updated.rows[0];
    }
    let purchaseLicense = null;
    if (inspected.purchaseStatus === "approved") {
      purchaseLicense = await ensurePurchaseLicense(client, inspected.purchaseId);
    }
    return {
      updated: !alreadySynchronized,
      ignored: false,
      reason: alreadySynchronized ? "already_synchronized" : null,
      purchase: mapPurchase(synchronizedPurchase),
      license_issued: purchaseLicense?.issued ?? false,
      license_recoverable: purchaseLicense?.recoverable ?? false,
      license: purchaseLicense?.license ?? null,
    };
  });
}
