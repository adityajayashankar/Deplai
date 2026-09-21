CREATE TABLE IF NOT EXISTS build_secret_metadata (
  reference_id VARCHAR(128) PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL,
  owner_user_id VARCHAR(36) NOT NULL,
  organization_id VARCHAR(36) NOT NULL,
  project_id VARCHAR(36) NOT NULL,
  metadata_json JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT build_secret_scope_fk FOREIGN KEY (session_id, owner_user_id, organization_id, project_id)
    REFERENCES build_sessions(session_id, owner_user_id, organization_id, project_id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS build_secret_values (
  reference_id VARCHAR(128) PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  CONSTRAINT build_secret_value_fk FOREIGN KEY (reference_id) REFERENCES build_secret_metadata(reference_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS build_secret_audit (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  reference_id VARCHAR(128) NOT NULL,
  session_id VARCHAR(64) NOT NULL,
  consumer_service VARCHAR(64) NULL,
  category VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT build_secret_audit_session_fk FOREIGN KEY (session_id) REFERENCES build_sessions(session_id) ON DELETE RESTRICT
);
