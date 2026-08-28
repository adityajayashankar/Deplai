import fs from 'node:fs';
import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import mysql from 'mysql2/promise';

loadEnvConfig(path.resolve(__dirname, '../..'));
loadEnvConfig(path.resolve(__dirname, '..'));

const files = [
  path.resolve(__dirname, '../migrations/20260827_dast_assets.sql'),
];

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'deplai',
    multipleStatements: false,
  });
  try {
    for (const sqlPath of files) {
      const raw = fs.readFileSync(sqlPath, 'utf8');
      const statements = raw
        .split(/;\s*(?:\r?\n|$)/)
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith('--'));
      console.log(`applying ${path.basename(sqlPath)}`);
      for (const statement of statements) {
        if (/^USE\s+/i.test(statement)) continue;
        try {
          await connection.query(statement);
          console.log(`ok: ${statement.slice(0, 60).replace(/\s+/g, ' ')}...`);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === 'ER_DUP_FIELDNAME' || code === 'ER_DUP_KEYNAME' || code === 'ER_TABLE_EXISTS_ERROR') {
            console.log(`skip existing: ${code} ${statement.slice(0, 50).replace(/\s+/g, ' ')}`);
            continue;
          }
          throw error;
        }
      }
    }
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
