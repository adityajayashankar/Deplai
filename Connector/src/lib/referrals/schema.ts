import { query } from '@/lib/db';
import { REFERRAL_CODE_MAX_LENGTH } from './codes';

export const REFERRAL_ATTRIBUTION_CODE_MAX_LENGTH = REFERRAL_CODE_MAX_LENGTH;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS referral_attributions (
    id VARCHAR(36) PRIMARY KEY,
    referred_user_id VARCHAR(36) NOT NULL,
    referrer_user_id VARCHAR(36) NOT NULL,
    referral_code VARCHAR(${REFERRAL_ATTRIBUTION_CODE_MAX_LENGTH}) NOT NULL,
    status ENUM('pending','converted','expired','ineligible') NOT NULL DEFAULT 'pending',
    attributed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    converted_at TIMESTAMP NULL,
    first_payment_id VARCHAR(64) NULL,
    checkout_intent_id VARCHAR(36) NULL,
    referee_discount_percent INT NOT NULL,
    referee_discount_paise INT NULL,
    referrer_reward_percent INT NOT NULL,
    referrer_reward_credits INT NULL,
    referrer_rewarded_at TIMESTAMP NULL,
    UNIQUE KEY unique_referred_user (referred_user_id),
    UNIQUE KEY unique_first_payment (first_payment_id),
    INDEX idx_referrer_status (referrer_user_id, status),
    CONSTRAINT fk_ref_attr_referred FOREIGN KEY (referred_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_ref_attr_referrer FOREIGN KEY (referrer_user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS referral_events (
    id VARCHAR(36) PRIMARY KEY,
    attribution_id VARCHAR(36) NOT NULL,
    event_type VARCHAR(32) NOT NULL,
    metadata_json JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ref_event_attr (attribution_id, created_at),
    CONSTRAINT fk_ref_event_attr FOREIGN KEY (attribution_id) REFERENCES referral_attributions(id) ON DELETE CASCADE
  )`,
];

let ensured = false;

async function ensureCheckoutDiscountColumns(): Promise<void> {
  const rows = await query<Array<{ c: number }>>(
    `SELECT COUNT(*) AS c
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'billing_checkout_intents'
       AND COLUMN_NAME = 'referral_attribution_id'`,
  );
  if (Number(rows[0]?.c || 0) > 0) return;
  await query(
    `ALTER TABLE billing_checkout_intents
       ADD COLUMN referral_attribution_id VARCHAR(36) NULL AFTER buyer_state_name,
       ADD COLUMN discount_paise INT NOT NULL DEFAULT 0 AFTER referral_attribution_id`,
  );
}

async function ensureReferralCodeColumn(): Promise<void> {
  const rows = await query<Array<{ max_length: number | string | null }>>(
    `SELECT CHARACTER_MAXIMUM_LENGTH AS max_length
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'referral_attributions'
       AND COLUMN_NAME = 'referral_code'
     LIMIT 1`,
  );
  const currentLength = Number(rows[0]?.max_length || 0);
  if (currentLength >= REFERRAL_ATTRIBUTION_CODE_MAX_LENGTH) return;
  await query(
    `ALTER TABLE referral_attributions
       MODIFY COLUMN referral_code VARCHAR(${REFERRAL_ATTRIBUTION_CODE_MAX_LENGTH}) NOT NULL`,
  );
}

export async function ensureReferralSchema(): Promise<void> {
  if (ensured) return;
  for (const sql of TABLES) {
    await query(sql);
  }
  await ensureReferralCodeColumn();
  await ensureCheckoutDiscountColumns();
  ensured = true;
}
