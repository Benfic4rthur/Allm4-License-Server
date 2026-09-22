import { withTransaction } from "./db.js";

let financeStorageReady = null;

export async function ensureFinanceStorage() {
  if (!financeStorageReady) {
    financeStorageReady = withTransaction(async (client) => {
      await client.query(
        `ALTER TABLE purchases
         ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT`,
      );
      await client.query(
        `ALTER TABLE purchases
         ADD COLUMN IF NOT EXISTS provider_fee_cents INTEGER`,
      );
      await client.query(
        `ALTER TABLE purchases
         ADD COLUMN IF NOT EXISTS net_received_amount_cents INTEGER`,
      );
      await client.query(
        `ALTER TABLE purchases
         ADD COLUMN IF NOT EXISTS provider_financial_updated_at TIMESTAMPTZ`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_purchases_paid_at
         ON purchases(paid_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_purchases_provider_transaction_id
         ON purchases(provider_transaction_id)
         WHERE provider_transaction_id IS NOT NULL`,
      );
    }).catch((error) => {
      financeStorageReady = null;
      throw error;
    });
  }

  return financeStorageReady;
}
