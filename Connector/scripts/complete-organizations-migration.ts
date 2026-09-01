import fs from 'node:fs';
import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import mysql from 'mysql2/promise';

loadEnvConfig(path.resolve(__dirname, '../..'));
loadEnvConfig(path.resolve(__dirname, '..'));

const SKIP_CODES = new Set([
  'ER_DUP_FIELDNAME',
  'ER_DUP_KEYNAME',
  'ER_TABLE_EXISTS_ERROR',
  'ER_DUP_ENTRY',
  'ER_CANT_CREATE_TABLE',
  'ER_FK_DUP_NAME',
]);

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
    const [columns] = await connection.query<Array<mysql.RowDataPacket & { Field: string }>>(
      'SHOW COLUMNS FROM github_installations LIKE ?',
      ['organization_id'],
    );
    if (columns.length === 0) {
      await connection.query(
        `ALTER TABLE github_installations
         ADD COLUMN organization_id VARCHAR(36) NULL AFTER user_id,
         ADD INDEX idx_github_installation_org (organization_id, installed_at)`,
      );
      console.log('added github_installations.organization_id');
    }

    const [projectsColumns] = await connection.query<Array<mysql.RowDataPacket & { Field: string }>>(
      'SHOW COLUMNS FROM projects LIKE ?',
      ['created_by_user_id'],
    );
    if (projectsColumns.length === 0) {
      await connection.query(
        `ALTER TABLE projects
         ADD COLUMN created_by_user_id VARCHAR(36) NULL AFTER organization_id,
         ADD INDEX idx_projects_org_created (organization_id, created_at),
         ADD CONSTRAINT fk_projects_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
         ADD CONSTRAINT fk_projects_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL`,
      );
      console.log('added projects.created_by_user_id');
    }

    await connection.query(
      `INSERT INTO organizations (id, name, slug, owner_user_id, status)
       SELECT UUID(),
              CONCAT(LEFT(COALESCE(NULLIF(TRIM(u.name), ''), SUBSTRING_INDEX(u.email, '@', 1)), 96), ' workspace'),
              CONCAT('personal-', LEFT(LOWER(REPLACE(u.id, '-', '')), 24)),
              u.id,
              'ACTIVE'
       FROM users u
       WHERE NOT EXISTS (
         SELECT 1 FROM organization_memberships m WHERE m.user_id = u.id AND m.status = 'ACTIVE'
       )`,
    );
    await connection.query(
      `INSERT IGNORE INTO organization_memberships
         (id, organization_id, user_id, role_id, status, joined_at, last_active_at)
       SELECT UUID(), o.id, o.owner_user_id, 'builtin-owner', 'ACTIVE', NOW(), NOW()
       FROM organizations o
       WHERE o.slug LIKE 'personal-%'`,
    );

    const raw = fs.readFileSync(
      path.resolve(__dirname, '../migrations/20260901_organizations_v1.sql'),
      'utf8',
    );
    const statements = raw
      .replace(/^\s*--.*$/gm, '')
      .split(/;\s*(?:\r?\n|$)/)
      .map((part) => part.trim())
      .filter(Boolean);
    let runUpdates = false;
    for (const statement of statements) {
      if (/^USE\s+/i.test(statement)) continue;
      if (statement.includes('UPDATE github_installations')) runUpdates = true;
      if (!runUpdates) continue;
      try {
        await connection.query(statement);
        console.log(`ok: ${statement.slice(0, 72).replace(/\s+/g, ' ')}...`);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code && SKIP_CODES.has(code)) {
          console.log(`skip: ${code}`);
          continue;
        }
        throw error;
      }
    }

    const [[orgCount]] = await connection.query<Array<mysql.RowDataPacket & { c: number }>>('SELECT COUNT(*) AS c FROM organizations');
    console.log(`organizations ready: ${orgCount.c}`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
