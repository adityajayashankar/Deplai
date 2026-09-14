import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { bootstrapOwner } from './accounts';
import { resetDbPool } from '../db';

test('owner bootstrap commits enrollment atomically, no-ops on repeat and rolls back MFA failure', async (t) => {
  let existing = false;
  let failMfa = false;
  const operations: string[] = [];
  const execute = async (sql: string) => {
    if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
    if (sql.includes('COUNT(*)')) return [[{ count: existing ? 1 : 0 }]];
    if (sql.includes('SELECT *')) return [[{ id: 'test-owner', email: 'owner@example.test', role: 'OWNER', status: 'ACTIVE', created_at: new Date() }]];
    if (sql.includes('INSERT INTO')) {
      operations.push(sql.match(/INSERT INTO (\w+)/)![1]);
      if (failMfa && sql.includes('admin_mfa_credentials')) throw new Error('MFA write failed');
    }
    return [[]];
  };
  const conn = {
    execute,
    async beginTransaction() { operations.push('begin'); },
    async commit() { operations.push('commit'); },
    async rollback() { operations.push('rollback'); },
    release() {},
  };
  t.mock.method(mysql, 'createPool', () => ({ execute, async getConnection() { return conn; }, async end() {} }));
  const input = { email: 'owner@example.test', password: 'StrongPass!123456', totpSecret: 'JBSWY3DPEHPK3PXP', recoveryCodes: ['TESTCODE'] };
  try {
    assert.ok(await bootstrapOwner(input));
    assert.deepEqual(operations, ['begin', 'admin_accounts', 'admin_mfa_credentials', 'admin_recovery_codes', 'commit']);
    operations.length = 0;
    existing = true;
    assert.equal(await bootstrapOwner(input), null);
    assert.deepEqual(operations, []);
    existing = false;
    failMfa = true;
    await assert.rejects(bootstrapOwner(input), /MFA write failed/);
    assert.deepEqual(operations, ['begin', 'admin_accounts', 'admin_mfa_credentials', 'rollback']);
  } finally {
    await resetDbPool();
  }
});
