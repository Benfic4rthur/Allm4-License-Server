import { withTransaction } from "./db.js";

const BOOTSTRAP_KEY = "archive-prelaunch-test-history-2026-09-22-v1";
const BOOTSTRAP_CUTOFF = "2026-09-22T23:16:00.000Z";

let adminVisibilityReady = null;

export async function ensureAdminVisibilityStorage() {
  if (!adminVisibilityReady) {
    adminVisibilityReady = withTransaction(async (client) => {
      await client.query(
        "ALTER TABLE purchases ADD COLUMN IF NOT EXISTS admin_archived_at TIMESTAMPTZ",
      );
      await client.query(
        "ALTER TABLE licenses ADD COLUMN IF NOT EXISTS admin_archived_at TIMESTAMPTZ",
      );
      await client.query(
        [
          "CREATE TABLE IF NOT EXISTS admin_visibility_migrations (",
          "  key TEXT PRIMARY KEY,",
          "  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
          ")",
        ].join("\n"),
      );
      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_purchases_admin_archived_at ON purchases(admin_archived_at)",
      );
      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_licenses_admin_archived_at ON licenses(admin_archived_at)",
      );

      const claimed = await client.query(
        [
          "INSERT INTO admin_visibility_migrations (key)",
          "VALUES ($1)",
          "ON CONFLICT (key) DO NOTHING",
          "RETURNING key",
        ].join("\n"),
        [BOOTSTRAP_KEY],
      );

      if (claimed.rowCount > 0) {
        await client.query(
          [
            "UPDATE purchases",
            "SET admin_archived_at = NOW()",
            "WHERE admin_archived_at IS NULL",
            "  AND created_at <= $1::timestamptz",
            "  AND NOT (",
            "    provider = 'mercado_pago'",
            "    AND status = 'approved'",
            "    AND (",
            "      (",
            "        LOWER(COALESCE(payer_email, '')) = 'natacha-inacio@hotmail.com'",
            "        AND amount_cents = 4999",
            "        AND DATE_TRUNC('minute', COALESCE(paid_at, created_at) AT TIME ZONE 'America/Sao_Paulo') = TIMESTAMP '2026-09-21 00:25:00'",
            "      )",
            "      OR (",
            "        LOWER(COALESCE(payer_email, '')) = 'arthur_benfica@hotmail.com'",
            "        AND amount_cents = 999",
            "        AND DATE_TRUNC('minute', COALESCE(paid_at, created_at) AT TIME ZONE 'America/Sao_Paulo') IN (",
            "          TIMESTAMP '2026-09-15 18:11:00',",
            "          TIMESTAMP '2026-09-15 18:16:00'",
            "        )",
            "      )",
            "    )",
            "  )",
          ].join("\n"),
          [BOOTSTRAP_CUTOFF],
        );

        await client.query(
          [
            "UPDATE licenses l",
            "SET admin_archived_at = NOW()",
            "WHERE l.admin_archived_at IS NULL",
            "  AND l.issued_at <= $1::timestamptz",
            "  AND (",
            "    l.purchase_id IS NULL",
            "    OR EXISTS (",
            "      SELECT 1",
            "      FROM purchases p",
            "      WHERE p.id = l.purchase_id",
            "        AND p.admin_archived_at IS NOT NULL",
            "    )",
            "  )",
          ].join("\n"),
          [BOOTSTRAP_CUTOFF],
        );
      }
    }).catch((error) => {
      adminVisibilityReady = null;
      throw error;
    });
  }

  return adminVisibilityReady;
}

export async function setAdminPurchaseArchived({ purchaseId, archived }) {
  await ensureAdminVisibilityStorage();

  return withTransaction(async (client) => {
    const purchase = await client.query(
      [
        "UPDATE purchases",
        "SET admin_archived_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END,",
        "    updated_at = NOW()",
        "WHERE id = $1",
        "RETURNING id, admin_archived_at",
      ].join("\n"),
      [purchaseId, archived === true],
    );

    if (purchase.rowCount === 0) return null;

    await client.query(
      [
        "UPDATE licenses",
        "SET admin_archived_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END",
        "WHERE purchase_id = $1",
      ].join("\n"),
      [purchaseId, archived === true],
    );

    return {
      id: purchase.rows[0].id,
      archived: purchase.rows[0].admin_archived_at !== null,
    };
  });
}
