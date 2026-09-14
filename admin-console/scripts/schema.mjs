import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';

// Replay these additive, idempotent migrations to recover partial DDL installs.
export const migrations = [
  '20260901_admin_console_v1.sql',
  '20260901_admin_resource_controls.sql',
  '20260914_complimentary_access.sql',
];

export function migrationSql(name) {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')
    .replace(/^USE deplai;\s*$/gm, '');
}

export async function runAdminSchema(env, checkOnly = false) {
  const sql = migrations.map(migrationSql);
  const tables = sql.flatMap((body) => [...body.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((match) => match[1]));
  const connection = await mysql.createConnection({
    host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306),
    user: env.DB_USER || 'root', password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'deplai', multipleStatements: !checkOnly,
  });
  let locked = false;
  const lockName = `admin-schema:${env.DB_NAME || 'deplai'}`.slice(0, 64);
  try {
    if (!checkOnly) {
      const [rows] = await connection.execute('SELECT GET_LOCK(?, 60) AS acquired', [lockName]);
      if (Number(rows[0].acquired) !== 1) throw Object.assign(new Error('Migration lock unavailable'), { code: 'MIGRATION_LOCK_TIMEOUT' });
      locked = true;
      for (let index = 0; index < sql.length; index++) {
        await connection.query(sql[index]);
        console.log(`Applied ${migrations[index]}`);
      }
    }
    for (const table of tables) {
      await connection.query(`SELECT 1 FROM \`${table}\` LIMIT 0`);
    }
    console.log(`Admin schema verified (${tables.length} tables).`);
  } finally {
    try {
      if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]);
    } finally {
      await connection.end();
    }
  }
}
