-- Payment fulfillment reliability: attempt log, webhook retry status, admin audit.
-- Review this file before applying it to any shared database.
-- Fresh Docker volumes also load the same objects from Connector/database.sql.

USE deplai;

ALTER TABLE billing_webhook_events
  ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'completed' AFTER event_type;

ALTER TABLE billing_webhook_events
  ADD COLUMN updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER processed_at;

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
