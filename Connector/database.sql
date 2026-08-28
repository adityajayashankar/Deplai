CREATE DATABASE IF NOT EXISTS deplai;
USE deplai;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- GitHub installations
CREATE TABLE IF NOT EXISTS github_installations (
    id VARCHAR(36) PRIMARY KEY,
    installation_id BIGINT NOT NULL UNIQUE,
    account_login VARCHAR(255) NOT NULL,
    account_type VARCHAR(50) NOT NULL,
    user_id VARCHAR(36) NULL,
    installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    suspended_at TIMESTAMP NULL,
    metadata JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_account_login (account_login),
    INDEX idx_user_id (user_id)
);

-- GitHub repositories
CREATE TABLE IF NOT EXISTS github_repositories (
    id VARCHAR(36) PRIMARY KEY,
    installation_id VARCHAR(36) NOT NULL,
    github_repo_id BIGINT NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    default_branch VARCHAR(255) DEFAULT 'main',
    is_private BOOLEAN NOT NULL,
    languages JSON,
    webhook_id BIGINT,
    last_synced_at TIMESTAMP NULL,
    metadata JSON,
    needs_refresh BOOLEAN DEFAULT true,
    user_hidden BOOLEAN DEFAULT false,
    last_cloned_at TIMESTAMP NULL,
    last_commit_sha VARCHAR(40) NULL,
    last_push_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (installation_id) REFERENCES github_installations(id) ON DELETE CASCADE,
    UNIQUE KEY unique_repo (installation_id, github_repo_id),
    INDEX idx_full_name (full_name),
    INDEX idx_needs_refresh (needs_refresh)
);

-- Projects
CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    project_type VARCHAR(20) NOT NULL DEFAULT 'github',
    repository_id VARCHAR(36) NULL,
    local_path VARCHAR(500) NULL,
    file_count INT NULL,
    size_bytes BIGINT NULL,
    user_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (repository_id) REFERENCES github_repositories(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_project_type (project_type),
    INDEX idx_user_type (user_id, project_type)
);
-- ------------------------------------------------------------------------------
-- Chat sessions (agent chat history stored per user)
-- Limits: max 50 sessions per user, max 200 messages per session (enforced in API)
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chat_sessions (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL DEFAULT 'New chat',
    message_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_chat_sessions_user (user_id, updated_at)
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    metadata JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
    INDEX idx_chat_messages_session (session_id, created_at)
);

