-- Organization credit wallet v2. Apply after organizations_v1.
USE deplai;

CREATE TABLE IF NOT EXISTS credit_valuation_versions (
  id VARCHAR(64) PRIMARY KEY,
  credit_value_paise INT NOT NULL,
  units_per_credit BIGINT NOT NULL,
  usd_to_inr DECIMAL(12,6) NOT NULL,
  processor_fee_bps INT NOT NULL,
  pricing_max_age_hours INT NOT NULL DEFAULT 720,
  active TINYINT(1) NOT NULL DEFAULT 0,
  effective_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_credit_valuation_active (active, effective_at)
);

INSERT INTO credit_valuation_versions
  (id, credit_value_paise, units_per_credit, usd_to_inr, processor_fee_bps, pricing_max_age_hours, active, effective_at)
VALUES ('v2-inr-95', 1300, 1000000, 95.000000, 215, 720, 1, '2026-09-01 00:00:00')
ON DUPLICATE KEY UPDATE
  credit_value_paise = VALUES(credit_value_paise),
  units_per_credit = VALUES(units_per_credit),
  usd_to_inr = VALUES(usd_to_inr),
  processor_fee_bps = VALUES(processor_fee_bps),
  pricing_max_age_hours = VALUES(pricing_max_age_hours);

CREATE TABLE IF NOT EXISTS organization_credit_wallets (
  organization_id VARCHAR(36) PRIMARY KEY,
  balance_units BIGINT NOT NULL DEFAULT 0,
  reserved_units BIGINT NOT NULL DEFAULT 0,
  lifetime_granted_units BIGINT NOT NULL DEFAULT 0,
  lifetime_consumed_units BIGINT NOT NULL DEFAULT 0,
  lifetime_refunded_units BIGINT NOT NULL DEFAULT 0,
  debt_units BIGINT NOT NULL DEFAULT 0,
  status ENUM('ACTIVE', 'DEBT', 'FROZEN') NOT NULL DEFAULT 'ACTIVE',
  version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_credit_wallet_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

ALTER TABLE organization_credit_wallets ADD COLUMN debt_units BIGINT NOT NULL DEFAULT 0 AFTER lifetime_refunded_units;

CREATE TABLE IF NOT EXISTS organization_credit_grants (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(36) NOT NULL,
  granted_to_user_id VARCHAR(36) NULL,
  source_type VARCHAR(32) NOT NULL,
  source_id VARCHAR(191) NULL,
  idempotency_key VARCHAR(191) NOT NULL,
  catalog_version VARCHAR(64) NOT NULL,
  plan_id VARCHAR(36) NULL,
  credit_pack_id VARCHAR(36) NULL,
  granted_units BIGINT NOT NULL,
  remaining_units BIGINT NOT NULL,
  provider_budget_paise BIGINT NOT NULL DEFAULT 0,
  sandbox TINYINT(1) NOT NULL DEFAULT 0,
  expires_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_credit_grant_idempotency (organization_id, idempotency_key),
  INDEX idx_credit_grant_fifo (organization_id, expires_at, created_at),
  INDEX idx_credit_grant_source (source_type, source_id),
  CONSTRAINT fk_credit_grant_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_credit_grant_user FOREIGN KEY (granted_to_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS organization_credit_reservations (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  project_id VARCHAR(64) NULL,
  request_id VARCHAR(64) NOT NULL,
  attempt_key VARCHAR(191) NOT NULL,
  provider_id VARCHAR(64) NOT NULL,
  model_id VARCHAR(191) NOT NULL,
  status ENUM('RESERVED', 'SETTLED', 'RELEASED', 'SHADOW') NOT NULL,
  reserved_units BIGINT NOT NULL,
  settled_units BIGINT NOT NULL DEFAULT 0,
  provider_cost_usd DECIMAL(18,9) NULL,
  provider_cost_inr DECIMAL(18,6) NULL,
  valuation_version_id VARCHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  settled_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_credit_reservation_attempt (organization_id, attempt_key),
  INDEX idx_credit_reservation_abandoned (status, expires_at),
  INDEX idx_credit_reservation_request (organization_id, request_id),
  CONSTRAINT fk_credit_reservation_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_credit_reservation_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_credit_reservation_valuation FOREIGN KEY (valuation_version_id) REFERENCES credit_valuation_versions(id)
);

CREATE TABLE IF NOT EXISTS organization_credit_transactions (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(36) NOT NULL,
  actor_user_id VARCHAR(36) NULL,
  grant_id VARCHAR(36) NULL,
  reservation_id VARCHAR(36) NULL,
  type VARCHAR(32) NOT NULL,
  amount_units BIGINT NOT NULL,
  balance_after_units BIGINT NOT NULL,
  reserved_after_units BIGINT NOT NULL,
  idempotency_key VARCHAR(191) NOT NULL,
  source VARCHAR(64) NOT NULL,
  provider_id VARCHAR(64) NULL,
  model_id VARCHAR(191) NULL,
  project_id VARCHAR(64) NULL,
  valuation_version_id VARCHAR(64) NULL,
  provider_cost_usd DECIMAL(18,9) NULL,
  provider_cost_inr DECIMAL(18,6) NULL,
  metadata_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_credit_transaction_idempotency (organization_id, idempotency_key),
  INDEX idx_credit_transaction_cursor (organization_id, created_at, id),
  INDEX idx_credit_transaction_type (organization_id, type, created_at),
  CONSTRAINT fk_credit_transaction_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_credit_transaction_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_credit_transaction_grant FOREIGN KEY (grant_id) REFERENCES organization_credit_grants(id) ON DELETE SET NULL,
  CONSTRAINT fk_credit_transaction_reservation FOREIGN KEY (reservation_id) REFERENCES organization_credit_reservations(id) ON DELETE SET NULL,
  CONSTRAINT fk_credit_transaction_valuation FOREIGN KEY (valuation_version_id) REFERENCES credit_valuation_versions(id)
);

CREATE TABLE IF NOT EXISTS organization_credit_release_schedules (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  source_payment_id VARCHAR(64) NOT NULL,
  plan_id VARCHAR(36) NOT NULL,
  units_per_release BIGINT NOT NULL,
  provider_budget_paise_per_release BIGINT NOT NULL,
  releases_total INT NOT NULL,
  releases_completed INT NOT NULL DEFAULT 0,
  next_release_at DATETIME NOT NULL,
  status ENUM('ACTIVE', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_credit_release_payment (organization_id, source_payment_id),
  INDEX idx_credit_release_due (status, next_release_at),
  CONSTRAINT fk_credit_release_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_credit_release_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

ALTER TABLE ai_usage
  ADD COLUMN project_id VARCHAR(64) NULL AFTER organization_id,
  ADD INDEX idx_ai_usage_org_project (organization_id, project_id, created_at);

-- Retire legacy free/bonus provisioning and old packs. Historical rows remain.
UPDATE billing_plans SET paid_credit_amount = 0, bonus_credit_percent = 0, rollover_months_cap = 0
WHERE id IN ('free', 'starter_20', 'pro_50');
DELETE FROM credit_packs WHERE id IN ('pack_10', 'pack_25', 'pack_50');
INSERT INTO credit_packs (id, name, credit_amount, price_cents, paid_tiers_only)
VALUES ('topup_100_v2', '25 credit top-up', 25, 562, 1)
ON DUPLICATE KEY UPDATE name = VALUES(name), credit_amount = VALUES(credit_amount), price_cents = VALUES(price_cents), paid_tiers_only = 1;

-- Preserve payment-backed legacy paid balances in each user's personal org.
INSERT INTO organization_credit_wallets (organization_id, balance_units, lifetime_granted_units)
SELECT o.id, SUM(l.paid_credits_remaining) * 1000000, SUM(l.paid_credits_remaining) * 1000000
FROM credit_ledgers l
JOIN organizations o ON o.owner_user_id = l.user_id AND o.slug LIKE 'personal-%'
WHERE l.paid_credits_remaining > 0
  AND EXISTS (
    SELECT 1 FROM credit_transactions t
    WHERE t.ledger_id = l.id
      AND t.source NOT LIKE 'free_tier_grant%'
      AND t.source NOT LIKE 'cycle:%free%'
  )
GROUP BY o.id
ON DUPLICATE KEY UPDATE organization_id = organization_credit_wallets.organization_id;

INSERT IGNORE INTO organization_credit_grants
  (id, organization_id, granted_to_user_id, source_type, source_id, idempotency_key, catalog_version,
   granted_units, remaining_units, provider_budget_paise, sandbox, expires_at)
SELECT UUID(), o.id, l.user_id, 'migration', l.id, CONCAT('legacy-paid:', l.id), 'v2-inr-2026-09',
       l.paid_credits_remaining * 1000000, l.paid_credits_remaining * 1000000,
       l.paid_credits_remaining * 1300, 0, NULL
FROM credit_ledgers l
JOIN organizations o ON o.owner_user_id = l.user_id AND o.slug LIKE 'personal-%'
WHERE l.paid_credits_remaining > 0
  AND EXISTS (
    SELECT 1 FROM credit_transactions t
    WHERE t.ledger_id = l.id
      AND t.source NOT LIKE 'free_tier_grant%'
      AND t.source NOT LIKE 'cycle:%free%'
  );
