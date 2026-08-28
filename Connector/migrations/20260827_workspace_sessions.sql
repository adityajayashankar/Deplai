-- Workspace run sessions: one record per Security / UI-UX / Deploy / Code Reviewer run,
-- with durable log lines so history survives WebSocket disconnects.
-- Fresh Docker volumes also load the same objects from Connector/database.sql.

USE deplai;

CREATE TABLE IF NOT EXISTS workspace_sessions (
  id VARCHAR(40) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  project_id VARCHAR(36) NULL,
  service VARCHAR(32) NOT NULL,
  title VARCHAR(255) NOT NULL,
  repo VARCHAR(255) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'running',
  current_stage VARCHAR(64) NULL,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  changed_files_count INT NOT NULL DEFAULT 0,
  triggered_by VARCHAR(36) NOT NULL,
  external_id VARCHAR(191) NULL,
  metadata_json JSON NULL,
  INDEX idx_workspace_sessions_user_started (user_id, started_at),
  INDEX idx_workspace_sessions_user_service (user_id, service, started_at),
  INDEX idx_workspace_sessions_user_status (user_id, status),
  INDEX idx_workspace_sessions_project (user_id, project_id, started_at),
  INDEX idx_workspace_sessions_external (user_id, service, external_id),
  CONSTRAINT fk_workspace_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_session_logs (
  id VARCHAR(40) PRIMARY KEY,
  session_id VARCHAR(40) NOT NULL,
  ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  level VARCHAR(16) NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  stage VARCHAR(64) NULL,
  INDEX idx_workspace_session_logs_session_ts (session_id, ts),
  CONSTRAINT fk_workspace_session_logs_session FOREIGN KEY (session_id) REFERENCES workspace_sessions(id) ON DELETE CASCADE
);
