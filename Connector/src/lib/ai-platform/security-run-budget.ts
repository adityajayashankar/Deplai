import { query, withTransaction } from '@/lib/db';
import { AiPlatformError } from './errors';

let ready: Promise<void> | undefined;
async function schema() {
  return ready ??= query(`CREATE TABLE IF NOT EXISTS security_run_budgets (
    run_id VARCHAR(80) PRIMARY KEY, user_id VARCHAR(191) NOT NULL,
    allow_paid BOOLEAN NOT NULL DEFAULT FALSE, reserved_usd DECIMAL(14,8) NOT NULL DEFAULT 0,
    spent_usd DECIMAL(14,8) NOT NULL DEFAULT 0
  )`).then(() => undefined).catch((error) => { ready = undefined; throw error; });
}
export async function registerSecurityBudget(runId: string, userId: string, allowPaid: boolean) {
  await schema();
  await query('INSERT INTO security_run_budgets (run_id, user_id, allow_paid) VALUES (?, ?, ?)', [runId, userId, allowPaid]);
}
export async function securityPaidAllowed(runId: unknown, userId: string): Promise<boolean> {
  if (typeof runId !== 'string' || !runId) return false;
  await schema();
  const rows = await query<Array<{ allow_paid: number }>>('SELECT allow_paid FROM security_run_budgets WHERE run_id = ? AND user_id = ?', [runId, userId]);
  return Boolean(rows[0]?.allow_paid);
}
export async function reserveSecurityCost(runId: string, userId: string, cost: number) {
  if (!cost) return;
  await schema();
  await withTransaction(async (exec) => {
    const rows = await exec<Array<{ allow_paid: number; reserved_usd: string; spent_usd: string }>>(
      'SELECT allow_paid, reserved_usd, spent_usd FROM security_run_budgets WHERE run_id = ? AND user_id = ? FOR UPDATE', [runId, userId]);
    const row = rows[0];
    if (!row?.allow_paid || !Number.isFinite(cost) || cost < 0 || Number(row.reserved_usd) + Number(row.spent_usd) + cost > 0.10) {
      throw new AiPlatformError('QUOTA_EXCEEDED', 'Remediation paused: the $0.10 run budget cannot cover this request', { retryable: false });
    }
    await exec('UPDATE security_run_budgets SET reserved_usd = reserved_usd + ? WHERE run_id = ?', [cost, runId]);
  });
}
export async function settleSecurityCost(runId: string, reserved: number, actual: number) {
  if (!reserved) return;
  await query('UPDATE security_run_budgets SET reserved_usd = GREATEST(0, reserved_usd - ?), spent_usd = spent_usd + ? WHERE run_id = ?', [reserved, actual, runId]);
}
