import { ensureCouponStorage } from "./coupon-schema.js";
import {
  ensureAdminVisibilityStorage,
  setAdminPurchaseArchived,
} from "./admin-visibility-schema.js";
import { getPool } from "./db.js";
import { ensureFinanceStorage } from "./finance-schema.js";
import {
  extractMercadoPagoOrderPaymentId,
  getMercadoPagoOrder,
  getMercadoPagoPayment,
  inspectMercadoPagoPaymentFinancials,
} from "./mercado-pago.js";
import { syncMercadoPagoPurchaseFromOrder } from "./purchase-service.js";
import { derivePurchaseLicenseKey } from "./security.js";

function number(value) {
  return Number(value ?? 0);
}

function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function mapSale(row) {
  return {
    id: row.id,
    payer_email: row.payer_email ?? null,
    provider: row.provider,
    provider_order_id: row.provider_payment_id ?? null,
    provider_payment_id: row.provider_transaction_id ?? null,
    status: row.status,
    original_amount_cents: number(row.original_amount_cents),
    discount_amount_cents: number(row.discount_amount_cents),
    amount_cents: number(row.amount_cents),
    provider_fee_cents: nullableNumber(row.provider_fee_cents),
    net_received_amount_cents: nullableNumber(row.net_received_amount_cents),
    coupon_code: row.coupon_code ?? null,
    paid_at: row.paid_at ?? null,
    created_at: row.created_at,
    license_id: row.license_id ?? null,
    license_status: row.license_status ?? null,
    archived: row.admin_archived_at !== null && row.admin_archived_at !== undefined,
    financial_breakdown_unavailable:
      row.net_received_amount_cents === null &&
      row.admin_financial_resolved_at !== null &&
      row.admin_financial_resolved_at !== undefined,
  };
}

function mapLicense(row) {
  let licenseKey = null;
  if (row.purchase_id) {
    try {
      licenseKey = derivePurchaseLicenseKey(row.purchase_id);
    } catch {
      licenseKey = null;
    }
  }

  return {
    id: row.id,
    license_key: licenseKey,
    status: row.status,
    max_devices: number(row.max_devices),
    active_devices: number(row.active_devices),
    total_devices: number(row.total_devices),
    primary_device_name: row.primary_device_name ?? null,
    primary_device_platform: row.primary_device_platform ?? null,
    payer_email: row.payer_email ?? null,
    purchase_id: row.purchase_id ?? null,
    amount_cents: nullableNumber(row.amount_cents),
    net_received_amount_cents: nullableNumber(row.net_received_amount_cents),
    coupon_code: row.coupon_code ?? null,
    issued_at: row.issued_at,
    revoked_at: row.revoked_at ?? null,
    revoke_reason: row.revoke_reason ?? null,
    archived:
      (row.admin_archived_at !== null && row.admin_archived_at !== undefined) ||
      (row.purchase_archived_at !== null && row.purchase_archived_at !== undefined),
  };
}

function mapDevice(row) {
  return {
    id: row.id,
    license_id: row.license_id,
    license_status: row.license_status,
    payer_email: row.payer_email ?? null,
    device_name: row.device_name ?? null,
    platform: row.platform ?? null,
    is_primary: row.primary_device_id === row.id,
    status: row.blocked_at
      ? "blocked"
      : row.deactivated_at
        ? "inactive"
        : "active",
    first_activated_at: row.first_activated_at,
    last_seen_at: row.last_seen_at,
    blocked_at: row.blocked_at ?? null,
    deactivated_at: row.deactivated_at ?? null,
    archived:
      (row.license_archived_at !== null && row.license_archived_at !== undefined) ||
      (row.purchase_archived_at !== null && row.purchase_archived_at !== undefined),
  };
}

