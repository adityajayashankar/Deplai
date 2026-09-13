import { query, withTransaction } from '@/lib/db';
import { AiPlatformError } from './errors';

let ready: Promise<void> | undefined;
async function schema() {
  return ready ??= query(`CREATE TABLE IF NOT EXISTS security_paid_run_budgets_v2 (
    run_id VARCHAR(80) PRIMARY KEY, user_id VARCHAR(191) NOT NULL,
    allow_paid BOOLEAN NOT NULL DEFAULT FALSE, organization_id VARCHAR(191) NOT NULL,
    max_usd DECIMAL(14,8) NOT NULL, model_id VARCHAR(191) NOT NULL, reserved_usd DECIMAL(14,8) NOT NULL DEFAULT 0,
    spent_usd DECIMAL(14,8) NOT NULL DEFAULT 0
  )`).then(() => undefined).catch((error) => { ready = undefined; throw error; });
}
export async function registerSecurityBudget(runId: string, userId: string, allowPaid: boolean, organizationId: string, maxUsd: number, modelId: string) {
  if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 2 || modelId !== 'z-ai/glm-5.3-flash') throw new Error('Invalid paid remediation policy');
  await schema();
  await query('INSERT INTO security_paid_run_budgets_v2 (run_id, user_id, allow_paid, organization_id, max_usd, model_id) VALUES (?, ?, ?, ?, ?, ?)', [runId, userId, allowPaid, organizationId, maxUsd, modelId]);
}
export async function securityPaidAllowed(runId: unknown, userId: string, organizationId: string): Promise<boolean> {
  if (typeof runId !== 'string' || !runId) return false;
  await schema();
  const rows = await query<Array<{ allow_paid: number }>>('SELECT allow_paid FROM security_paid_run_budgets_v2 WHERE run_id = ? AND user_id = ? AND organization_id = ?', [runId, userId, organizationId]);
  return Boolean(rows[0]?.allow_paid);
}
export async function reserveSecurityCost(runId: string, userId: string, cost: number) {
  if (cost === 0) return;
  cost = Math.ceil(cost * 1e8) / 1e8;
  await schema();
  await withTransaction(async (exec) => {
    const rows = await exec<Array<{ allow_paid: number; reserved_usd: string; spent_usd: string; max_usd: string }>>(
      'SELECT allow_paid, reserved_usd, spent_usd, max_usd FROM security_paid_run_budgets_v2 WHERE run_id = ? AND user_id = ? FOR UPDATE', [runId, userId]);
    const row = rows[0];
    if (!row?.allow_paid || !Number.isFinite(cost) || cost < 0 || Number(row.reserved_usd) + Number(row.spent_usd) + cost > Number(row.max_usd)) {
      throw new AiPlatformError('QUOTA_EXCEEDED', 'Remediation paused: the approved paid run budget cannot cover this request', { retryable: false });
    }
    await exec('UPDATE security_paid_run_budgets_v2 SET reserved_usd = reserved_usd + ? WHERE run_id = ?', [cost, runId]);
  });
}
export async function settleSecurityCost(runId: string, reserved: number, actual: number) {
  if (!reserved) return;
  if (![reserved, actual].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Invalid reservation settlement');
  reserved = Math.ceil(reserved * 1e8) / 1e8;
  actual = Math.ceil(actual * 1e8) / 1e8;
  await query('UPDATE security_paid_run_budgets_v2 SET reserved_usd = GREATEST(0, reserved_usd - ?), spent_usd = spent_usd + ? WHERE run_id = ?', [reserved, actual, runId]);
}
