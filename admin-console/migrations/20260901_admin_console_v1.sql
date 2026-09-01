-- Private owner admin console tables (separate from platform user auth).
USE deplai;

CREATE TABLE IF NOT EXISTS admin_accounts (
  id VARCHAR(36) PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'OWNER',
  status ENUM('ACTIVE', 'LOCKED', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
  failed_login_count INT NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  last_login_at DATETIME NULL,
  password_changed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_admin_accounts_status (status, email)
);

CREATE TABLE IF NOT EXISTS admin_mfa_credentials (
  id VARCHAR(36) PRIMARY KEY,
  admin_id VARCHAR(36) NOT NULL,
  kind ENUM('TOTP', 'WEBAUTHN') NOT NULL,
  label VARCHAR(120) NOT NULL,
  secret_encrypted TEXT NULL,
  credential_json JSON NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME NULL,
  revoked_at DATETIME NULL,
  INDEX idx_admin_mfa_admin (admin_id, kind, revoked_at),
  CONSTRAINT fk_admin_mfa_admin FOREIGN KEY (admin_id) REFERENCES admin_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_recovery_codes (
  id VARCHAR(36) PRIMARY KEY,
  admin_id VARCHAR(36) NOT NULL,
  code_hash CHAR(64) NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_recovery_admin (admin_id, used_at),
  CONSTRAINT fk_admin_recovery_admin FOREIGN KEY (admin_id) REFERENCES admin_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id VARCHAR(36) PRIMARY KEY,
  admin_id VARCHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  csrf_token_hash CHAR(64) NOT NULL,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  mfa_verified TINYINT(1) NOT NULL DEFAULT 0,
  elevated_until DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  absolute_expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  INDEX idx_admin_sessions_admin (admin_id, revoked_at, expires_at),
  CONSTRAINT fk_admin_sessions_admin FOREIGN KEY (admin_id) REFERENCES admin_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_step_up_grants (
  id VARCHAR(36) PRIMARY KEY,
  session_id VARCHAR(36) NOT NULL,
  admin_id VARCHAR(36) NOT NULL,
  scope VARCHAR(64) NOT NULL,
  granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  INDEX idx_admin_step_up_session (session_id, expires_at),
  CONSTRAINT fk_admin_step_up_session FOREIGN KEY (session_id) REFERENCES admin_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_admin_step_up_admin FOREIGN KEY (admin_id) REFERENCES admin_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id VARCHAR(36) PRIMARY KEY,
  previous_hash CHAR(64) NOT NULL,
  event_hash CHAR(64) NOT NULL,
  actor_admin_id VARCHAR(36) NULL,
  action VARCHAR(96) NOT NULL,
  target_type VARCHAR(64) NULL,
  target_id VARCHAR(64) NULL,
  request_id VARCHAR(64) NULL,
  ip VARCHAR(64) NULL,
  session_id VARCHAR(36) NULL,
  success TINYINT(1) NOT NULL DEFAULT 1,
  reason VARCHAR(512) NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  metadata_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_audit_created (created_at),
  INDEX idx_admin_audit_action (action, created_at),
  INDEX idx_admin_audit_target (target_type, target_id, created_at)
);

CREATE TABLE IF NOT EXISTS admin_security_events (
  id VARCHAR(36) PRIMARY KEY,
  admin_id VARCHAR(36) NULL,
  event_type VARCHAR(96) NOT NULL,
  ip VARCHAR(64) NULL,
  metadata_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_security_events (event_type, created_at),
  CONSTRAINT fk_admin_security_admin FOREIGN KEY (admin_id) REFERENCES admin_accounts(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  ip VARCHAR(64) NULL,
  success TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_login_attempts_ip (ip, created_at),
  INDEX idx_admin_login_attempts_email (email, created_at)
);

CREATE TABLE IF NOT EXISTS admin_pending_auth (
  id VARCHAR(36) PRIMARY KEY,
  admin_id VARCHAR(36) NOT NULL,
  kind ENUM('PASSWORD', 'MFA', 'STEP_UP') NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  ip VARCHAR(64) NULL,
  metadata_json JSON NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_pending_auth_expires (expires_at),
  CONSTRAINT fk_admin_pending_auth_admin FOREIGN KEY (admin_id) REFERENCES admin_accounts(id) ON DELETE CASCADE
);
