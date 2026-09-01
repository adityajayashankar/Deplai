import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/auth/password';
import { isLoginRateLimited, recordLoginAttempt, registerFailedLogin, clearFailedLogins, isAccountLocked } from '@/lib/auth/brute-force';
import { getAdminByEmail } from '@/lib/admin/accounts';
import { hashToken, randomToken } from '@/lib/crypto';
import { query } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { authCookieOptions, getAuthCookieNames } from '@/lib/auth/cookies';
import { writeAdminAuditLog, recordSecurityEvent } from '@/lib/audit/logger';
import { getClientIp, isPrivateNetworkRequest } from '@/lib/http/request-context';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  if (!isPrivateNetworkRequest(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({})) as { email?: string; password?: string };
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const ip = getClientIp(request);

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
  }

  if (await isLoginRateLimited(email, ip)) {
    await recordSecurityEvent({ eventType: 'ADMIN_LOGIN_RATE_LIMITED', ip, metadata: { email } });
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });
  }

  const admin = await getAdminByEmail(email);
  if (!admin || admin.status === 'DISABLED') {
    await recordLoginAttempt({ email, ip, success: false });
    await writeAdminAuditLog({ action: 'ADMIN_LOGIN_FAILURE', ip, success: false, metadata: { email } });
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  if (await isAccountLocked(admin.id)) {
    return NextResponse.json({ error: 'Account is locked' }, { status: 423 });
  }

  const valid = await verifyPassword(password, admin.passwordHash);
  if (!valid) {
    await recordLoginAttempt({ email, ip, success: false });
    await registerFailedLogin(admin.id);
    await writeAdminAuditLog({ actorAdminId: admin.id, action: 'ADMIN_LOGIN_FAILURE', ip, success: false });
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  await recordLoginAttempt({ email, ip, success: true });
  const pendingToken = randomToken(32);
  const pendingId = uuidv4();
  await query(
    `INSERT INTO admin_pending_auth (id, admin_id, kind, token_hash, ip, expires_at)
     VALUES (?, ?, 'MFA', ?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))`,
    [pendingId, admin.id, hashToken(pendingToken), ip],
  );

  const names = getAuthCookieNames();
  const response = NextResponse.json({ mfaRequired: true });
  response.cookies.set(names.pending, pendingToken, authCookieOptions({ maxAge: 30 * 60 }));
  return response;
}
