import { v4 as uuidv4 } from 'uuid';
import { getAdminConfig } from '@/lib/config';
import { hashToken, randomToken } from '@/lib/crypto';
import { query } from '@/lib/db';

export type AdminSession = {
  id: string;
  adminId: string;
  email: string;
  role: string;
  mfaVerified: boolean;
  elevatedUntil: Date | null;
  expiresAt: Date;
  absoluteExpiresAt: Date;
};

type SessionRow = {
  id: string;
  admin_id: string;
  token_hash: string;
  csrf_token_hash: string;
  mfa_verified: number;
  elevated_until: Date | string | null;
  expires_at: Date | string;
  absolute_expires_at: Date | string;
  revoked_at: Date | string | null;
  email: string;
  role: string;
};

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export async function createAdminSession(input: {
  adminId: string;
  ip?: string | null;
  userAgent?: string | null;
  mfaVerified?: boolean;
}): Promise<{ sessionToken: string; csrfToken: string; session: AdminSession }> {
  const config = getAdminConfig();
  const sessionToken = randomToken(48);
  const csrfToken = randomToken(32);
  const id = uuidv4();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.sessionIdleMinutes * 60_000);
  const absoluteExpiresAt = new Date(now.getTime() + config.sessionAbsoluteHours * 60 * 60_000);

  await query(
    `INSERT INTO admin_sessions
      (id, admin_id, token_hash, csrf_token_hash, ip, user_agent, mfa_verified, expires_at, absolute_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.adminId,
      hashToken(sessionToken),
      hashToken(csrfToken),
      input.ip?.slice(0, 64) || null,
      input.userAgent?.slice(0, 512) || null,
      input.mfaVerified ? 1 : 0,
      expiresAt,
      absoluteExpiresAt,
    ],
  );

  const rows = await query<SessionRow[]>(
    `SELECT s.*, a.email, a.role
     FROM admin_sessions s
     JOIN admin_accounts a ON a.id = s.admin_id
     WHERE s.id = ?`,
    [id],
  );

  return {
    sessionToken,
    csrfToken,
    session: mapSession(rows[0]),
  };
}

export async function getSessionByToken(sessionToken: string): Promise<AdminSession | null> {
  const rows = await query<SessionRow[]>(
    `SELECT s.*, a.email, a.role
     FROM admin_sessions s
     JOIN admin_accounts a ON a.id = s.admin_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL
     LIMIT 1`,
    [hashToken(sessionToken)],
  );
  const row = rows[0];
  if (!row) return null;

  const now = new Date();
  const expiresAt = toDate(row.expires_at);
  const absoluteExpiresAt = toDate(row.absolute_expires_at);
  if (expiresAt <= now || absoluteExpiresAt <= now) {
    await revokeSession(row.id);
    return null;
  }

  const config = getAdminConfig();
  const nextExpiry = new Date(now.getTime() + config.sessionIdleMinutes * 60_000);
  const boundedExpiry = nextExpiry < absoluteExpiresAt ? nextExpiry : absoluteExpiresAt;
  await query(`UPDATE admin_sessions SET last_seen_at = CURRENT_TIMESTAMP, expires_at = ? WHERE id = ?`, [
    boundedExpiry,
    row.id,
  ]);

  return mapSession({ ...row, expires_at: boundedExpiry });
}

export async function verifySessionCsrf(sessionToken: string, csrfToken: string): Promise<boolean> {
  const rows = await query<Array<{ csrf_token_hash: string }>>(
    `SELECT csrf_token_hash FROM admin_sessions WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
    [hashToken(sessionToken)],
  );
  return rows[0]?.csrf_token_hash === hashToken(csrfToken);
}

export async function markSessionMfaVerified(sessionId: string): Promise<void> {
  await query(`UPDATE admin_sessions SET mfa_verified = 1 WHERE id = ?`, [sessionId]);
}

export async function rotateSessionTokens(sessionId: string): Promise<{ sessionToken: string; csrfToken: string }> {
  const sessionToken = randomToken(48);
  const csrfToken = randomToken(32);
  await query(
    `UPDATE admin_sessions SET token_hash = ?, csrf_token_hash = ? WHERE id = ?`,
    [hashToken(sessionToken), hashToken(csrfToken), sessionId],
  );
  return { sessionToken, csrfToken };
}

export async function grantStepUp(sessionId: string, adminId: string, scope: string): Promise<Date> {
  const config = getAdminConfig();
  const expiresAt = new Date(Date.now() + config.stepUpMinutes * 60_000);
  await query(
    `INSERT INTO admin_step_up_grants (id, session_id, admin_id, scope, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [uuidv4(), sessionId, adminId, scope.slice(0, 64), expiresAt],
  );
  await query(`UPDATE admin_sessions SET elevated_until = ? WHERE id = ?`, [expiresAt, sessionId]);
  return expiresAt;
}

export async function hasValidStepUp(sessionId: string, scope: string): Promise<boolean> {
  const rows = await query<Array<{ id: string }>>(
    `SELECT id FROM admin_step_up_grants
     WHERE session_id = ? AND scope = ? AND expires_at > CURRENT_TIMESTAMP
     ORDER BY granted_at DESC LIMIT 1`,
    [sessionId, scope.slice(0, 64)],
  );
  return rows.length > 0;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await query(`UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?`, [sessionId]);
}

export async function revokeAllSessions(adminId: string, exceptSessionId?: string): Promise<void> {
  if (exceptSessionId) {
    await query(
      `UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE admin_id = ? AND id <> ? AND revoked_at IS NULL`,
      [adminId, exceptSessionId],
    );
    return;
  }
  await query(
    `UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE admin_id = ? AND revoked_at IS NULL`,
    [adminId],
  );
}

function mapSession(row: SessionRow): AdminSession {
  return {
    id: row.id,
    adminId: row.admin_id,
    email: row.email,
    role: row.role,
    mfaVerified: Boolean(row.mfa_verified),
    elevatedUntil: row.elevated_until ? toDate(row.elevated_until) : null,
    expiresAt: toDate(row.expires_at),
    absoluteExpiresAt: toDate(row.absolute_expires_at),
  };
}
