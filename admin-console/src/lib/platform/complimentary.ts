import { withTransaction, type SqlExecutor } from '@/lib/db';
import { writeAdminAuditLog, type AuditInput } from '@/lib/audit/logger';
import { validateGrant } from './complimentary-policy';

export async function setComplimentaryAccess(input: {
  organizationId: string; revoke: boolean; planId?: unknown; expiresAt?: unknown;
}, audit: AuditInput, io: {
  transaction: typeof withTransaction;
  audit: (input: AuditInput, exec: SqlExecutor) => Promise<string>;
} = { transaction: withTransaction, audit: writeAdminAuditLog }) {
  const grant = input.revoke ? null : validateGrant(input.planId, input.expiresAt);
  return io.transaction(async (exec) => {
    const org = await exec<Array<{ id: string }>>('SELECT id FROM organizations WHERE id = ? FOR UPDATE', [input.organizationId]);
    if (!org.length) throw new Error('Organization not found');
    const before = await exec<unknown[]>('SELECT * FROM admin_plan_grants WHERE organization_id = ?', [input.organizationId]);
    if (grant) {
      await exec(`INSERT INTO admin_plan_grants (organization_id, plan_id, expires_at, revoked_at)
        VALUES (?, ?, ?, NULL) ON DUPLICATE KEY UPDATE plan_id = VALUES(plan_id), expires_at = VALUES(expires_at), revoked_at = NULL`,
      [input.organizationId, grant.planId, grant.expiresAt]);
    } else {
      await exec('UPDATE admin_plan_grants SET revoked_at = CURRENT_TIMESTAMP WHERE organization_id = ?', [input.organizationId]);
    }
    await io.audit({ ...audit, action: grant ? 'COMPLIMENTARY_ACCESS_GRANTED' : 'COMPLIMENTARY_ACCESS_REVOKED',
      targetType: 'organization', targetId: input.organizationId, before: before[0] || null, after: grant }, exec);
  });
}
