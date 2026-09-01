import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { decryptTotpSecret, verifyTotpCode } from '@/lib/auth/totp';
import { consumeRecoveryCode, getAdminById, getTotpSecretForAdmin } from '@/lib/admin/accounts';
import { createAdminSession } from '@/lib/auth/sessions';
import { hashToken } from '@/lib/crypto';
import { query } from '@/lib/db';
import { authCookieOptions, getAuthCookieNames } from '@/lib/auth/cookies';
import { writeAdminAuditLog, recordSecurityEvent } from '@/lib/audit/logger';
import { clearFailedLogins } from '@/lib/auth/brute-force';
import { getClientIp, isPrivateNetworkRequest, setSessionCookies } from '@/lib/http/request-context';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  if (!isPrivateNetworkRequest(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const names = getAuthCookieNames();
  const cookieStore = await cookies();
  const pendingToken = cookieStore.get(names.pending)?.value;
  if (!pendingToken) {
    return NextResponse.json({ error: 'Login session expired. Please sign in again.' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as { code?: string; recoveryCode?: string };
  const code = String(body.code || '').trim();
  const recoveryCode = String(body.recoveryCode || '').trim();
  const ip = getClientIp(request);

  const pendingRows = await query<Array<{ id: string; admin_id: string }>>(
    `SELECT id, admin_id FROM admin_pending_auth
     WHERE token_hash = ? AND kind = 'MFA' AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [hashToken(pendingToken)],
  );
  const pending = pendingRows[0];
  if (!pending) {
    return NextResponse.json({ error: 'Login session expired. Please sign in again.' }, { status: 401 });
  }

  const admin = await getAdminById(pending.admin_id);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let verified = false;
  if (recoveryCode) {
    verified = await consumeRecoveryCode(admin.id, recoveryCode);
  } else if (code) {
    const encrypted = await getTotpSecretForAdmin(admin.id);
    if (encrypted) {
      const secret = decryptTotpSecret(encrypted);
      verified = verifyTotpCode(secret, code);
    }
  }

  if (!verified) {
    await writeAdminAuditLog({ actorAdminId: admin.id, action: 'ADMIN_MFA_FAILURE', ip, success: false });
    await recordSecurityEvent({ adminId: admin.id, eventType: 'ADMIN_MFA_FAILURE', ip });
    return NextResponse.json({ error: 'Invalid MFA code' }, { status: 401 });
  }

  await query(`DELETE FROM admin_pending_auth WHERE id = ?`, [pending.id]);
  await clearFailedLogins(admin.id);

  const { sessionToken, csrfToken } = await createAdminSession({
    adminId: admin.id,
    ip,
    userAgent: request.headers.get('user-agent'),
    mfaVerified: true,
  });

  await writeAdminAuditLog({
    actorAdminId: admin.id,
    action: 'ADMIN_MFA_SUCCESS',
    ip,
    success: true,
  });
  await writeAdminAuditLog({
    actorAdminId: admin.id,
    action: 'ADMIN_LOGIN_SUCCESS',
    ip,
    success: true,
  });

  const response = NextResponse.json({ ok: true });
  setSessionCookies(response, { sessionToken, csrfToken });
  response.cookies.set(names.pending, '', authCookieOptions({ maxAge: 0 }));
  return response;
}
