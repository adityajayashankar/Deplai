-- Per-organization OpenRouter API keys (capped via Management API on purchase / top-up).

CREATE TABLE IF NOT EXISTS organization_openrouter_keys (
  organization_id VARCHAR(36) PRIMARY KEY,
  key_hash VARCHAR(128) NOT NULL,
  secret_encrypted TEXT NOT NULL,
  secret_masked VARCHAR(32) NOT NULL,
  limit_usd DECIMAL(12,2) NOT NULL DEFAULT 0,
  limit_reset VARCHAR(16) NOT NULL DEFAULT 'monthly',
  disabled TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_org_openrouter_disabled (disabled)
);