export async function getAdminDashboard({ from, to, includeArchived = false }) {
  await ensureCouponStorage();
  await ensureFinanceStorage();
  await ensureAdminVisibilityStorage();
  const pool = getPool();

  const [sales, current, couponPerformance, series] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE provider = 'mercado_pago' AND status = 'approved') AS sales_count,
         COUNT(*) FILTER (WHERE provider = 'coupon' AND status = 'approved') AS courtesy_count,
         COALESCE(SUM(amount_cents) FILTER (
           WHERE provider = 'mercado_pago' AND status = 'approved'
         ), 0) AS gross_revenue_cents,
         COALESCE(SUM(net_received_amount_cents) FILTER (
           WHERE provider = 'mercado_pago'
             AND status = 'approved'
             AND net_received_amount_cents IS NOT NULL
         ), 0) AS net_revenue_cents,
         COALESCE(SUM(provider_fee_cents) FILTER (
           WHERE provider = 'mercado_pago'
             AND status = 'approved'
             AND provider_fee_cents IS NOT NULL
         ), 0) AS provider_fee_cents,
         COALESCE(SUM(discount_amount_cents) FILTER (
           WHERE status = 'approved'
         ), 0) AS discount_total_cents,
         COUNT(*) FILTER (
           WHERE provider = 'mercado_pago'
             AND status = 'approved'
             AND net_received_amount_cents IS NULL
             AND admin_financial_resolved_at IS NULL
         ) AS net_pending_count,
         COUNT(*) FILTER (
           WHERE provider = 'mercado_pago'
             AND status = 'approved'
             AND net_received_amount_cents IS NULL
             AND admin_financial_resolved_at IS NOT NULL
         ) AS net_unavailable_count
       FROM purchases
       WHERE COALESCE(paid_at, created_at) >= $1
         AND COALESCE(paid_at, created_at) < $2
         AND ($3::boolean OR admin_archived_at IS NULL)`,
      [from, to, includeArchived],
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE l.status = 'active') AS active_licenses,
         COUNT(*) FILTER (WHERE l.status = 'revoked') AS revoked_licenses,
         (
           SELECT COUNT(*)
           FROM devices d
           JOIN licenses dl ON dl.id = d.license_id
           LEFT JOIN purchases dp ON dp.id = dl.purchase_id
           WHERE d.deactivated_at IS NULL
             AND d.blocked_at IS NULL
             AND (
               $1::boolean
               OR (
                 dl.admin_archived_at IS NULL
                 AND (dp.id IS NULL OR dp.admin_archived_at IS NULL)
               )
             )
         ) AS active_devices
       FROM licenses l
       LEFT JOIN purchases lp ON lp.id = l.purchase_id
       WHERE
         $1::boolean
         OR (
           l.admin_archived_at IS NULL
           AND (lp.id IS NULL OR lp.admin_archived_at IS NULL)
         )`,
      [includeArchived],
    ),
    pool.query(
      `SELECT
         c.code,
         c.discount_type,
         c.discount_value,
         COUNT(p.id) FILTER (WHERE p.status = 'approved') AS approved_uses,
         COALESCE(SUM(p.discount_amount_cents) FILTER (
           WHERE p.status = 'approved'
         ), 0) AS discount_total_cents,
         COALESCE(SUM(p.amount_cents) FILTER (
           WHERE p.provider = 'mercado_pago' AND p.status = 'approved'
         ), 0) AS gross_revenue_cents,
         COALESCE(SUM(p.net_received_amount_cents) FILTER (
           WHERE p.provider = 'mercado_pago'
             AND p.status = 'approved'
             AND p.net_received_amount_cents IS NOT NULL
         ), 0) AS net_revenue_cents
       FROM coupons c
       LEFT JOIN purchases p
         ON p.coupon_id = c.id
        AND COALESCE(p.paid_at, p.created_at) >= $1
        AND COALESCE(p.paid_at, p.created_at) < $2
        AND ($3::boolean OR p.admin_archived_at IS NULL)
       GROUP BY c.id, c.code, c.discount_type, c.discount_value
       HAVING COUNT(p.id) FILTER (WHERE p.status = 'approved') > 0
       ORDER BY approved_uses DESC, c.code ASC
       LIMIT 20`,
      [from, to, includeArchived],
    ),
    pool.query(
      `SELECT
         TO_CHAR(
           COALESCE(paid_at, created_at) AT TIME ZONE 'America/Sao_Paulo',
           'YYYY-MM-DD'
         ) AS day,
         COUNT(*) AS sales_count,
         COALESCE(SUM(amount_cents), 0) AS gross_revenue_cents,
         COALESCE(SUM(net_received_amount_cents) FILTER (
           WHERE net_received_amount_cents IS NOT NULL
         ), 0) AS net_revenue_cents,
         COUNT(*) FILTER (
           WHERE net_received_amount_cents IS NULL
             AND admin_financial_resolved_at IS NULL
         ) AS net_pending_count,
         COUNT(*) FILTER (
           WHERE net_received_amount_cents IS NULL
             AND admin_financial_resolved_at IS NOT NULL
         ) AS net_unavailable_count
       FROM purchases
       WHERE provider = 'mercado_pago'
         AND status = 'approved'
         AND COALESCE(paid_at, created_at) >= $1
         AND COALESCE(paid_at, created_at) < $2
         AND ($3::boolean OR admin_archived_at IS NULL)
       GROUP BY day
       ORDER BY day ASC`,
      [from, to, includeArchived],
    ),
  ]);

  const s = sales.rows[0] ?? {};
  const currentRow = current.rows[0] ?? {};
  const salesCount = number(s.sales_count);
  const gross = number(s.gross_revenue_cents);

  return {
    period: { from, to, timezone: "America/Sao_Paulo" },
    metrics: {
      sales_count: salesCount,
      courtesy_count: number(s.courtesy_count),
      gross_revenue_cents: gross,
      net_revenue_cents: number(s.net_revenue_cents),
      provider_fee_cents: number(s.provider_fee_cents),
      discount_total_cents: number(s.discount_total_cents),
      net_pending_count: number(s.net_pending_count),
      net_unavailable_count: number(s.net_unavailable_count),
      average_ticket_cents:
        salesCount > 0 ? Math.round(gross / salesCount) : 0,
      active_licenses: number(currentRow.active_licenses),
      revoked_licenses: number(currentRow.revoked_licenses),
      active_devices: number(currentRow.active_devices),
    },
    coupon_performance: couponPerformance.rows.map((row) => ({
      code: row.code,
      discount_type: row.discount_type,
      discount_value: number(row.discount_value),
      approved_uses: number(row.approved_uses),
      discount_total_cents: number(row.discount_total_cents),
      gross_revenue_cents: number(row.gross_revenue_cents),
      net_revenue_cents: number(row.net_revenue_cents),
    })),
    series: series.rows.map((row) => ({
      day: row.day,
      sales_count: number(row.sales_count),
      gross_revenue_cents: number(row.gross_revenue_cents),
      net_revenue_cents: number(row.net_revenue_cents),
      net_pending_count: number(row.net_pending_count),
      net_unavailable_count: number(row.net_unavailable_count),
    })),
  };
}

