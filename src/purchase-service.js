import { ensureCouponStorage } from "./coupon-schema.js";
import { getPool, withTransaction } from "./db.js";
import { ensureFinanceStorage } from "./finance-schema.js";
import {
  finalizeCouponRedemption,
  lockCouponForPurchase,
  recordCouponRedemption,
} from "./coupon-service.js";
import {
  createPixOrder,
  extractMercadoPagoOrderPaymentId,
  extractPixDetails,
  getMercadoPagoPayment,
  inspectMercadoPagoPaymentFinancials,
  searchMercadoPagoPaymentsByExternalReference,
} from "./mercado-pago.js";
import { ensurePurchaseLicense } from "./purchase-license-service.js";
import {
  derivePurchaseLicenseKey,
  derivePurchaseLookupToken,
  hashLicenseKey,
  verifyPurchaseLookupToken,
} from "./security.js";

export const ALLM4_LICENSE_PRICE_CENTS = 4999;

const PURCHASE_ID_PATTERN =
  /^allm4_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mapPurchase(row) {
  return {
    id: row.id,
    provider: row.provider,
    provider_payment_id: row.provider_payment_id ?? null,
    provider_transaction_id: row.provider_transaction_id ?? null,
    provider_fee_cents:
      row.provider_fee_cents === null || row.provider_fee_cents === undefined
        ? null
        : Number(row.provider_fee_cents),
    net_received_amount_cents:
      row.net_received_amount_cents === null ||
      row.net_received_amount_cents === undefined
        ? null
        : Number(row.net_received_amount_cents),
    payer_email: row.payer_email ?? null,
    coupon_code: row.coupon_code ?? null,
    original_amount_cents: row.original_amount_cents ?? row.amount_cents,
    discount_amount_cents: row.discount_amount_cents ?? 0,
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
  if (
    amountCents === null ||
    amountCents <= 0 ||
    amountCents > ALLM4_LICENSE_PRICE_CENTS ||
    currency !== "BRL"
  ) {
    return { valid: false, reason: "unexpected_amount_or_currency" };
  }
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

async function rejectFailedProviderPurchase(purchaseId) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE purchases
       SET status = 'rejected', updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [purchaseId],
    );
    await finalizeCouponRedemption(client, {
      purchaseId,
      purchaseStatus: "rejected",
    });
  });
}

export async function createPixPurchase({
  payerEmail,
  payerFirstName = null,
  couponCode = null,
  fetchImpl = fetch,
}) {
  await ensureCouponStorage();
  await ensureFinanceStorage();
  const prepared = await withTransaction(async (client) => {
    let coupon = null;
    let pricing = {
      original_amount_cents: ALLM4_LICENSE_PRICE_CENTS,
      discount_amount_cents: 0,
      final_amount_cents: ALLM4_LICENSE_PRICE_CENTS,
    };

    if (couponCode) {
      const validated = await lockCouponForPurchase(client, {
        couponCode,
        payerEmail,
        baseAmountCents: ALLM4_LICENSE_PRICE_CENTS,
      });
      coupon = validated.coupon;
      pricing = validated.pricing;
    }

    const freePurchase = pricing.final_amount_cents === 0;
    const inserted = await client.query(
      `INSERT INTO purchases (
         provider, payer_email, coupon_id, original_amount_cents,
         discount_amount_cents, amount_cents, currency, status, paid_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, 'BRL', $7,
         CASE WHEN $7 = 'approved' THEN NOW() ELSE NULL END
       )
       RETURNING id, provider, provider_payment_id, payer_email, coupon_id,
                 original_amount_cents, discount_amount_cents, amount_cents,
                 currency, status, paid_at, created_at, updated_at`,
      [
        freePurchase ? "coupon" : "mercado_pago",
        payerEmail,
        coupon?.id ?? null,
        pricing.original_amount_cents,
        pricing.discount_amount_cents,
        pricing.final_amount_cents,
        freePurchase ? "approved" : "pending",
      ],
    );
    const purchase = inserted.rows[0];

    if (coupon) {
      await recordCouponRedemption(client, {
        couponId: coupon.id,
        purchaseId: purchase.id,
        payerEmail,
        redeemed: freePurchase,
      });
    }

    if (freePurchase) {
      await ensurePurchaseLicense(client, purchase.id);
    }

    return {
      purchase: { ...purchase, coupon_code: coupon?.code ?? null },
      freePurchase,
    };
  });

  const purchaseId = prepared.purchase.id;
  const lookupToken = derivePurchaseLookupToken(purchaseId);

  if (prepared.freePurchase) {
    return {
      purchase: mapPurchase(prepared.purchase),
      lookup_token: lookupToken,
      payment_required: false,
      pix: null,
    };
  }

  const externalReference = `allm4_${purchaseId}`;
  let order;
  try {
    order = await createPixOrder({
      amountCents: prepared.purchase.amount_cents,
      externalReference,
      payerEmail,
      payerFirstName,
      fetchImpl,
    });
  } catch (error) {
    await rejectFailedProviderPurchase(purchaseId);
    throw error;
  }

  const orderId = order?.id;
  if (!orderId || typeof orderId !== "string") {
    await rejectFailedProviderPurchase(purchaseId);
    throw new Error("Mercado Pago order response did not include an id");
  }

  const updated = await getPool().query(
    `UPDATE purchases SET provider_payment_id = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, provider, provider_payment_id, payer_email, coupon_id,
               original_amount_cents, discount_amount_cents, amount_cents,
               currency, status, paid_at, created_at, updated_at`,
    [purchaseId, orderId],
  );

  return {
    purchase: mapPurchase({
      ...updated.rows[0],
      coupon_code: prepared.purchase.coupon_code,
    }),
    lookup_token: lookupToken,
    payment_required: true,
    pix: extractPixDetails(order),
  };
}

