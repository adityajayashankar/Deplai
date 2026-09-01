-- Widen referral_code for username-tag + cryptographic suffix format (e.g. ADITYA-X7K2M9)

ALTER TABLE user_profiles
  MODIFY COLUMN referral_code VARCHAR(24) NOT NULL;
