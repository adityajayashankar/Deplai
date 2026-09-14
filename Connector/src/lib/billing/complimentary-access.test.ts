import test from 'node:test';
import assert from 'node:assert/strict';
import { getComplimentaryAccess } from './complimentary-access';
import type { query } from '@/lib/db';

test('resolution is organization scoped and excludes revoked or expired grants', async () => {
  const exec = (async (sql: string, params: unknown[]) => {
    assert.deepEqual(params, ['organization-a']);
    assert.match(sql, /revoked_at IS NULL/);
    assert.match(sql, /expires_at > CURRENT_TIMESTAMP/);
    return [{ plan_id: 'pro_50' }];
  }) as typeof query;
  const grant = await getComplimentaryAccess('organization-a', exec);
  assert.equal(grant?.planId, 'pro_50');
  assert.equal(grant?.cadence, 'complimentary');
  assert.equal(grant?.razorpaySubscriptionId, null);
});

test('no grant restores normal resolution; rollout tolerates only missing table', async () => {
  assert.equal(await getComplimentaryAccess('org', (async () => []) as typeof query), null);
  assert.equal(await getComplimentaryAccess('org', (async () => [{ plan_id: 'enterprise' }]) as typeof query), null);
  assert.equal(await getComplimentaryAccess('org', (async () => { throw { code: 'ER_NO_SUCH_TABLE' }; }) as typeof query), null);
  await assert.rejects(getComplimentaryAccess('org', (async () => { throw new Error('DB unavailable'); }) as typeof query));
});
