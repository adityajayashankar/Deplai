import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { loadAdminEnv } from './load-env';

async function main() {
  loadAdminEnv();
  const sqlPath = resolve(process.cwd(), 'migrations/20260901_admin_console_v1.sql');
  const sql = readFileSync(sqlPath, 'utf8');
  const resourceSql = readFileSync(resolve(process.cwd(), 'migrations/20260901_admin_resource_controls.sql'), 'utf8');
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'deplai',
    multipleStatements: true,
  });
  await connection.query(sql);
  await connection.query(resourceSql);
  await connection.query(readFileSync(resolve(process.cwd(), 'migrations/20260914_complimentary_access.sql'), 'utf8'));
  await connection.end();
  console.log('Admin console migration applied.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
