import test from 'node:test';
import assert from 'node:assert/strict';
import { setComplimentaryAccess } from './complimentary';
import type { SqlExecutor } from '../db';

test('grant locks target and records before/after using the mutation transaction', async () => {
  const statements: string[] = [];
  const exec = (async (sql: string, params: unknown[]) => {
    statements.push(sql);
    assert.equal(params[0], 'org-a');
    return sql.includes('FROM organizations') ? [{ id: 'org-a' }] : sql.startsWith('SELECT') ? [{ plan_id: 'free' }] : [];
  }) as SqlExecutor;
  await setComplimentaryAccess({ organizationId: 'org-a', revoke: false, planId: 'pro_50' }, { action: '', reason: 'Complimentary access' }, {
    transaction: async (work) => work(exec),
    audit: async (event, auditExec) => {
      assert.equal(auditExec, exec);
      assert.equal(event.action, 'COMPLIMENTARY_ACCESS_GRANTED');
      assert.deepEqual(event.before, { plan_id: 'free' });
      assert.deepEqual(event.after, { planId: 'pro_50', expiresAt: null });
      return 'audit-id';
    },
  });
  assert.match(statements[0], /FOR UPDATE/);
  assert.ok(statements.some((sql) => sql.startsWith('INSERT INTO admin_plan_grants')));
  assert.ok(statements.every((sql) => !sql.includes('billing_subscriptions')));
});

test('audit failure propagates so transaction rolls back; unknown organization cannot grant', async () => {
  const exec = (async (sql: string) => sql.includes('FROM organizations') ? [{ id: 'org-a' }] : []) as SqlExecutor;
  let rolledBack = false;
  await assert.rejects(setComplimentaryAccess({ organizationId: 'org-a', revoke: true }, { action: '' }, {
    transaction: async (work) => { try { return await work(exec); } catch (error) { rolledBack = true; throw error; } },
    audit: async () => { throw new Error('Audit unavailable'); },
  }), /Audit unavailable/);
  assert.equal(rolledBack, true);
  await assert.rejects(setComplimentaryAccess({ organizationId: 'missing', revoke: false, planId: 'pro_50' }, { action: '' }, {
    transaction: async (work) => work((async () => []) as SqlExecutor),
    audit: async () => { assert.fail('must not audit a grant for a missing organization'); },
  }), /Organization not found/);
});
