CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'mercado_pago',
  provider_payment_id TEXT UNIQUE,
  payer_email TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'BRL',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'refunded', 'charged_back')),
  lookup_token_hash TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE purchases ADD COLUMN IF NOT EXISTS lookup_token_hash TEXT;

CREATE TABLE IF NOT EXISTS licenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID UNIQUE REFERENCES purchases(id) ON DELETE SET NULL,
  license_key_hash TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  max_devices INTEGER NOT NULL DEFAULT 3 CHECK (max_devices > 0),
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

CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);
CREATE INDEX IF NOT EXISTS idx_purchases_lookup_token_hash ON purchases(lookup_token_hash) WHERE lookup_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
CREATE INDEX IF NOT EXISTS idx_devices_license_id ON devices(license_id);
CREATE INDEX IF NOT EXISTS idx_devices_active ON devices(license_id) WHERE deactivated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activations_license_id ON activations(license_id);
CREATE INDEX IF NOT EXISTS idx_activations_created_at ON activations(created_at DESC);
