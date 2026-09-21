import fs from 'node:fs';
import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import mysql from 'mysql2/promise';

loadEnvConfig(path.resolve(__dirname, '..'));

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'deplai', multipleStatements: false,
  });
  let acquired = false;
  try {
    const [rows] = await connection.query<mysql.RowDataPacket[]>("SELECT GET_LOCK('deplai-build-migration-v1', 30) AS acquired");
    acquired = Number(rows[0]?.acquired) === 1;
    if (!acquired) throw new Error('Migration lock unavailable');
    for (const file of ['20260920_build_sessions.sql', '20260920_build_secrets.sql']) {
      const sql = fs.readFileSync(path.resolve(__dirname, '../migrations', file), 'utf8');
      for (const statement of sql.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) {
        await connection.query(statement);
      }
    }
    console.log('Build session migration applied. User code execution remains disabled.');
  } finally {
    if (acquired) await connection.query("SELECT RELEASE_LOCK('deplai-build-migration-v1')");
    await connection.end();
  }
}
main().catch(() => {
  // Driver messages can contain connection information; never print raw errors.
  console.error('Build migration failed. Check database connectivity, schema prerequisites and migration permissions.');
  process.exitCode = 1;
});
