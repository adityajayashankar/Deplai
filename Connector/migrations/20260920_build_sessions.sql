-- Additive Phase 0.5 foundation. No existing product tables are modified.
CREATE TABLE IF NOT EXISTS build_sessions (
  session_id VARCHAR(64) PRIMARY KEY,
  owner_user_id VARCHAR(36) NOT NULL,
  organization_id VARCHAR(36) NOT NULL,
  project_id VARCHAR(36) NOT NULL,
  source_type ENUM('NEW_PROJECT','IMPORT_REPOSITORY') NOT NULL,
  source_revision VARCHAR(64) NULL,
  state ENUM('DRAFT','ANALYZING','PLANNING','BUILDING','PREVIEW_STARTING','PREVIEW_READY','VERIFYING','WAITING_FOR_USER','READY_TO_DEPLOY','FAILED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  active_worktree_id VARCHAR(64) NULL,
  active_preview_revision VARCHAR(64) NULL,
  preview_id VARCHAR(64) NULL,
  secret_scope_id VARCHAR(64) NOT NULL,
  quota_profile_id VARCHAR(64) NOT NULL,
  quota_json JSON NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 0,
  failure_reason VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_activity_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY build_session_scope (session_id, owner_user_id, organization_id, project_id),
  INDEX build_session_owner (owner_user_id, organization_id, project_id, updated_at),
  CONSTRAINT build_session_user_fk FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT build_session_org_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT build_session_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS build_resources (
  resource_id VARCHAR(64) PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL,
  owner_user_id VARCHAR(36) NOT NULL,
  organization_id VARCHAR(36) NOT NULL,
  project_id VARCHAR(36) NOT NULL,
  kind ENUM('workspace','worktree','preview','database','cache','worker','secret_scope','log','artifact','browser') NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT build_resource_scope_fk FOREIGN KEY (session_id, owner_user_id, organization_id, project_id)
    REFERENCES build_sessions(session_id, owner_user_id, organization_id, project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS build_session_events (
  session_id VARCHAR(64) NOT NULL,
  sequence INT UNSIGNED NOT NULL,
  state VARCHAR(32) NOT NULL,
  reason_code VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (session_id, sequence),
  CONSTRAINT build_event_session_fk FOREIGN KEY (session_id) REFERENCES build_sessions(session_id) ON DELETE RESTRICT
);