export async function getPurchaseStatusForClient({ purchaseId, lookupToken }) {
  await ensureCouponStorage();
  if (typeof purchaseId !== "string" || !UUID_PATTERN.test(purchaseId)) {
    return { ok: false, reason: "invalid_purchase_id" };
  }
  if (!verifyPurchaseLookupToken(purchaseId, lookupToken)) {
    return { ok: false, reason: "invalid_lookup_token" };
  }
  const result = await getPool().query(
    `SELECT p.id, p.status, p.original_amount_cents, p.discount_amount_cents,
            p.amount_cents, p.currency, p.paid_at, c.code AS coupon_code,
            l.id AS license_id, l.license_key_hash, l.status AS license_status
     FROM purchases p
     LEFT JOIN coupons c ON c.id = p.coupon_id
     LEFT JOIN licenses l ON l.purchase_id = p.id
     WHERE p.id = $1`,
    [purchaseId],
  );
  const row = result.rows[0];
  if (!row) return { ok: false, reason: "purchase_not_found" };
  const purchase = {
    purchase_id: row.id,
    status: row.status,
    coupon_code: row.coupon_code ?? null,
    original_amount_cents: row.original_amount_cents,
    discount_amount_cents: row.discount_amount_cents,
    amount_cents: row.amount_cents,
    currency: row.currency,
    paid_at: row.paid_at ?? null,
    license_ready: false,
  };
  if (row.status === "approved" && row.license_id && row.license_status === "active") {
    const licenseKey = derivePurchaseLicenseKey(row.id);
    if (hashLicenseKey(licenseKey) === row.license_key_hash) {
      purchase.license_ready = true;
      purchase.license_key = licenseKey;
    }
  }
  return { ok: true, purchase };
}

