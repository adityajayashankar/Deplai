import { query } from '@/lib/db';

const WINDOW_MINUTES = 15;
const MAX_ATTEMPTS_PER_IP = 20;
const MAX_ATTEMPTS_PER_EMAIL = 10;
const LOCKOUT_MINUTES = 30;
const MAX_FAILED_BEFORE_LOCK = 8;

export async function recordLoginAttempt(input: {
  email: string;
  ip?: string | null;
  success: boolean;
}): Promise<void> {
  await query(
    `INSERT INTO admin_login_attempts (email, ip, success) VALUES (?, ?, ?)`,
    [input.email.toLowerCase(), input.ip?.slice(0, 64) || null, input.success ? 1 : 0],
  );
}

export async function isLoginRateLimited(email: string, ip?: string | null): Promise<boolean> {
  const [ipRows, emailRows] = await Promise.all([
    ip
      ? query<Array<{ count: number }>>(
          `SELECT COUNT(*) AS count FROM admin_login_attempts
           WHERE ip = ? AND success = 0 AND created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
          [ip.slice(0, 64), WINDOW_MINUTES],
        )
      : Promise.resolve([{ count: 0 }]),
    query<Array<{ count: number }>>(
      `SELECT COUNT(*) AS count FROM admin_login_attempts
       WHERE email = ? AND success = 0 AND created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
      [email.toLowerCase(), WINDOW_MINUTES],
    ),
  ]);

  return Number(ipRows[0]?.count || 0) >= MAX_ATTEMPTS_PER_IP
    || Number(emailRows[0]?.count || 0) >= MAX_ATTEMPTS_PER_EMAIL;
}

export async function registerFailedLogin(adminId: string): Promise<{ locked: boolean }> {
  await query(
    `UPDATE admin_accounts
     SET failed_login_count = failed_login_count + 1,
         locked_until = CASE
           WHEN failed_login_count + 1 >= ? THEN DATE_ADD(NOW(), INTERVAL ? MINUTE)
           ELSE locked_until
         END,
         status = CASE
           WHEN failed_login_count + 1 >= ? THEN 'LOCKED'
           ELSE status
         END
     WHERE id = ?`,
    [MAX_FAILED_BEFORE_LOCK, LOCKOUT_MINUTES, MAX_FAILED_BEFORE_LOCK, adminId],
  );

  const rows = await query<Array<{ status: string }>>(
    `SELECT status FROM admin_accounts WHERE id = ?`,
    [adminId],
  );
  return { locked: rows[0]?.status === 'LOCKED' };
}

export async function clearFailedLogins(adminId: string): Promise<void> {
  await query(
    `UPDATE admin_accounts
     SET failed_login_count = 0, locked_until = NULL,
         status = CASE WHEN status = 'LOCKED' THEN 'ACTIVE' ELSE status END,
         last_login_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [adminId],
  );
}

export async function isAccountLocked(adminId: string): Promise<boolean> {
  const rows = await query<Array<{ status: string; locked_until: Date | string | null }>>(
    `SELECT status, locked_until FROM admin_accounts WHERE id = ?`,
    [adminId],
  );
  const row = rows[0];
  if (!row) return true;
  if (row.status === 'DISABLED') return true;
  if (row.status === 'LOCKED') {
    if (!row.locked_until) return true;
    if (new Date(row.locked_until) > new Date()) return true;
    await query(`UPDATE admin_accounts SET status = 'ACTIVE', locked_until = NULL, failed_login_count = 0 WHERE id = ?`, [adminId]);
  }
  return false;
}
