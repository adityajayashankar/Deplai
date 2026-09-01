-- Resource control tables for the private admin console.
USE deplai;

CREATE TABLE IF NOT EXISTS admin_project_controls (
  project_id VARCHAR(36) PRIMARY KEY,
  status ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'DISABLED',
  reason VARCHAR(255) NULL,
  disabled_by_admin_id VARCHAR(36) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_admin_project_controls_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
