import { query } from '@/lib/db';

const TABLES = [
  `CREATE TABLE IF NOT EXISTS deploy_exec_deployments (
    id VARCHAR(36) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    organization_id VARCHAR(36) NULL,
    environment_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'CREATED',
    result_class VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    stage VARCHAR(64) NULL,
    artifact_digest VARCHAR(80) NOT NULL,
    artifact_image VARCHAR(512) NOT NULL,
    instance_id VARCHAR(32) NOT NULL,
    account_id VARCHAR(12) NULL,
    region VARCHAR(32) NOT NULL,
    source_commit VARCHAR(64) NULL,
    public_endpoint VARCHAR(512) NULL,
    error_code VARCHAR(64) NULL,
    error_message VARCHAR(512) NULL,
    dry_run TINYINT(1) NOT NULL DEFAULT 0,
    retry_count INT NOT NULL DEFAULT 0,
    started_at DATETIME NULL,
    finished_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    INDEX idx_deploy_exec_project (project_id, created_at),
    INDEX idx_deploy_exec_org (organization_id, project_id, created_at),
    INDEX idx_deploy_exec_env (project_id, environment_id, created_at),
    CONSTRAINT fk_deploy_exec_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_deploy_exec_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS deploy_exec_events (
    id VARCHAR(40) PRIMARY KEY,
    deployment_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    organization_id VARCHAR(36) NULL,
    event_name VARCHAR(64) NOT NULL,
    status VARCHAR(32) NULL,
    payload_json JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_deploy_exec_events_dep (deployment_id, created_at),
    INDEX idx_deploy_exec_events_org (organization_id, created_at),
    CONSTRAINT fk_deploy_exec_events_dep FOREIGN KEY (deployment_id) REFERENCES deploy_exec_deployments(id) ON DELETE CASCADE,
    CONSTRAINT fk_deploy_exec_events_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS deploy_exec_locks (
    environment_key VARCHAR(128) PRIMARY KEY,
    deployment_id VARCHAR(36) NOT NULL,
    locked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS deploy_exec_artifacts (
    id VARCHAR(36) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    organization_id VARCHAR(36) NULL,
    image VARCHAR(512) NOT NULL,
    digest VARCHAR(80) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PROMOTED',
    source_commit VARCHAR(64) NULL,
    build_id VARCHAR(64) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_deploy_exec_digest (project_id, digest),
    INDEX idx_deploy_exec_art_project (project_id, created_at),
    INDEX idx_deploy_exec_art_org (organization_id, project_id, created_at),
    CONSTRAINT fk_deploy_exec_art_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_deploy_exec_art_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
  )`,
];

let ready: Promise<void> | null = null;

async function runEnsure() {
  for (const statement of TABLES) {
    await query(statement);
  }
}

export async function ensureDeployExecSchema(): Promise<void> {
  if (!ready) {
    ready = runEnsure().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}
