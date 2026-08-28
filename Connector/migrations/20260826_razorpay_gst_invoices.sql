-- Razorpay subscriptions + GST tax invoices.
-- Review this file before applying it to any shared database.
-- Fresh Docker volumes also load the same objects from Connector/database.sql.

USE deplai;

ALTER TABLE billing_subscriptions
  ADD COLUMN razorpay_customer_id VARCHAR(255) NULL AFTER stripe_subscription_id,
  ADD COLUMN razorpay_subscription_id VARCHAR(255) NULL AFTER razorpay_customer_id;

ALTER TABLE billing_subscriptions
  ADD INDEX idx_billing_sub_razorpay (razorpay_subscription_id);

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
