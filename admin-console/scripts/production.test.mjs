import test from 'node:test';
import assert from 'node:assert/strict';
import { adminListenHost } from './server-boundary.mjs';
import { migrations, migrationSql } from './schema.mjs';

test('production wildcard requires explicit mode and actual Docker detection', () => {
  for (const mode of [undefined, 'true']) {
    for (const detected of [false, true]) {
      const env = { NODE_ENV: 'production', ADMIN_BIND_HOST: '0.0.0.0', ADMIN_CONTAINER_MODE: mode, ADMIN_ALLOW_UNSAFE_BIND: 'true' };
      if (mode === 'true' && detected) assert.equal(adminListenHost(env, detected), '0.0.0.0');
      else assert.throws(() => adminListenHost(env, detected));
    }
  }
  for (const host of ['::', '192.168.1.1', 'admin.example.com']) {
    assert.throws(() => adminListenHost({ NODE_ENV: 'production', ADMIN_BIND_HOST: host, ADMIN_CONTAINER_MODE: 'true' }, true));
  }
  assert.equal(adminListenHost({ NODE_ENV: 'production' }, false), '127.0.0.1');
});

test('migration replay is additive and respects configured database', () => {
  const sql = migrations.map(migrationSql).join('\n');
  assert.doesNotMatch(sql, /\bUSE\s+deplai/i);
  assert.doesNotMatch(sql, /\b(?:DROP|ALTER|DELETE|UPDATE|INSERT)\s+(?:TABLE|INTO|FROM)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS admin_login_attempts/);
  assert.equal([...sql.matchAll(/CREATE TABLE IF NOT EXISTS /g)].length, 11);
});
