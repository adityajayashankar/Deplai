-- Organizations v1: additive tenancy, RBAC, invitations, teams, audit, and
-- organization ownership for existing DeplAI resources.
-- Apply after 20260901_razorpay_payment_hardening.sql.

USE deplai;

CREATE TABLE IF NOT EXISTS organizations (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(80) NOT NULL,
  logo_url VARCHAR(512) NULL,
  owner_user_id VARCHAR(36) NOT NULL,
  status ENUM('ACTIVE', 'SUSPENDED', 'DELETED_PENDING') NOT NULL DEFAULT 'ACTIVE',
  deleted_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_organization_slug (slug),
  INDEX idx_organization_owner (owner_user_id, status),
  CONSTRAINT fk_organization_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS organization_roles (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(36) NULL,
  role_key VARCHAR(64) NOT NULL,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(255) NULL,
  is_builtin TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_org_role_key (organization_id, role_key),
  INDEX idx_org_roles (organization_id, is_builtin),
  CONSTRAINT fk_org_role_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

INSERT IGNORE INTO organization_roles (id, organization_id, role_key, name, description, is_builtin) VALUES
  ('builtin-owner', NULL, 'OWNER', 'Owner', 'Full organization control, including ownership and deletion.', 1),
  ('builtin-admin', NULL, 'ADMIN', 'Admin', 'Broad management without owner-only destructive controls.', 1),
  ('builtin-devops', NULL, 'DEVOPS', 'DevOps', 'Deployments, environments, cloud access, and operations.', 1),
  ('builtin-developer', NULL, 'DEVELOPER', 'Developer', 'Projects, repositories, agents, scans, and non-production delivery.', 1),
  ('builtin-security', NULL, 'SECURITY', 'Security', 'Security findings, policies, exceptions, approvals, and audit.', 1),
  ('builtin-billing-admin', NULL, 'BILLING_ADMIN', 'Billing Admin', 'Subscription, usage, invoices, transactions, and refunds.', 1),
  ('builtin-viewer', NULL, 'VIEWER', 'Viewer', 'Read-only access to assigned non-sensitive resources.', 1);

CREATE TABLE IF NOT EXISTS organization_role_permissions (
  role_id VARCHAR(36) NOT NULL,
  permission_key VARCHAR(96) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (role_id, permission_key),
  INDEX idx_org_role_permission (permission_key, role_id),
  CONSTRAINT fk_org_role_permission_role FOREIGN KEY (role_id) REFERENCES organization_roles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  role_id VARCHAR(36) NOT NULL,
  status ENUM('INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED') NOT NULL DEFAULT 'ACTIVE',
  invited_by VARCHAR(36) NULL,
  joined_at DATETIME NULL,
  last_active_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_organization_member (organization_id, user_id),
  INDEX idx_org_member_user_status (user_id, status),
  INDEX idx_org_member_org_status (organization_id, status),
  CONSTRAINT fk_org_member_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_org_member_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_org_member_role FOREIGN KEY (role_id) REFERENCES organization_roles(id) ON DELETE RESTRICT,
  CONSTRAINT fk_org_member_inviter FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS organization_invitations (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(36) NOT NULL,
  email VARCHAR(255) NOT NULL,
  invited_by_user_id VARCHAR(36) NOT NULL,
  role_id VARCHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  accepted_at DATETIME NULL,
  revoked_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_org_invitation_token (token_hash),
  INDEX idx_org_invitation_email (organization_id, email, expires_at),
  INDEX idx_org_invitation_pending (organization_id, accepted_at, revoked_at, expires_at),
  CONSTRAINT fk_org_invitation_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_org_invitation_inviter FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_org_invitation_role FOREIGN KEY (role_id) REFERENCES organization_roles(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS organization_teams (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(36) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(255) NULL,
  created_by VARCHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_organization_team_name (organization_id, name),
  INDEX idx_organization_teams (organization_id, name),
  CONSTRAINT fk_org_team_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_org_team_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS organization_team_memberships (
  team_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  added_by VARCHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (team_id, user_id),
  INDEX idx_org_team_member_user (user_id, team_id),
  CONSTRAINT fk_org_team_member_team FOREIGN KEY (team_id) REFERENCES organization_teams(id) ON DELETE CASCADE,
  CONSTRAINT fk_org_team_member_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_org_team_member_actor FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS organization_role_assignments (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(36) NOT NULL,
  principal_type ENUM('USER', 'TEAM') NOT NULL,
  principal_id VARCHAR(36) NOT NULL,
  role_id VARCHAR(36) NOT NULL,
  scope_type ENUM('ORGANIZATION', 'PROJECT', 'ENVIRONMENT') NOT NULL,
  scope_id VARCHAR(64) NULL,
  created_by VARCHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_org_role_assignment (organization_id, principal_type, principal_id, role_id, scope_type, scope_id),
  INDEX idx_org_role_principal (organization_id, principal_type, principal_id),
  INDEX idx_org_role_scope (organization_id, scope_type, scope_id),
  CONSTRAINT fk_org_assignment_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_org_assignment_role FOREIGN KEY (role_id) REFERENCES organization_roles(id) ON DELETE CASCADE,
  CONSTRAINT fk_org_assignment_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS organization_audit_events (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(36) NOT NULL,
  actor_user_id VARCHAR(36) NOT NULL,
  action VARCHAR(96) NOT NULL,
  resource_type VARCHAR(64) NOT NULL,
  resource_id VARCHAR(64) NULL,
  project_id VARCHAR(64) NULL,
  environment_id VARCHAR(64) NULL,
  result ENUM('SUCCESS', 'DENIED', 'FAILED') NOT NULL DEFAULT 'SUCCESS',
  request_id VARCHAR(64) NULL,
  ip_address VARCHAR(64) NULL,
  metadata_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org_audit_created (organization_id, created_at),
  INDEX idx_org_audit_action (organization_id, action, created_at),
  INDEX idx_org_audit_project (organization_id, project_id, created_at),
  CONSTRAINT fk_org_audit_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_org_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS organization_cloud_accounts (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(36) NOT NULL,
  provider VARCHAR(32) NOT NULL DEFAULT 'AWS',
  display_name VARCHAR(120) NOT NULL,
  account_identifier_masked VARCHAR(32) NOT NULL,
  regions_json JSON NULL,
  status ENUM('CONNECTED', 'DEGRADED', 'DISCONNECTED') NOT NULL DEFAULT 'CONNECTED',
  credential_reference VARCHAR(255) NULL,
  created_by VARCHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_org_cloud_accounts (organization_id, provider, status),
  CONSTRAINT fk_org_cloud_account_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_org_cloud_account_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS organization_security_policies (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(36) NOT NULL,
  project_id VARCHAR(64) NULL,
  environment_id VARCHAR(64) NULL,
  policy_type VARCHAR(64) NOT NULL DEFAULT 'DEPLOYMENT_GATE',
  configuration_json JSON NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_by VARCHAR(36) NOT NULL,
  updated_by VARCHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_org_security_policy (organization_id, project_id, environment_id),
  CONSTRAINT fk_org_security_policy_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_org_security_policy_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_org_security_policy_updater FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT
);

-- Safe compatibility bridge: create one personal organization per existing user.
INSERT INTO organizations (id, name, slug, owner_user_id, status)
SELECT UUID(),
       CONCAT(LEFT(COALESCE(NULLIF(TRIM(u.name), ''), SUBSTRING_INDEX(u.email, '@', 1)), 96), ' workspace'),
       CONCAT('personal-', LEFT(LOWER(REPLACE(u.id, '-', '')), 24)),
       u.id,
       'ACTIVE'
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM organization_memberships m WHERE m.user_id = u.id AND m.status = 'ACTIVE'
);

INSERT IGNORE INTO organization_memberships
  (id, organization_id, user_id, role_id, status, joined_at, last_active_at)
SELECT UUID(), o.id, o.owner_user_id, 'builtin-owner', 'ACTIVE', NOW(), NOW()
FROM organizations o
WHERE o.slug LIKE 'personal-%';

-- Add organization ownership without dropping the legacy user ownership columns.
ALTER TABLE github_installations
  ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id,
  ADD INDEX idx_github_installation_org (organization_id, installed_at),
  ADD CONSTRAINT fk_github_installation_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;

ALTER TABLE projects
  ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id,
  ADD COLUMN created_by_user_id VARCHAR(36) NULL AFTER organization_id,
  ADD INDEX idx_projects_org_created (organization_id, created_at),
  ADD CONSTRAINT fk_projects_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_projects_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE chat_sessions ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_chat_org (organization_id, updated_at);
ALTER TABLE workspace_sessions ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_workspace_org (organization_id, started_at);
ALTER TABLE dast_assets ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_dast_asset_org (organization_id, created_at);
ALTER TABLE dast_scans ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_dast_scan_org (organization_id, created_at);
ALTER TABLE dast_audit_events ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_dast_audit_org (organization_id, created_at);
ALTER TABLE deploy_exec_deployments ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_deploy_exec_org (organization_id, created_at);
ALTER TABLE deploy_exec_events ADD COLUMN organization_id VARCHAR(36) NULL AFTER project_id, ADD INDEX idx_deploy_event_org (organization_id, created_at);
ALTER TABLE deploy_exec_artifacts ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_deploy_artifact_org (organization_id, created_at);
ALTER TABLE ai_provider_credentials ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_ai_creds_org (organization_id, provider_id);
ALTER TABLE ai_routing_policies ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_ai_routing_org (organization_id, task_type);
ALTER TABLE ai_organization_policies ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD UNIQUE KEY unique_ai_policy_org (organization_id);
ALTER TABLE ai_usage ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_ai_usage_org_created (organization_id, created_at);
ALTER TABLE ai_costs ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_ai_cost_org_created (organization_id, created_at);
ALTER TABLE ai_request_logs ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_ai_logs_org_created (organization_id, created_at);
ALTER TABLE ai_audit_events ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_ai_audit_org_created (organization_id, created_at);
ALTER TABLE billing_subscriptions ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_billing_sub_org (organization_id, status);
ALTER TABLE billing_checkout_intents ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_intent_org (organization_id, created_at);
ALTER TABLE billing_invoices ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_invoice_org_date (organization_id, invoice_date);
ALTER TABLE credit_ledgers ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_ledger_org_window (organization_id, cycle_start, cycle_end);
ALTER TABLE credit_transactions ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id, ADD INDEX idx_credit_txn_org (organization_id, created_at);

UPDATE github_installations gi JOIN organizations o ON o.owner_user_id = gi.user_id AND o.slug LIKE 'personal-%'
SET gi.organization_id = o.id WHERE gi.organization_id IS NULL;
UPDATE projects p JOIN organizations o ON o.owner_user_id = p.user_id AND o.slug LIKE 'personal-%'
SET p.organization_id = o.id, p.created_by_user_id = p.user_id WHERE p.organization_id IS NULL;
UPDATE chat_sessions x JOIN organizations o ON o.owner_user_id = x.user_id AND o.slug LIKE 'personal-%' SET x.organization_id = o.id WHERE x.organization_id IS NULL;
UPDATE workspace_sessions x LEFT JOIN projects p ON p.id = x.project_id JOIN organizations o ON o.owner_user_id = x.user_id AND o.slug LIKE 'personal-%' SET x.organization_id = COALESCE(p.organization_id, o.id) WHERE x.organization_id IS NULL;
UPDATE dast_assets x JOIN projects p ON p.id = x.project_id SET x.organization_id = p.organization_id WHERE x.organization_id IS NULL;
UPDATE dast_scans x JOIN projects p ON p.id = x.project_id SET x.organization_id = p.organization_id WHERE x.organization_id IS NULL;
UPDATE dast_audit_events x JOIN projects p ON p.id = x.project_id SET x.organization_id = p.organization_id WHERE x.organization_id IS NULL;
UPDATE deploy_exec_deployments x JOIN projects p ON p.id = x.project_id SET x.organization_id = p.organization_id WHERE x.organization_id IS NULL;
UPDATE deploy_exec_events x JOIN deploy_exec_deployments d ON d.id = x.deployment_id SET x.organization_id = d.organization_id WHERE x.organization_id IS NULL;
UPDATE deploy_exec_artifacts x JOIN projects p ON p.id = x.project_id SET x.organization_id = p.organization_id WHERE x.organization_id IS NULL;
UPDATE ai_provider_credentials x JOIN organizations o ON o.owner_user_id = x.user_id AND o.slug LIKE 'personal-%' SET x.organization_id = o.id WHERE x.organization_id IS NULL;
UPDATE ai_routing_policies x JOIN organizations o ON o.owner_user_id = x.user_id AND o.slug LIKE 'personal-%' SET x.organization_id = o.id WHERE x.organization_id IS NULL;
UPDATE ai_organization_policies x JOIN organizations o ON o.owner_user_id = x.user_id AND o.slug LIKE 'personal-%' SET x.organization_id = o.id WHERE x.organization_id IS NULL;
UPDATE ai_usage x JOIN organizations o ON o.owner_user_id = x.user_id AND o.slug LIKE 'personal-%' SET x.organization_id = o.id WHERE x.organization_id IS NULL;
UPDATE ai_costs x JOIN organizations o ON o.owner_user_id = x.user_id AND o.slug LIKE 'personal-%' SET x.organization_id = o.id WHERE x.organization_id IS NULL;
UPDATE ai_request_logs x JOIN organizations o ON o.owner_user_id = x.user_id AND o.slug LIKE 'personal-%' SET x.organization_id = o.id WHERE x.organization_id IS NULL;
UPDATE ai_audit_events x JOIN organizations o ON o.owner_user_id = x.user_id AND o.slug LIKE 'personal-%' SET x.organization_id = o.id WHERE x.organization_id IS NULL;
UPDATE billing_subscriptions x JOIN organizations o ON o.owner_user_id = x.user_id AND o.slug LIKE 'personal-%' SET x.organization_id = o.id WHERE x.organization_id IS NULL;
UPDATE billing_checkout_intents x JOIN organizations o ON o.owner_user_id = x.user_id AND o.slug LIKE 'personal-%' SET x.organization_id = o.id WHERE x.organization_id IS NULL;
UPDATE billing_invoices x JOIN organizations o ON o.owner_user_id = x.user_id AND o.slug LIKE 'personal-%' SET x.organization_id = o.id WHERE x.organization_id IS NULL;
UPDATE credit_ledgers x JOIN organizations o ON o.owner_user_id = x.user_id AND o.slug LIKE 'personal-%' SET x.organization_id = o.id WHERE x.organization_id IS NULL;
UPDATE credit_transactions x JOIN organizations o ON o.owner_user_id = x.user_id AND o.slug LIKE 'personal-%' SET x.organization_id = o.id WHERE x.organization_id IS NULL;

-- Add foreign keys after backfill. Columns remain nullable for a safe staged rollout.
ALTER TABLE chat_sessions ADD CONSTRAINT fk_chat_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE workspace_sessions ADD CONSTRAINT fk_workspace_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE dast_assets ADD CONSTRAINT fk_dast_asset_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE dast_scans ADD CONSTRAINT fk_dast_scan_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE dast_audit_events ADD CONSTRAINT fk_dast_audit_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE deploy_exec_deployments ADD CONSTRAINT fk_deploy_exec_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE deploy_exec_events ADD CONSTRAINT fk_deploy_event_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE deploy_exec_artifacts ADD CONSTRAINT fk_deploy_artifact_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE ai_provider_credentials ADD CONSTRAINT fk_ai_creds_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE ai_routing_policies ADD CONSTRAINT fk_ai_routing_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE ai_organization_policies ADD CONSTRAINT fk_ai_policy_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE ai_usage ADD CONSTRAINT fk_ai_usage_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE ai_costs ADD CONSTRAINT fk_ai_cost_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE ai_request_logs ADD CONSTRAINT fk_ai_log_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE ai_audit_events ADD CONSTRAINT fk_ai_audit_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE billing_subscriptions ADD CONSTRAINT fk_billing_sub_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE billing_checkout_intents ADD CONSTRAINT fk_intent_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE billing_invoices ADD CONSTRAINT fk_invoice_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE credit_ledgers ADD CONSTRAINT fk_ledger_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE credit_transactions ADD CONSTRAINT fk_credit_txn_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
