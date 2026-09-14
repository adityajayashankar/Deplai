import { v4 as uuidv4 } from 'uuid';
import { hashPassword, validatePasswordStrength } from '@/lib/auth/password';
import { encryptTotpSecret } from '@/lib/auth/totp';
import { hashRecoveryCode } from '@/lib/crypto';
import { query, withNamedLock, withTransaction } from '@/lib/db';

export type AdminAccount = {
  id: string;
  email: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
  createdAt: string;
};

type AdminRow = {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  status: string;
  last_login_at: Date | string | null;
  password_changed_at: Date | string | null;
  created_at: Date | string;
};

export async function countOwners(): Promise<number> {
  const rows = await query<Array<{ count: number }>>(
    `SELECT COUNT(*) AS count FROM admin_accounts WHERE role = 'OWNER'`,
  );
  return Number(rows[0]?.count || 0);
}

export async function getAdminByEmail(email: string): Promise<(AdminAccount & { passwordHash: string }) | null> {
  const rows = await query<AdminRow[]>(
    `SELECT * FROM admin_accounts WHERE email = ? LIMIT 1`,
    [email.trim().toLowerCase()],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    passwordChangedAt: row.password_changed_at ? new Date(row.password_changed_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    passwordHash: row.password_hash,
  };
}

export async function getAdminById(id: string): Promise<AdminAccount | null> {
  const rows = await query<AdminRow[]>(`SELECT * FROM admin_accounts WHERE id = ? LIMIT 1`, [id]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    passwordChangedAt: row.password_changed_at ? new Date(row.password_changed_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function resetOwnerAccounts(): Promise<number> {
  const owners = await query<Array<{ id: string }>>(
    `SELECT id FROM admin_accounts WHERE role = 'OWNER'`,
  );
  for (const owner of owners) {
    await query(`DELETE FROM admin_accounts WHERE id = ?`, [owner.id]);
  }
  return owners.length;
}

export async function bootstrapOwner(input: {
  email: string;
  password: string;
  totpSecret: string;
  recoveryCodes: string[];
  force?: boolean;
}): Promise<AdminAccount | null> {
  return withNamedLock('admin-owner-bootstrap', 30, async () => {
    if (input.force) throw new Error('Bootstrap cannot replace an existing owner. Use the separate recovery procedure.');
    if (await countOwners() > 0) return null;

    const strengthError = validatePasswordStrength(input.password);
    if (strengthError) throw new Error(strengthError);

    const email = input.email.trim().toLowerCase();
    const id = uuidv4();
    const passwordHash = await hashPassword(input.password);

    await withTransaction(async (exec) => {
      await exec(
        `INSERT INTO admin_accounts (id, email, password_hash, role, status, password_changed_at)
         VALUES (?, ?, ?, 'OWNER', 'ACTIVE', CURRENT_TIMESTAMP)`,
        [id, email, passwordHash],
      );

      await exec(
        `INSERT INTO admin_mfa_credentials (id, admin_id, kind, label, secret_encrypted)
         VALUES (?, ?, 'TOTP', 'Primary authenticator', ?)`,
        [uuidv4(), id, encryptTotpSecret(input.totpSecret)],
      );

      for (const code of input.recoveryCodes) {
        await exec(
          `INSERT INTO admin_recovery_codes (id, admin_id, code_hash) VALUES (?, ?, ?)`,
          [uuidv4(), id, hashRecoveryCode(code)],
        );
      }
    });

    const account = await getAdminById(id);
    if (!account) throw new Error('Failed to create owner account');
    return account;
  });
}

export async function listActiveMfaKinds(adminId: string): Promise<Array<'TOTP' | 'WEBAUTHN'>> {
  const rows = await query<Array<{ kind: 'TOTP' | 'WEBAUTHN' }>>(
    `SELECT kind FROM admin_mfa_credentials WHERE admin_id = ? AND revoked_at IS NULL`,
    [adminId],
  );
  return rows.map((row) => row.kind);
}

export async function getTotpSecretForAdmin(adminId: string): Promise<string | null> {
  const rows = await query<Array<{ secret_encrypted: string | null }>>(
    `SELECT secret_encrypted FROM admin_mfa_credentials
     WHERE admin_id = ? AND kind = 'TOTP' AND revoked_at IS NULL
     ORDER BY created_at ASC LIMIT 1`,
    [adminId],
  );
  return rows[0]?.secret_encrypted || null;
}

export async function consumeRecoveryCode(adminId: string, code: string): Promise<boolean> {
  const codeHash = hashRecoveryCode(code);
  const rows = await query<Array<{ id: string }>>(
    `SELECT id FROM admin_recovery_codes
     WHERE admin_id = ? AND code_hash = ? AND used_at IS NULL LIMIT 1`,
    [adminId, codeHash],
  );
  if (!rows[0]) return false;
  await query(`UPDATE admin_recovery_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?`, [rows[0].id]);
  return true;
}
