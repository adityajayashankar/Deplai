import { NextRequest, NextResponse } from 'next/server';
import { revokeSession } from '@/lib/auth/sessions';
import { writeAdminAuditLog } from '@/lib/audit/logger';
import { clearSessionCookies, readSessionToken, requireAdminApi } from '@/lib/http/request-context';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const auth = await requireAdminApi(request, { requireMfa: false });
  if ('error' in auth) return auth.error;

  await revokeSession(auth.context.session.id);
  await writeAdminAuditLog({
    actorAdminId: auth.context.session.adminId,
    action: 'ADMIN_LOGOUT',
    ip: auth.context.ip,
    sessionId: auth.context.session.id,
    success: true,
  });

  const response = NextResponse.json({ ok: true });
  clearSessionCookies(response);
  return response;
}

export async function GET(request: NextRequest) {
  const sessionToken = await readSessionToken();
  if (!sessionToken) {
    const response = NextResponse.json({ ok: true });
    clearSessionCookies(response);
    return response;
  }
  const auth = await requireAdminApi(request, { requireMfa: false });
  if ('error' in auth) {
    const response = NextResponse.json({ ok: true });
    clearSessionCookies(response);
    return response;
  }
  await revokeSession(auth.context.session.id);
  const response = NextResponse.json({ ok: true });
  clearSessionCookies(response);
  return response;
}
