import { query } from '@/lib/db';

const TABLES = [
  `CREATE TABLE IF NOT EXISTS dast_assets (
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
  )`,
  `CREATE TABLE IF NOT EXISTS dast_scans (
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
  )`,
  `CREATE TABLE IF NOT EXISTS dast_audit_events (
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
  )`,
];

let ready: Promise<void> | null = null;

async function runEnsure() {
  for (const statement of TABLES) {
    await query(statement);
  }
}

export async function ensureDastSchema(): Promise<void> {
  if (!ready) {
    ready = runEnsure().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}