export async function listAdminSales({
  from,
  to,
  limit = 250,
  includeArchived = false,
}) {
  await ensureCouponStorage();
  await ensureFinanceStorage();
  await ensureAdminVisibilityStorage();
  const result = await getPool().query(
    `SELECT
       p.id, p.payer_email, p.provider, p.provider_payment_id,
       p.provider_transaction_id, p.status, p.original_amount_cents,
       p.discount_amount_cents, p.amount_cents, p.provider_fee_cents,
       p.net_received_amount_cents, p.paid_at, p.created_at,
       p.admin_archived_at, p.admin_financial_resolved_at,
       c.code AS coupon_code, l.id AS license_id, l.status AS license_status
     FROM purchases p
     LEFT JOIN coupons c ON c.id = p.coupon_id
     LEFT JOIN licenses l ON l.purchase_id = p.id
     WHERE COALESCE(p.paid_at, p.created_at) >= $1
       AND COALESCE(p.paid_at, p.created_at) < $2
       AND ($3::boolean OR p.admin_archived_at IS NULL)
     ORDER BY COALESCE(p.paid_at, p.created_at) DESC
     LIMIT $4`,
    [from, to, includeArchived, limit],
  );
  return result.rows.map(mapSale);
}

export async function listAdminLicenses({
  limit = 500,
  includeArchived = false,
} = {}) {
  await ensureFinanceStorage();
  await ensureAdminVisibilityStorage();
  const result = await getPool().query(
    `SELECT
       l.id, l.purchase_id, l.status, l.max_devices, l.primary_device_id,
       l.issued_at, l.revoked_at, l.revoke_reason,
       p.payer_email, p.amount_cents, p.net_received_amount_cents,
       l.admin_archived_at, p.admin_archived_at AS purchase_archived_at,
       c.code AS coupon_code,
       COUNT(d.id) AS total_devices,
       COUNT(d.id) FILTER (
         WHERE d.deactivated_at IS NULL AND d.blocked_at IS NULL
       ) AS active_devices,
       pd.device_name AS primary_device_name,
       pd.platform AS primary_device_platform
     FROM licenses l
     LEFT JOIN purchases p ON p.id = l.purchase_id
     LEFT JOIN coupons c ON c.id = p.coupon_id
     LEFT JOIN devices d ON d.license_id = l.id
     LEFT JOIN devices pd ON pd.id = l.primary_device_id
     WHERE
       $1::boolean
       OR (
         l.admin_archived_at IS NULL
         AND (p.id IS NULL OR p.admin_archived_at IS NULL)
       )
     GROUP BY
       l.id, l.purchase_id, l.status, l.max_devices, l.primary_device_id,
       l.issued_at, l.revoked_at, l.revoke_reason,
       p.payer_email, p.amount_cents, p.net_received_amount_cents,
       l.admin_archived_at, p.admin_archived_at,
       c.code, pd.device_name, pd.platform
     ORDER BY l.issued_at DESC
     LIMIT $2`,
    [includeArchived, limit],
  );
  return result.rows.map(mapLicense);
}

