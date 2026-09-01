import { NextRequest, NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/http/request-context';
import { listUsers, getUserDetail, revokeUserSessions } from '@/lib/platform/users';
import { writeAdminAuditLog } from '@/lib/audit/logger';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await requireAdminApi(request, { permission: 'ADMIN_USER_READ' });
  if ('error' in auth) return auth.error;

  const url = new URL(request.url);
  const userId = url.searchParams.get('id');
  if (userId) {
    const user = await getUserDetail(userId);
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    await writeAdminAuditLog({
      actorAdminId: auth.context.session.adminId,
      action: 'USER_VIEWED',
      targetType: 'user',
      targetId: userId,
      ip: auth.context.ip,
      sessionId: auth.context.session.id,
    });
    return NextResponse.json({ user });
  }

  const users = await listUsers({
    search: url.searchParams.get('q') || undefined,
    limit: Number(url.searchParams.get('limit') || 50),
    offset: Number(url.searchParams.get('offset') || 0),
  });
  return NextResponse.json(users);
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminApi(request, {
    permission: 'ADMIN_USER_WRITE',
    stepUp: 'user.revoke_sessions',
  });
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => ({})) as { userId?: string; action?: string; reason?: string };
  const userId = String(body.userId || '');
  const action = String(body.action || '');
  const reason = String(body.reason || '').trim();
  if (!userId || action !== 'revoke_sessions' || !reason) {
    return NextResponse.json({ error: 'userId, action=revoke_sessions, and reason are required' }, { status: 400 });
  }

  const revoked = await revokeUserSessions(userId);
  await writeAdminAuditLog({
    actorAdminId: auth.context.session.adminId,
    action: 'USER_SESSIONS_REVOKED',
    targetType: 'user',
    targetId: userId,
    ip: auth.context.ip,
    sessionId: auth.context.session.id,
    reason,
    after: { revoked },
  });
  return NextResponse.json({ revoked });
}
