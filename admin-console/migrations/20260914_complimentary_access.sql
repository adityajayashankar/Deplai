CREATE TABLE IF NOT EXISTS admin_plan_grants (
  organization_id VARCHAR(36) PRIMARY KEY,
  plan_id VARCHAR(36) NOT NULL,
  expires_at DATETIME NULL,
  revoked_at DATETIME NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_admin_grant_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_admin_grant_plan FOREIGN KEY (plan_id) REFERENCES billing_plans(id)
);