export async function listAdminDevices({
  limit = 1000,
  includeArchived = false,
} = {}) {
  await ensureAdminVisibilityStorage();
  const result = await getPool().query(
    `SELECT
       d.id, d.license_id, d.device_name, d.platform,
       d.first_activated_at, d.last_seen_at, d.blocked_at, d.deactivated_at,
       l.status AS license_status, l.primary_device_id,
       l.admin_archived_at AS license_archived_at,
       p.admin_archived_at AS purchase_archived_at,
       p.payer_email
     FROM devices d
     JOIN licenses l ON l.id = d.license_id
     LEFT JOIN purchases p ON p.id = l.purchase_id
     WHERE
       $1::boolean
       OR (
         l.admin_archived_at IS NULL
         AND (p.id IS NULL OR p.admin_archived_at IS NULL)
       )
     ORDER BY d.last_seen_at DESC
     LIMIT $2`,
    [includeArchived, limit],
  );
  return result.rows.map(mapDevice);
}

async function recoverLegacyPurchaseFinancials(row, order = null) {
  const candidateIds = new Set();

  if (order) {
    const orderPaymentId = extractMercadoPagoOrderPaymentId(order);
    if (orderPaymentId) candidateIds.add(orderPaymentId);
  }

  for (const value of [
    row.provider_transaction_id,
    row.provider_payment_id,
  ]) {
    const normalized =
      value === null || value === undefined ? "" : String(value).trim();
    if (/^\d+$/.test(normalized)) candidateIds.add(normalized);
  }

  for (const paymentId of candidateIds) {
    try {
      const payment = await getMercadoPagoPayment(paymentId);
      const financials = inspectMercadoPagoPaymentFinancials(payment);
      if (
        !financials.valid ||
        (financials.transactionAmountCents !== null &&
          financials.transactionAmountCents !== number(row.amount_cents))
      ) {
        continue;
      }

      const updated = await getPool().query(
        `UPDATE purchases
         SET provider_transaction_id = $2,
             provider_fee_cents = $3,
             net_received_amount_cents = $4,
             provider_financial_updated_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
           AND admin_archived_at IS NULL
         RETURNING id`,
        [
          row.id,
          financials.paymentId,
          financials.providerFeeCents,
          financials.netReceivedAmountCents,
        ],
      );

      if (updated.rowCount > 0) return true;
    } catch (error) {
      console.warn("[Admin Dashboard] legacy payment lookup failed", {
        purchase_id: row.id,
        payment_id: paymentId,
        error: error?.message ?? String(error),
      });
    }
  }

  return false;
}

export async function reconcileAdminSales({ limit = 25 } = {}) {
  await ensureFinanceStorage();
  await ensureAdminVisibilityStorage();
  const result = await getPool().query(
    `SELECT
       id, provider_payment_id, provider_transaction_id, amount_cents
     FROM purchases
     WHERE provider = 'mercado_pago'
       AND status = 'approved'
       AND admin_archived_at IS NULL
       AND admin_financial_resolved_at IS NULL
       AND net_received_amount_cents IS NULL
     ORDER BY COALESCE(paid_at, created_at) DESC
     LIMIT $1`,
    [limit],
  );

  let synchronized = 0;
  let failed = 0;

  for (const row of result.rows) {
    let order = null;
    let recovered = false;

    if (row.provider_payment_id) {
      try {
        order = await getMercadoPagoOrder(row.provider_payment_id);
        const synced = await syncMercadoPagoPurchaseFromOrder(order);
        recovered =
          synced?.purchase?.net_received_amount_cents !== null &&
          synced?.purchase?.net_received_amount_cents !== undefined;
      } catch (error) {
        console.warn("[Admin Dashboard] order reconciliation failed", {
          purchase_id: row.id,
          order_id: row.provider_payment_id,
          error: error?.message ?? String(error),
        });
      }
    }

    if (!recovered) {
      recovered = await recoverLegacyPurchaseFinancials(row, order);
    }

    if (recovered) synchronized += 1;
    else failed += 1;
  }

  return {
    attempted: result.rows.length,
    synchronized,
    failed,
    remaining_unknown: number(
      (
        await getPool().query(
          `SELECT COUNT(*) AS count
           FROM purchases
           WHERE provider = 'mercado_pago'
             AND status = 'approved'
             AND admin_archived_at IS NULL
             AND admin_financial_resolved_at IS NULL
             AND net_received_amount_cents IS NULL`,
        )
      ).rows[0]?.count,
    ),
  };
}

export async function setAdminSaleArchived({ purchaseId, archived }) {
  return setAdminPurchaseArchived({ purchaseId, archived });
}
