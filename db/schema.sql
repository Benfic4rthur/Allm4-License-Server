CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'mercado_pago',
  provider_payment_id TEXT UNIQUE,
  payer_email TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'BRL',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'refunded', 'charged_back')),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL CHECK (
    code = UPPER(code)
    AND code ~ '^[A-Z0-9_-]{3,40}$'
  ),
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value INTEGER NOT NULL CHECK (discount_value > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  max_uses_per_email INTEGER CHECK (
    max_uses_per_email IS NULL OR max_uses_per_email > 0
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (discount_type <> 'percent' OR discount_value <= 100),
  CHECK (expires_at IS NULL OR starts_at IS NULL OR expires_at > starts_at)
);

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS coupon_id UUID;

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS original_amount_cents INTEGER;

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS discount_amount_cents INTEGER NOT NULL DEFAULT 0;

UPDATE purchases
SET original_amount_cents = amount_cents
WHERE original_amount_cents IS NULL;

ALTER TABLE purchases
  ALTER COLUMN original_amount_cents SET NOT NULL;

ALTER TABLE purchases
  ALTER COLUMN original_amount_cents SET DEFAULT 4999;

ALTER TABLE purchases
  DROP CONSTRAINT IF EXISTS purchases_amount_cents_check;

ALTER TABLE purchases
  ADD CONSTRAINT purchases_amount_cents_check CHECK (amount_cents >= 0);

ALTER TABLE purchases
  DROP CONSTRAINT IF EXISTS purchases_original_amount_cents_check;

ALTER TABLE purchases
  ADD CONSTRAINT purchases_original_amount_cents_check
  CHECK (original_amount_cents > 0);

ALTER TABLE purchases
  DROP CONSTRAINT IF EXISTS purchases_discount_amount_cents_check;

ALTER TABLE purchases
  ADD CONSTRAINT purchases_discount_amount_cents_check
  CHECK (discount_amount_cents >= 0);

ALTER TABLE purchases
  DROP CONSTRAINT IF EXISTS purchases_pricing_consistency_check;

ALTER TABLE purchases
  ADD CONSTRAINT purchases_pricing_consistency_check
  CHECK (
    discount_amount_cents <= original_amount_cents
    AND amount_cents = original_amount_cents - discount_amount_cents
  );

DO $allm4$
BEGIN
  ALTER TABLE purchases
    ADD CONSTRAINT purchases_coupon_fk
    FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $allm4$;

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id UUID NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  purchase_id UUID UNIQUE NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  payer_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'redeemed', 'released')),
  redeemed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchases_coupon_id
  ON purchases(coupon_id);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon_status
  ON coupon_redemptions(coupon_id, status);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon_email
  ON coupon_redemptions(coupon_id, payer_email, status);

CREATE TABLE IF NOT EXISTS licenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID UNIQUE REFERENCES purchases(id) ON DELETE SET NULL,
  license_key_hash TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  max_devices INTEGER NOT NULL DEFAULT 3 CHECK (max_devices > 0),
  primary_device_id UUID,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id UUID NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  device_name TEXT,
  platform TEXT,
  first_activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_at TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ,
  UNIQUE (license_id, device_hash)
);

CREATE TABLE IF NOT EXISTS activations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id UUID REFERENCES licenses(id) ON DELETE SET NULL,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('activated', 'validated', 'deactivated', 'rejected', 'revoked')),
  ip_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE licenses
  ADD COLUMN IF NOT EXISTS primary_device_id UUID;

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;

