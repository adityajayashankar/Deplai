import { loadEnvConfig } from '@next/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

async function main() {
  loadEnvConfig(process.cwd());
  const { registerSecurityBudget, securityPaidAllowed, reserveSecurityCost, settleSecurityCost } = await import('../src/lib/ai-platform/security-run-budget');
  const { query } = await import('../src/lib/db');
  const id = `budget-test-${randomUUID()}`;
  try {
    await registerSecurityBudget(id, 'budget-test-user', true, 'budget-test-org', 2, 'z-ai/glm-5.3-flash');
    assert.equal(await securityPaidAllowed(id, 'budget-test-user', 'budget-test-org'), true);
    assert.equal(await securityPaidAllowed(id, 'different-user', 'budget-test-org'), false);
    assert.equal(await securityPaidAllowed(id, 'budget-test-user', 'different-org'), false);
    const results = await Promise.allSettled([0.7, 0.7, 0.7].map(cost => reserveSecurityCost(id, 'budget-test-user', cost)));
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 2);
    await assert.rejects(reserveSecurityCost(id, 'different-user', 0.01));
    await assert.rejects(reserveSecurityCost(id, 'budget-test-user', NaN));
    await settleSecurityCost(id, 0.7, 0.2);
    await reserveSecurityCost(id, 'budget-test-user', 1.09);
    await assert.rejects(reserveSecurityCost(id, 'budget-test-user', 0.02));
    console.log('Paid budget: ownership, organization isolation, concurrent cap, settlement and invalid values passed. No inference calls.');
  } finally {
    await query('DELETE FROM security_paid_run_budgets_v2 WHERE run_id = ?', [id]);
  }
}
main().then(() => process.exit(0)).catch((error) => { console.error('Paid budget test failed', {name:error.name, code:error.code, actual:error.actual, expected:error.expected, message: error.name === 'AssertionError' ? error.message : undefined}); process.exit(1); });