-- Workspace and tenant settings. This was previously created lazily by the
-- API route; declaring it here keeps fresh Docker deployments deterministic.
CREATE TABLE IF NOT EXISTS user_settings (
    user_id VARCHAR(36) PRIMARY KEY,
    data_json JSON NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------------------
-- Billing / credit provisioning (see Connector/migrations/20260826_credit_provisioning.sql)
-- ------------------------------------------------------------------------------

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
  razorpay_customer_id VARCHAR(255) NULL,
  razorpay_subscription_id VARCHAR(255) NULL,
  current_period_start DATETIME NOT NULL,
  current_period_end DATETIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user_subscription (user_id),
  INDEX idx_billing_sub_stripe (stripe_subscription_id),
  INDEX idx_billing_sub_razorpay (razorpay_subscription_id),
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
  status VARCHAR(16) NOT NULL DEFAULT 'completed',
  processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
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

CREATE TABLE IF NOT EXISTS billing_profiles (
  user_id VARCHAR(36) PRIMARY KEY,
  legal_name VARCHAR(255) NULL,
  gstin VARCHAR(15) NULL,
  address TEXT NULL,
  state_code VARCHAR(8) NULL,
  state_name VARCHAR(64) NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_billing_profile_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS billing_razorpay_plans (
  local_key VARCHAR(191) PRIMARY KEY,
  razorpay_plan_id VARCHAR(64) NOT NULL,
  amount_paise INT NOT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'INR',
  period VARCHAR(16) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS billing_checkout_intents (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  plan_id VARCHAR(36) NULL,
  credit_pack_id VARCHAR(36) NULL,
  cadence VARCHAR(16) NULL,
  display_amount_cents INT NOT NULL,
  taxable_paise INT NOT NULL,
  cgst_paise INT NOT NULL DEFAULT 0,
  sgst_paise INT NOT NULL DEFAULT 0,
  igst_paise INT NOT NULL DEFAULT 0,
  total_paise INT NOT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'INR',
  tax_split VARCHAR(16) NOT NULL,
  buyer_gstin VARCHAR(15) NULL,
  buyer_name VARCHAR(255) NULL,
  buyer_address TEXT NULL,
  buyer_state_code VARCHAR(8) NULL,
  buyer_state_name VARCHAR(64) NULL,
  razorpay_order_id VARCHAR(64) NULL,
  razorpay_subscription_id VARCHAR(64) NULL,
  razorpay_plan_id VARCHAR(64) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_intent_user (user_id, created_at),
  INDEX idx_intent_order (razorpay_order_id),
  INDEX idx_intent_subscription (razorpay_subscription_id),
  CONSTRAINT fk_intent_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS billing_invoice_sequences (
  fy VARCHAR(8) PRIMARY KEY,
  last_number INT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_invoices (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  invoice_number VARCHAR(64) NOT NULL,
  invoice_date DATE NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'paid',
  kind VARCHAR(32) NOT NULL,
  description VARCHAR(255) NOT NULL,
  hsn_sac VARCHAR(16) NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  seller_legal_name VARCHAR(255) NOT NULL,
  seller_gstin VARCHAR(32) NULL,
  seller_address TEXT NULL,
  seller_state_code VARCHAR(8) NULL,
  seller_state_name VARCHAR(64) NULL,
  buyer_name VARCHAR(255) NOT NULL,
  buyer_email VARCHAR(255) NOT NULL,
  buyer_gstin VARCHAR(15) NULL,
  buyer_address TEXT NULL,
  buyer_state_code VARCHAR(8) NULL,
  buyer_state_name VARCHAR(64) NULL,
  place_of_supply VARCHAR(128) NULL,
  reverse_charge TINYINT(1) NOT NULL DEFAULT 0,
  display_amount_cents INT NOT NULL,
  display_currency VARCHAR(8) NOT NULL DEFAULT 'USD',
  taxable_paise INT NOT NULL,
  cgst_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  sgst_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  igst_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  cgst_paise INT NOT NULL DEFAULT 0,
  sgst_paise INT NOT NULL DEFAULT 0,
  igst_paise INT NOT NULL DEFAULT 0,
  total_paise INT NOT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'INR',
  razorpay_order_id VARCHAR(64) NULL,
  razorpay_payment_id VARCHAR(64) NULL,
  razorpay_subscription_id VARCHAR(64) NULL,
  plan_id VARCHAR(36) NULL,
  credit_pack_id VARCHAR(36) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_invoice_number (invoice_number),
  UNIQUE KEY unique_razorpay_payment (razorpay_payment_id),
  INDEX idx_invoice_user_date (user_id, invoice_date),
  CONSTRAINT fk_invoice_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS billing_fulfillment_attempts (
  id VARCHAR(36) PRIMARY KEY,
  razorpay_payment_id VARCHAR(64) NULL,
  razorpay_order_id VARCHAR(64) NULL,
  source VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL,
  error_message TEXT NULL,
  raw_payload JSON NULL,
  attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  INDEX idx_fulfillment_payment (razorpay_payment_id, attempted_at),
  INDEX idx_fulfillment_status (status, attempted_at)
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id VARCHAR(36) PRIMARY KEY,
  actor VARCHAR(255) NOT NULL,
  action VARCHAR(64) NOT NULL,
  target VARCHAR(191) NOT NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  reason TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_audit_created (created_at),
  INDEX idx_admin_audit_target (target, created_at)
);

-- ------------------------------------------------------------------------------
-- AI platform control plane (also ensured at runtime by Connector)
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_providers (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    display_name VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    documentation_url VARCHAR(512) NOT NULL,
    api_base_url VARCHAR(512) NOT NULL,
    supports_json JSON NOT NULL,
    authentication_type VARCHAR(32) NOT NULL,
    credential_schema_json JSON NOT NULL,
    env_key_names_json JSON NOT NULL,
    brand_color VARCHAR(16) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_models (
    id VARCHAR(191) PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL,
    provider_model_id VARCHAR(191) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    family VARCHAR(128) NOT NULL,
    version VARCHAR(64) NOT NULL,
    aliases_json JSON NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    lifecycle VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    release_date DATE NULL,
    deprecation_date DATE NULL,
    retirement_date DATE NULL,
    replacement_model_id VARCHAR(191) NULL,
    context_window INT NOT NULL DEFAULT 0,
    max_output_tokens INT NOT NULL DEFAULT 0,
    capabilities_json JSON NOT NULL,
    latency_profile VARCHAR(32) NOT NULL DEFAULT 'balanced',
    pricing_json JSON NOT NULL,
    region_support_json JSON NOT NULL,
    compliance_tags_json JSON NOT NULL,
    model_owner VARCHAR(128) NULL,
    metadata_json JSON NOT NULL,
    discovered_at DATETIME NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_provider_model (provider_id, provider_model_id),
    INDEX idx_ai_models_provider (provider_id),
    INDEX idx_ai_models_lifecycle (lifecycle)
);

CREATE TABLE IF NOT EXISTS ai_provider_credentials (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    provider_id VARCHAR(64) NOT NULL,
    name VARCHAR(128) NOT NULL,
    type VARCHAR(32) NOT NULL DEFAULT 'BYOK',
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    secret_encrypted TEXT NOT NULL,
    secret_masked VARCHAR(32) NOT NULL,
    environment VARCHAR(32) NOT NULL DEFAULT 'production',
    scope VARCHAR(128) NULL,
    allowed_model_ids_json JSON NULL,
    created_by VARCHAR(36) NOT NULL,
    last_validated_at DATETIME NULL,
    last_used_at DATETIME NULL,
    expires_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_ai_creds_user (user_id),
    INDEX idx_ai_creds_user_provider (user_id, provider_id),
    CONSTRAINT fk_ai_creds_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_routing_policies (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    name VARCHAR(128) NOT NULL,
    task_type VARCHAR(64) NOT NULL DEFAULT 'general',
    primary_alias VARCHAR(64) NOT NULL DEFAULT 'best',
    secondary_alias VARCHAR(64) NULL,
    fallback_model_id VARCHAR(191) NULL,
    access_mode VARCHAR(16) NOT NULL DEFAULT 'auto',
    allowed_providers_json JSON NOT NULL,
    weights_json JSON NOT NULL,
    is_default TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_ai_routing_user (user_id),
    CONSTRAINT fk_ai_routing_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_organization_policies (
    user_id VARCHAR(36) PRIMARY KEY,
    policy_json JSON NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_ai_org_policy_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_usage (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    request_id VARCHAR(36) NOT NULL,
    provider_id VARCHAR(64) NOT NULL,
    model_id VARCHAR(191) NOT NULL,
    credential_source VARCHAR(32) NOT NULL,
    input_tokens INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    cached_tokens INT NOT NULL DEFAULT 0,
    reasoning_tokens INT NOT NULL DEFAULT 0,
    tool_calls INT NOT NULL DEFAULT 0,
    estimated TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ai_usage_user_created (user_id, created_at),
    CONSTRAINT fk_ai_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_costs (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    request_id VARCHAR(36) NOT NULL,
    provider_cost_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
    platform_cost_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
    customer_charge_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
    billing_source VARCHAR(16) NOT NULL,
    estimated TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ai_costs_user_created (user_id, created_at),
    CONSTRAINT fk_ai_costs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_request_logs (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    trace_id VARCHAR(36) NOT NULL,
    provider_id VARCHAR(64) NULL,
    model_id VARCHAR(191) NULL,
    credential_source VARCHAR(32) NULL,
    routing_policy VARCHAR(128) NULL,
    status VARCHAR(32) NOT NULL,
    error_code VARCHAR(64) NULL,
    latency_ms INT NULL,
    ttft_ms INT NULL,
    retry_count INT NOT NULL DEFAULT 0,
    fallback_count INT NOT NULL DEFAULT 0,
    routing_explanation_json JSON NULL,
    metadata_json JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ai_logs_user_created (user_id, created_at),
    CONSTRAINT fk_ai_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_provider_health (
    provider_id VARCHAR(64) PRIMARY KEY,
    status VARCHAR(32) NOT NULL,
    availability DECIMAL(5,4) NOT NULL DEFAULT 0,
    latency_ms INT NULL,
    error_rate DECIMAL(5,4) NOT NULL DEFAULT 0,
    rate_limit_rate DECIMAL(5,4) NOT NULL DEFAULT 0,
    timeout_rate DECIMAL(5,4) NOT NULL DEFAULT 0,
    detail VARCHAR(512) NULL,
    checked_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_model_health (
    model_id VARCHAR(191) PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL,
    detail VARCHAR(512) NULL,
    checked_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_audit_events (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    actor VARCHAR(128) NOT NULL,
    action VARCHAR(64) NOT NULL,
    resource VARCHAR(191) NOT NULL,
    result VARCHAR(32) NOT NULL,
    metadata_json JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ai_audit_user_created (user_id, created_at),
    CONSTRAINT fk_ai_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_profiles (
    user_id VARCHAR(36) PRIMARY KEY,
    display_name VARCHAR(80) NULL,
    contact_email VARCHAR(255) NULL,
    linkedin_url VARCHAR(255) NULL,
    github_url VARCHAR(255) NULL,
    routing_mode VARCHAR(32) NOT NULL DEFAULT 'default',
    efficient_pool_json JSON NOT NULL,
    auto_topup_enabled TINYINT(1) NOT NULL DEFAULT 0,
    auto_topup_threshold_usd INT NOT NULL DEFAULT 5,
    auto_topup_add_usd INT NOT NULL DEFAULT 20,
    payment_method_last4 VARCHAR(4) NULL,
    referral_code VARCHAR(16) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_referral_code (referral_code),
    CONSTRAINT fk_user_profiles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_api_tokens (
    user_id VARCHAR(36) PRIMARY KEY,
    token_hash CHAR(64) NOT NULL,
    token_encrypted TEXT NOT NULL,
    token_prefix VARCHAR(16) NOT NULL,
    token_last4 VARCHAR(4) NOT NULL,
    last_used_at DATETIME NULL,
    last_used_client VARCHAR(32) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_user_api_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS promo_codes (
    code VARCHAR(32) PRIMARY KEY,
    credit_amount INT NOT NULL,
    max_redemptions INT NULL,
    redeemed_count INT NOT NULL DEFAULT 0,
    expires_at DATETIME NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    code VARCHAR(32) NOT NULL,
    credit_amount INT NOT NULL,
    redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_user_promo (user_id, code),
    INDEX idx_promo_redemptions_code (code),
    CONSTRAINT fk_promo_redemptions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_sessions (
    id VARCHAR(40) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(36) NULL,
    service VARCHAR(32) NOT NULL,
    title VARCHAR(255) NOT NULL,
    repo VARCHAR(255) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'running',
    current_stage VARCHAR(64) NULL,
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    changed_files_count INT NOT NULL DEFAULT 0,
    triggered_by VARCHAR(36) NOT NULL,
    external_id VARCHAR(191) NULL,
    metadata_json JSON NULL,
    INDEX idx_workspace_sessions_user_started (user_id, started_at),
    INDEX idx_workspace_sessions_user_service (user_id, service, started_at),
    INDEX idx_workspace_sessions_user_status (user_id, status),
    INDEX idx_workspace_sessions_project (user_id, project_id, started_at),
    INDEX idx_workspace_sessions_external (user_id, service, external_id),
    CONSTRAINT fk_workspace_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_session_logs (
    id VARCHAR(40) PRIMARY KEY,
    session_id VARCHAR(40) NOT NULL,
    ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    level VARCHAR(16) NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    stage VARCHAR(64) NULL,
    INDEX idx_workspace_session_logs_session_ts (session_id, ts),
    CONSTRAINT fk_workspace_session_logs_session FOREIGN KEY (session_id) REFERENCES workspace_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dast_assets (
    id VARCHAR(36) PRIMARY KEY,
    project_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    target_url VARCHAR(2048) NOT NULL,
    normalized_url VARCHAR(2048) NOT NULL,
    hostname VARCHAR(255) NOT NULL,
    scheme VARCHAR(10) NOT NULL,
    port INT NULL,
    path_prefix VARCHAR(512) NULL,
    environment VARCHAR(32) NOT NULL DEFAULT 'production',
    scope_mode VARCHAR(32) NOT NULL DEFAULT 'VERIFIED_HOST',
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    verification_method VARCHAR(32) NULL,
    verification_token_hash CHAR(64) NOT NULL,
    verification_token VARCHAR(128) NULL,
    verified_at DATETIME NULL,
    expires_at DATETIME NULL,
    last_checked_at DATETIME NULL,
    revoked_at DATETIME NULL,
    evidence_hash VARCHAR(64) NULL,
    created_by VARCHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    INDEX idx_dast_assets_project_status (project_id, status),
    INDEX idx_dast_assets_user (user_id),
    INDEX idx_dast_assets_host (project_id, hostname),
    CONSTRAINT fk_dast_assets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dast_scans (
    id VARCHAR(36) PRIMARY KEY,
    project_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    asset_id VARCHAR(36) NOT NULL,
    target_url VARCHAR(2048) NOT NULL,
    scan_profile VARCHAR(16) NOT NULL DEFAULT 'BASELINE',
    scan_intent VARCHAR(16) NOT NULL DEFAULT 'PASSIVE',
    status VARCHAR(32) NOT NULL DEFAULT 'queued',
    scan_stage VARCHAR(64) NULL,
    compliance_status VARCHAR(64) NULL,
    authorization_reason VARCHAR(64) NULL,
    idempotency_key VARCHAR(80) NULL,
    retry_count INT NOT NULL DEFAULT 0,
    finding_count INT NOT NULL DEFAULT 0,
    error_code VARCHAR(64) NULL,
    error_message VARCHAR(512) NULL,
    started_at DATETIME NULL,
    finished_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_dast_scans_idempotency (user_id, idempotency_key),
    INDEX idx_dast_scans_project (project_id, created_at),
    CONSTRAINT fk_dast_scans_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_dast_scans_asset FOREIGN KEY (asset_id) REFERENCES dast_assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dast_audit_events (
    id VARCHAR(40) PRIMARY KEY,
    project_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    asset_id VARCHAR(36) NULL,
    scan_id VARCHAR(36) NULL,
    action VARCHAR(64) NOT NULL,
    decision VARCHAR(32) NOT NULL,
    reason VARCHAR(128) NULL,
    policy_version VARCHAR(32) NOT NULL DEFAULT '2026.08.1',
    correlation_id VARCHAR(64) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_dast_audit_project (project_id, created_at),
    INDEX idx_dast_audit_scan (scan_id),
    CONSTRAINT fk_dast_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deploy_exec_deployments (
    id VARCHAR(36) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    environment_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'CREATED',
    result_class VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    stage VARCHAR(64) NULL,
    artifact_digest VARCHAR(80) NOT NULL,
    artifact_image VARCHAR(512) NOT NULL,
    instance_id VARCHAR(32) NOT NULL,
    account_id VARCHAR(12) NULL,
    region VARCHAR(32) NOT NULL,
    source_commit VARCHAR(64) NULL,
    public_endpoint VARCHAR(512) NULL,
    error_code VARCHAR(64) NULL,
    error_message VARCHAR(512) NULL,
    dry_run TINYINT(1) NOT NULL DEFAULT 0,
    retry_count INT NOT NULL DEFAULT 0,
    started_at DATETIME NULL,
    finished_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    INDEX idx_deploy_exec_project (project_id, created_at),
    INDEX idx_deploy_exec_env (project_id, environment_id, created_at),
    CONSTRAINT fk_deploy_exec_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deploy_exec_events (
    id VARCHAR(40) PRIMARY KEY,
    deployment_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    event_name VARCHAR(64) NOT NULL,
    status VARCHAR(32) NULL,
    payload_json JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_deploy_exec_events_dep (deployment_id, created_at),
    CONSTRAINT fk_deploy_exec_events_dep FOREIGN KEY (deployment_id) REFERENCES deploy_exec_deployments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deploy_exec_locks (
    environment_key VARCHAR(128) PRIMARY KEY,
    deployment_id VARCHAR(36) NOT NULL,
    locked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deploy_exec_artifacts (
    id VARCHAR(36) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    image VARCHAR(512) NOT NULL,
    digest VARCHAR(80) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PROMOTED',
    source_commit VARCHAR(64) NULL,
    build_id VARCHAR(64) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_deploy_exec_digest (project_id, digest),
    INDEX idx_deploy_exec_art_project (project_id, created_at),
    CONSTRAINT fk_deploy_exec_art_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
