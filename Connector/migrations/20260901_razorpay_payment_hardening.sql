-- Production Razorpay order, verification, state, and refund hardening.
-- Apply after 20260827_fulfillment_reliability.sql on existing databases.

USE deplai;

ALTER TABLE billing_checkout_intents
  ADD COLUMN idempotency_key VARCHAR(128) NULL AFTER user_id,
  ADD COLUMN receipt VARCHAR(40) NULL AFTER idempotency_key,
  ADD COLUMN provider VARCHAR(32) NOT NULL DEFAULT 'razorpay' AFTER receipt,
  ADD COLUMN payment_mode VARCHAR(8) NOT NULL DEFAULT 'test' AFTER provider,
  ADD COLUMN razorpay_payment_id VARCHAR(64) NULL AFTER razorpay_order_id,
  ADD COLUMN signature_verified TINYINT(1) NOT NULL DEFAULT 0 AFTER razorpay_plan_id,
  ADD COLUMN failure_code VARCHAR(64) NULL AFTER signature_verified,
  ADD COLUMN failure_description VARCHAR(255) NULL AFTER failure_code,
  ADD COLUMN captured_at DATETIME NULL AFTER failure_description,
  ADD COLUMN updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at,
  ADD UNIQUE KEY unique_intent_idempotency (user_id, idempotency_key),
  ADD UNIQUE KEY unique_intent_receipt (receipt),
  ADD UNIQUE KEY unique_intent_payment (razorpay_payment_id),
  ADD INDEX idx_intent_status (status, updated_at);

ALTER TABLE billing_invoices
  ADD COLUMN checkout_intent_id VARCHAR(36) NULL AFTER user_id,
  ADD INDEX idx_invoice_intent (checkout_intent_id),
  ADD CONSTRAINT fk_invoice_intent FOREIGN KEY (checkout_intent_id)
    REFERENCES billing_checkout_intents(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS billing_refunds (
  id VARCHAR(36) PRIMARY KEY,
  checkout_intent_id VARCHAR(36) NOT NULL,
  provider_refund_id VARCHAR(64) NULL,
  amount_paise INT NOT NULL,
  status VARCHAR(32) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  requested_by_admin_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_provider_refund (provider_refund_id),
  INDEX idx_refund_intent (checkout_intent_id, created_at),
  CONSTRAINT fk_refund_intent FOREIGN KEY (checkout_intent_id)
    REFERENCES billing_checkout_intents(id) ON DELETE RESTRICT
);
