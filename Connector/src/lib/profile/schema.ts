import { query } from '@/lib/db';

const TABLES = [
  `CREATE TABLE IF NOT EXISTS user_profiles (
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
    referral_code VARCHAR(24) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_referral_code (referral_code),
    CONSTRAINT fk_user_profiles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS user_api_tokens (
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
  )`,
  `CREATE TABLE IF NOT EXISTS promo_codes (
    code VARCHAR(32) PRIMARY KEY,
    credit_amount INT NOT NULL,
    max_redemptions INT NULL,
    redeemed_count INT NOT NULL DEFAULT 0,
    expires_at DATETIME NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS promo_redemptions (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    code VARCHAR(32) NOT NULL,
    credit_amount INT NOT NULL,
    redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_user_promo (user_id, code),
    INDEX idx_promo_redemptions_code (code),
    CONSTRAINT fk_promo_redemptions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
];

let ensured = false;

export async function ensureProfileSchema(): Promise<void> {
  if (ensured) return;
  for (const sql of TABLES) {
    await query(sql);
  }
  try {
    await query(
      `ALTER TABLE user_profiles MODIFY COLUMN referral_code VARCHAR(24) NOT NULL`,
    );
  } catch {
    /* column already widened */
  }
  ensured = true;
}
