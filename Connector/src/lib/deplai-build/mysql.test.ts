import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { createBuildRepository } from './repository';
import type { SqlExecutor } from '../db';

// Explicit opt-in. Never load app env files or touch an existing database.
test('MySQL: migration replay, restart reads, concurrent transitions, ownership FK and rollback', { skip: process.env.BUILD_TEST_MYSQL !== '1' }, async () => {
  const database = `build_test_${randomUUID().replaceAll('-', '')}`;
  const config = { host: process.env.BUILD_TEST_DB_HOST || '127.0.0.1', port: Number(process.env.BUILD_TEST_DB_PORT || 3306), user: process.env.BUILD_TEST_DB_USER || 'root', password: process.env.BUILD_TEST_DB_PASSWORD || '' };
  const admin = await mysql.createConnection(config);
  let pool: mysql.Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE \`${database}\``);
    pool = mysql.createPool({ ...config, database, connectionLimit: 4 });
    // Match current core-table identifier types without altering product tables.
    for (const sql of [
      'CREATE TABLE users (id VARCHAR(36) PRIMARY KEY)',
      'CREATE TABLE organizations (id VARCHAR(36) PRIMARY KEY)',
      'CREATE TABLE projects (id VARCHAR(36) PRIMARY KEY, organization_id VARCHAR(36) NOT NULL)',
      "INSERT INTO users VALUES ('u1'), ('u2')", "INSERT INTO organizations VALUES ('o1'), ('o2')",
      "INSERT INTO projects VALUES ('p1','o1'), ('p2','o2')",
    ]) await pool.query(sql);
    const migration = ['20260920_build_sessions.sql', '20260920_build_secrets.sql'].map(file => readFileSync(path.resolve(process.cwd(), 'migrations', file), 'utf8')).join('\n');
    for (let repeat = 0; repeat < 2; repeat++) {
      for (const sql of migration.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await pool.query(sql);
    }
    const deps = {
      authorize: async (_actor: string, project: string) => ({ organizationId: project === 'p1' ? 'o1' : 'o2' }),
      transaction: async <T>(work: (exec: SqlExecutor) => Promise<T>) => {
        const connection = await pool!.getConnection();
        const exec: SqlExecutor = async <R>(sql: string, params?: unknown[] | Record<string, unknown>) => {
          const [rows] = await connection.execute(sql, params as never); return rows as R;
        };
        await connection.beginTransaction();
        try { const value = await work(exec); await connection.commit(); return value; }
        catch (error) { await connection.rollback(); throw error; }
        finally { connection.release(); }
      },
    };
    const repo = createBuildRepository(deps);
    const scope = await repo.create('u1', { organization_id: 'o1', project_id: 'p1', source_type: 'NEW_PROJECT', source_revision: null });
    assert.equal((await createBuildRepository(deps).get('u1', scope)).state, 'DRAFT');
    const resourceId = await repo.registerResource('u1', scope, 'artifact');
    assert.equal((await repo.getResource('u1', scope, resourceId)).kind, 'artifact');
    await assert.rejects(repo.get('u2', scope));
    const parallel = await Promise.allSettled([repo.transition('u1', scope, 0, 'ANALYZING'), repo.transition('u1', scope, 0, 'ANALYZING')]);
    assert.equal(parallel.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await repo.get('u1', scope)).version, 1);
    await assert.rejects(pool.execute('INSERT INTO build_resources (resource_id, session_id, owner_user_id, organization_id, project_id, kind) VALUES (?, ?, ?, ?, ?, ?)', [randomUUID(), scope.session_id, 'u2', 'o1', 'p1', 'artifact']));
    await pool.execute('INSERT INTO build_session_events (session_id, sequence, state) VALUES (?, 2, ?)', [scope.session_id, 'PLANNING']);
    await assert.rejects(repo.transition('u1', scope, 1, 'PLANNING'));
    assert.equal((await repo.get('u1', scope)).state, 'ANALYZING');
  } finally {
    await pool?.end();
    // Only this randomly named disposable database is ever deleted.
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