DO $allm4$
BEGIN
  ALTER TABLE licenses
    ADD CONSTRAINT licenses_primary_device_fk
    FOREIGN KEY (primary_device_id) REFERENCES devices(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $allm4$;

CREATE TABLE IF NOT EXISTS license_schema_migrations (
  key TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

WITH migration AS (
  INSERT INTO license_schema_migrations (key)
  VALUES ('primary-device-purchase-origin-v2')
  ON CONFLICT (key) DO NOTHING
  RETURNING key
)
UPDATE licenses AS l
SET primary_device_id = COALESCE(
  (
    SELECT a.device_id
    FROM activations AS a
    JOIN devices AS d
      ON d.id = a.device_id
     AND d.license_id = l.id
    WHERE a.license_id = l.id
      AND a.event_type = 'activated'
      AND a.device_id IS NOT NULL
    ORDER BY a.created_at ASC
    LIMIT 1
  ),
  (
    SELECT d.id
    FROM devices AS d
    WHERE d.license_id = l.id
    ORDER BY d.first_activated_at ASC, d.id ASC
    LIMIT 1
  )
)
WHERE l.purchase_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM migration)
  AND EXISTS (
    SELECT 1
    FROM devices AS d
    WHERE d.license_id = l.id
  );

UPDATE licenses AS l
SET primary_device_id = (
  SELECT d.id
  FROM devices AS d
  WHERE d.license_id = l.id
  ORDER BY
    CASE WHEN d.deactivated_at IS NULL THEN 0 ELSE 1 END,
    d.last_seen_at DESC,
    d.first_activated_at DESC,
    d.id DESC
  LIMIT 1
)
WHERE l.primary_device_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM devices AS d
    WHERE d.license_id = l.id
  );

CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
CREATE INDEX IF NOT EXISTS idx_devices_license_id ON devices(license_id);
CREATE INDEX IF NOT EXISTS idx_devices_active ON devices(license_id) WHERE deactivated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_devices_available_active
  ON devices(license_id)
  WHERE deactivated_at IS NULL AND blocked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activations_license_id ON activations(license_id);
CREATE INDEX IF NOT EXISTS idx_activations_created_at ON activations(created_at DESC);


CREATE TABLE IF NOT EXISTS free_usage_devices (
  device_hash TEXT PRIMARY KEY,
  installation_count INTEGER NOT NULL DEFAULT 1 CHECK (installation_count >= 1),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_free_usage_devices_last_seen
  ON free_usage_devices(last_seen_at DESC);


CREATE TABLE IF NOT EXISTS bug_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number BIGSERIAL UNIQUE NOT NULL,
  tracking_token_hash TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'reported' CHECK (status IN (
    'reported',
    'received',
    'working',
    'changes_ready',
    'awaiting_approval',
    'merging',
    'releasing',
    'update_available',
    'resolved',
    'blocked'
  )),
  title TEXT NOT NULL,
  description TEXT,
  module TEXT,
  app_version TEXT NOT NULL,
  platform TEXT,
  arch TEXT,
  error_message TEXT,
  error_context TEXT,
  signature_hash TEXT,
  diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
  duplicate_count INTEGER NOT NULL DEFAULT 1 CHECK (duplicate_count > 0),
  github_issue_number INTEGER,
  github_issue_url TEXT,
  github_branch TEXT,
  pull_request_url TEXT,
  release_version TEXT,
  maintainer_note TEXT,
  claimed_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status);
CREATE INDEX IF NOT EXISTS idx_bug_reports_created_at ON bug_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bug_reports_signature ON bug_reports(signature_hash) WHERE signature_hash IS NOT NULL;


CREATE TABLE IF NOT EXISTS bug_report_events (
  id BIGSERIAL PRIMARY KEY,
  bug_report_id UUID NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bug_report_events_bug ON bug_report_events(bug_report_id, created_at ASC);


CREATE TABLE IF NOT EXISTS bug_report_watchers (
  id BIGSERIAL PRIMARY KEY,
  bug_report_id UUID NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  tracking_token_hash TEXT UNIQUE NOT NULL,
  app_version TEXT,
  platform TEXT,
  arch TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bug_report_occurrences (
  id BIGSERIAL PRIMARY KEY,
  bug_report_id UUID NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  app_version TEXT,
  platform TEXT,
  arch TEXT,
  description TEXT,
  error_message TEXT,
  error_context TEXT,
  diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bug_report_watchers_bug ON bug_report_watchers(bug_report_id);
CREATE INDEX IF NOT EXISTS idx_bug_report_occurrences_bug ON bug_report_occurrences(bug_report_id, created_at DESC);
