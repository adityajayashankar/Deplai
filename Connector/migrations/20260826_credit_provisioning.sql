-- Credit provisioning for subscription tiers.
-- Review this file before applying it to any shared database.
-- Fresh Docker volumes also load the same objects from Connector/database.sql.

USE deplai;

CREATE TABLE IF NOT EXISTS billing_plans (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(32) NOT NULL UNIQUE,
  display_name VARCHAR(64) NOT NULL,
  description VARCHAR(255) NOT NULL,
  price_cents INT NOT NULL,
  yearly_price_cents INT NOT NULL DEFAULT 0,
  billing_cadence VARCHAR(16) NOT NULL DEFAULT 'monthly',
  paid_credit_amount INT NOT NULL,
  bonus_credit_percent INT NOT NULL DEFAULT 0,
  rollover_months_cap INT NOT NULL DEFAULT 0,
  is_custom TINYINT(1) NOT NULL DEFAULT 0,
  is_recommended TINYINT(1) NOT NULL DEFAULT 0,
  bonus_terms_copy TEXT NOT NULL,
  features_json JSON NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  plan_id VARCHAR(36) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  billing_cadence VARCHAR(16) NOT NULL DEFAULT 'monthly',
  stripe_customer_id VARCHAR(255) NULL,
  stripe_subscription_id VARCHAR(255) NULL,
  current_period_start DATETIME NOT NULL,
  current_period_end DATETIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user_subscription (user_id),
  INDEX idx_billing_sub_stripe (stripe_subscription_id),
  CONSTRAINT fk_billing_sub_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_billing_sub_plan FOREIGN KEY (plan_id) REFERENCES billing_plans(id)
);

CREATE TABLE IF NOT EXISTS enterprise_contracts (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  paid_credit_amount INT NOT NULL,
  bonus_credit_percent INT NOT NULL DEFAULT 0,
  rollover_months_cap INT NOT NULL DEFAULT 0,
  seat_count INT NOT NULL DEFAULT 1,
  notes TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_enterprise_user (user_id),
  CONSTRAINT fk_enterprise_contract_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS credit_packs (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  credit_amount INT NOT NULL,
  price_cents INT NOT NULL,
  paid_tiers_only TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS credit_ledgers (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  plan_id VARCHAR(36) NOT NULL,
  cycle_start DATETIME NOT NULL,
  cycle_end DATETIME NOT NULL,
  paid_credits_granted INT NOT NULL DEFAULT 0,
  paid_credits_remaining INT NOT NULL DEFAULT 0,
  bonus_credits_granted INT NOT NULL DEFAULT 0,
  bonus_credits_remaining INT NOT NULL DEFAULT 0,
  bonus_unlocked TINYINT(1) NOT NULL DEFAULT 0,
  bonus_percent_snapshot INT NOT NULL DEFAULT 0,
  bonus_expires_at DATETIME NULL,
  rolled_over_from_cycle_id VARCHAR(36) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user_cycle (user_id, cycle_start),
  INDEX idx_ledger_user_window (user_id, cycle_start, cycle_end),
  INDEX idx_ledger_bonus_expiry (bonus_expires_at),
  CONSTRAINT fk_ledger_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ledger_plan FOREIGN KEY (plan_id) REFERENCES billing_plans(id),
  CONSTRAINT fk_ledger_rollover FOREIGN KEY (rolled_over_from_cycle_id) REFERENCES credit_ledgers(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  ledger_id VARCHAR(36) NOT NULL,
  type VARCHAR(32) NOT NULL,
  amount INT NOT NULL,
  balance_after INT NOT NULL,
  source VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_txn_user_created (user_id, created_at),
  INDEX idx_txn_ledger (ledger_id),
  CONSTRAINT fk_txn_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_txn_ledger FOREIGN KEY (ledger_id) REFERENCES credit_ledgers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  id VARCHAR(191) PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO billing_plans (
  id, name, display_name, description, price_cents, yearly_price_cents, billing_cadence,
  paid_credit_amount, bonus_credit_percent, rollover_months_cap, is_custom, is_recommended,
  bonus_terms_copy, features_json, sort_order
) VALUES
(
  'free', 'free', 'Free', 'For exploring secure agentic deployment',
  0, 0, 'monthly', 5, 0, 0, 0, 0,
  'The Free plan includes a small monthly allotment of paid credits. Unused paid credits do not roll over, and this plan never receives bonus credits.',
  '["1 project","Repo analysis agent","Basic security scan","Community support"]',
  10
),
(
  'starter_20', 'starter_20', 'Starter', 'For individuals shipping production workloads',
  2000, 19200, 'monthly', 20, 25, 1, 0, 0,
  'Paid credits are granted at the start of each billing cycle. After you use every paid credit, up to 25% extra bonus credits unlock. Bonus credits expire at the end of the calendar month they were unlocked and never roll over. Unused paid credits may roll over for one additional month.',
  '["Unlimited projects","Security scanning","Terraform generation","Email support"]',
  20
),
(
  'pro_50', 'pro_50', 'Pro', 'For growing teams and platforms',
  5000, 48000, 'monthly', 50, 40, 2, 0, 1,
  'Paid credits are granted at the start of each billing cycle. After you use every paid credit, up to 40% extra bonus credits unlock. Bonus credits expire at the end of the calendar month they were unlocked and never roll over. Unused paid credits may roll over for up to two additional months.',
  '["Everything in Starter","Frontend customizations","Vulnerability fixes","Traffic-based cost estimation","Priority support"]',
  30
),
(
  'enterprise', 'enterprise', 'Enterprise', 'For large-scale operations',
  0, 0, 'monthly', 0, 0, 0, 1, 0,
  'Enterprise credits are provisioned from your contract rather than standard plan math. Contact sales to set pooled allotments, seats, bonus terms, and rollover. Bonus credits still expire at calendar month-end after they unlock.',
  '["Everything in Pro","Custom contracts","Pooled credits across seats","24/7 dedicated support","SLA and security review"]',
  40
);

INSERT IGNORE INTO credit_packs (id, name, credit_amount, price_cents, paid_tiers_only) VALUES
  ('pack_10', '10 extra credits', 10, 1200, 1),
  ('pack_25', '25 extra credits', 25, 3200, 1),
  ('pack_50', '50 extra credits', 50, 7000, 1);
