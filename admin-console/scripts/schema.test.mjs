import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { runAdminSchema } from './schema.mjs';

test('partial install recovers, replay preserves tables, check fails closed, and connections close', async (t) => {
  const tables = new Set();
  let fail = true;
  let closes = 0;
  let releases = 0;
  t.mock.method(mysql, 'createConnection', async (options) => {
    assert.equal(options.database, 'isolated_admin_test');
    return {
      async execute(sql) {
        if (sql.includes('RELEASE_LOCK')) releases++;
        return [[{ acquired: 1 }]];
      },
      async query(sql) {
        assert.doesNotMatch(sql, /USE deplai/);
        if (sql.startsWith('SELECT')) {
          const table = sql.match(/`(\w+)`/)[1];
          if (!tables.has(table)) throw Object.assign(new Error('missing'), { code: 'ER_NO_SUCH_TABLE' });
        } else {
          for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) {
            if (fail && match[1] === 'admin_login_attempts') throw new Error('simulated interrupted DDL');
            tables.add(match[1]);
          }
        }
      },
      async end() { closes++; },
    };
  });
  const env = { DB_NAME: 'isolated_admin_test' };
  await assert.rejects(runAdminSchema(env));
  assert.equal(releases, 1);
  await assert.rejects(runAdminSchema(env, true), { code: 'ER_NO_SUCH_TABLE' });
  fail = false;
  await runAdminSchema(env);
  await runAdminSchema(env);
  await runAdminSchema(env, true);
  assert.ok(tables.has('admin_login_attempts'));
  assert.equal(tables.size, 11);
  assert.equal(closes, 5);
  assert.equal(releases, 3);
});
