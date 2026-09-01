import 'server-only';

import { v4 as uuidv4 } from 'uuid';
import { query } from '@/lib/db';
import { DEFAULT_SECURITY_POLICY, type SecurityPolicyConfiguration } from './governance';
import { requireOrganizationPermission, writeOrganizationAudit } from './store';

function normalizedPolicy(value: Partial<SecurityPolicyConfiguration>): SecurityPolicyConfiguration {
  const number = (candidate: unknown, fallback: number, max: number) => {
    const parsed = Number(candidate);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : fallback;
  };
  return {
    blockCritical: value.blockCritical !== false,
    blockExposedSecrets: value.blockExposedSecrets !== false,
    requireSast: value.requireSast !== false,
    requireSca: value.requireSca !== false,
    requireContainerScan: value.requireContainerScan !== false,
    requireDast: value.requireDast === true,
    criticalThreshold: number(value.criticalThreshold, 0, 1000),
    highThreshold: number(value.highThreshold, 5, 1000),
    productionApprovals: number(value.productionApprovals, 2, 10),
  };
}

export async function getOrganizationSecurityPolicy(userId: string, organizationId: string) {
  await requireOrganizationPermission({ userId, organizationId, action: 'security.policy.read' });
  const rows = await query<Array<{
    id: string;
    configuration_json: Partial<SecurityPolicyConfiguration> | string;
    enabled: number;
    updated_at: string | Date;
  }>>(
    `SELECT id, configuration_json, enabled, updated_at
     FROM organization_security_policies
     WHERE organization_id = ? AND project_id IS NULL AND environment_id IS NULL
       AND policy_type = 'DEPLOYMENT_GATE' LIMIT 1`,
    [organizationId],
  );
  const row = rows[0];
  const raw = typeof row?.configuration_json === 'string'
    ? JSON.parse(row.configuration_json) as Partial<SecurityPolicyConfiguration>
    : row?.configuration_json || {};
  return {
    id: row?.id || null,
    enabled: row ? Boolean(row.enabled) : false,
    configuration: normalizedPolicy({ ...DEFAULT_SECURITY_POLICY, ...raw }),
    updatedAt: row?.updated_at || null,
    staged: !row,
  };
}

export async function saveOrganizationSecurityPolicy(input: {
  actorUserId: string;
  organizationId: string;
  enabled: boolean;
  configuration: Partial<SecurityPolicyConfiguration>;
}) {
  await requireOrganizationPermission({
    userId: input.actorUserId,
    organizationId: input.organizationId,
    action: 'security.policy.manage',
  });
  const configuration = normalizedPolicy(input.configuration);
  const existing = await query<Array<{ id: string }>>(
    `SELECT id FROM organization_security_policies
     WHERE organization_id = ? AND project_id IS NULL AND environment_id IS NULL
       AND policy_type = 'DEPLOYMENT_GATE' LIMIT 1`,
    [input.organizationId],
  );
  const id = existing[0]?.id || uuidv4();
  await query(
    `INSERT INTO organization_security_policies
     (id, organization_id, policy_type, configuration_json, enabled, created_by, updated_by)
     VALUES (?, ?, 'DEPLOYMENT_GATE', ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE configuration_json = VALUES(configuration_json), enabled = VALUES(enabled),
       updated_by = VALUES(updated_by), updated_at = NOW()`,
    [id, input.organizationId, JSON.stringify(configuration), input.enabled ? 1 : 0, input.actorUserId, input.actorUserId],
  );
  await writeOrganizationAudit({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'security.policy.updated',
    resourceType: 'security_policy',
    resourceId: id,
    metadata: { enabled: input.enabled, configuration },
  });
  return { id, enabled: input.enabled, configuration };
}