export async function syncMercadoPagoPurchaseFromOrder(
  order,
  {
    fetchPayment = getMercadoPagoPayment,
    searchPayments = searchMercadoPagoPaymentsByExternalReference,
  } = {},
) {
  await ensureCouponStorage();
  await ensureFinanceStorage();
  const inspected = inspectMercadoPagoOrder(order);
  if (!inspected.valid) {
    return { updated: false, ignored: true, reason: inspected.reason };
  }

  let paymentFinancials = null;
  const orderPaymentId = extractMercadoPagoOrderPaymentId(order);
  if (inspected.purchaseStatus === "approved" && orderPaymentId) {
    try {
      const payment = await fetchPayment(orderPaymentId);
      const inspectedPayment = inspectMercadoPagoPaymentFinancials(payment);
      if (inspectedPayment.valid) {
        paymentFinancials = inspectedPayment;
      } else {
        console.warn("[Purchase API] Mercado Pago payment financials unavailable", {
          order_id: inspected.orderId,
          payment_id: orderPaymentId,
          reason: inspectedPayment.reason,
        });
      }
    } catch (error) {
      console.warn("[Purchase API] Mercado Pago payment financial lookup failed", {
        order_id: inspected.orderId,
        payment_id: orderPaymentId,
        error: error?.message ?? String(error),
      });
    }
  }

  if (inspected.purchaseStatus === "approved" && !paymentFinancials) {
    const externalReference = `allm4_${inspected.purchaseId}`;
    try {
      const searchResult = await searchPayments(externalReference);
      const candidates = Array.isArray(searchResult?.results)
        ? searchResult.results
        : [];

      for (const candidate of candidates) {
        if (
          candidate?.status &&
          candidate.status !== "approved" &&
          candidate.status !== "authorized"
        ) {
          continue;
        }

        let inspectedPayment = inspectMercadoPagoPaymentFinancials(candidate);
        if (!inspectedPayment.valid && candidate?.id) {
          try {
            const fullPayment = await fetchPayment(candidate.id);
            inspectedPayment = inspectMercadoPagoPaymentFinancials(fullPayment);
          } catch {
            continue;
          }
        }

        if (
          inspectedPayment.valid &&
          (inspectedPayment.transactionAmountCents === null ||
            inspectedPayment.transactionAmountCents === inspected.amountCents)
        ) {
          paymentFinancials = inspectedPayment;
          break;
        }
      }
    } catch (error) {
      console.warn("[Purchase API] Mercado Pago payment search failed", {
        order_id: inspected.orderId,
        external_reference: externalReference,
        error: error?.message ?? String(error),
      });
    }
  }

  return withTransaction(async (client) => {
    const selected = await client.query(
      `SELECT p.id, p.provider, p.provider_payment_id, p.payer_email,
              p.coupon_id, p.original_amount_cents, p.discount_amount_cents,
              p.amount_cents, p.currency, p.status, p.paid_at,
              p.provider_transaction_id, p.provider_fee_cents,
              p.net_received_amount_cents, p.provider_financial_updated_at,
              p.created_at, p.updated_at, c.code AS coupon_code
       FROM purchases p
       LEFT JOIN coupons c ON c.id = p.coupon_id
       WHERE p.id = $1
       FOR UPDATE OF p`,
      [inspected.purchaseId],
    );
    const purchase = selected.rows[0];
    if (!purchase) return { updated: false, ignored: true, reason: "purchase_not_found" };
    if (
      purchase.provider !== "mercado_pago" ||
      purchase.amount_cents !== inspected.amountCents ||
      purchase.currency !== inspected.currency ||
      purchase.amount_cents <= 0
    ) {
      return { updated: false, ignored: true, reason: "purchase_mismatch" };
    }
    if (purchase.provider_payment_id && purchase.provider_payment_id !== inspected.orderId) {
      return { updated: false, ignored: true, reason: "provider_order_mismatch" };
    }

    const financialsMatch =
      paymentFinancials &&
      (paymentFinancials.transactionAmountCents === null ||
        paymentFinancials.transactionAmountCents === purchase.amount_cents);
    const financeUpdateNeeded =
      financialsMatch &&
      (purchase.provider_transaction_id !== paymentFinancials.paymentId ||
        purchase.net_received_amount_cents !==
          paymentFinancials.netReceivedAmountCents ||
        purchase.provider_fee_cents !== paymentFinancials.providerFeeCents);
    const alreadySynchronized =
      purchase.provider_payment_id === inspected.orderId &&
      purchase.status === inspected.purchaseStatus &&
      !financeUpdateNeeded;
    let synchronizedPurchase = purchase;

    if (!alreadySynchronized) {
      const updated = await client.query(
        `UPDATE purchases
         SET provider_payment_id = COALESCE(provider_payment_id, $2),
             status = $3,
             paid_at = CASE WHEN $3 = 'approved' THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
             provider_transaction_id = CASE
               WHEN $4::text IS NOT NULL THEN $4
               ELSE provider_transaction_id
             END,
             provider_fee_cents = CASE
               WHEN $5::integer IS NOT NULL THEN $5
               ELSE provider_fee_cents
             END,
             net_received_amount_cents = CASE
               WHEN $6::integer IS NOT NULL THEN $6
               ELSE net_received_amount_cents
             END,
             provider_financial_updated_at = CASE
               WHEN $6::integer IS NOT NULL THEN NOW()
               ELSE provider_financial_updated_at
             END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, provider, provider_payment_id, provider_transaction_id,
                   provider_fee_cents, net_received_amount_cents, payer_email,
                   coupon_id, original_amount_cents, discount_amount_cents,
                   amount_cents, currency, status, paid_at, created_at, updated_at`,
        [
          inspected.purchaseId,
          inspected.orderId,
          inspected.purchaseStatus,
          financialsMatch ? paymentFinancials.paymentId : null,
          financialsMatch ? paymentFinancials.providerFeeCents : null,
          financialsMatch ? paymentFinancials.netReceivedAmountCents : null,
        ],
      );
      synchronizedPurchase = {
        ...updated.rows[0],
        coupon_code: purchase.coupon_code,
      };
    }

    await finalizeCouponRedemption(client, {
      purchaseId: inspected.purchaseId,
      purchaseStatus: inspected.purchaseStatus,
    });

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
