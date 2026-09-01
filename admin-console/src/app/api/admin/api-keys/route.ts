import { NextRequest, NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/http/request-context';
import { listApiKeys, listProviderKeys, revokeApiKey } from '@/lib/platform/api-keys';
import { writeAdminAuditLog } from '@/lib/audit/logger';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await requireAdminApi(request, { permission: 'ADMIN_SECURITY_READ' });
  if ('error' in auth) return auth.error;
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind') || 'api';
  if (kind === 'provider') {
    const keys = await listProviderKeys({
      search: url.searchParams.get('q') || undefined,
      limit: Number(url.searchParams.get('limit') || 50),
      offset: Number(url.searchParams.get('offset') || 0),
    });
    return NextResponse.json({ keys });
  }
  const keys = await listApiKeys({
    search: url.searchParams.get('q') || undefined,
    limit: Number(url.searchParams.get('limit') || 50),
    offset: Number(url.searchParams.get('offset') || 0),
  });
  return NextResponse.json({ keys });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminApi(request, {
    permission: 'ADMIN_KEY_REVOKE',
    stepUp: 'api_key.revoke_all',
  });
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => ({})) as { userId?: string; reason?: string };
  const userId = String(body.userId || '');
  const reason = String(body.reason || '').trim();
  if (!userId || !reason) {
    return NextResponse.json({ error: 'userId and reason are required' }, { status: 400 });
  }

  await revokeApiKey(userId);
  await writeAdminAuditLog({
    actorAdminId: auth.context.session.adminId,
    action: 'API_KEY_REVOKED',
    targetType: 'user',
    targetId: userId,
    ip: auth.context.ip,
    sessionId: auth.context.session.id,
    reason,
  });
  return NextResponse.json({ revoked: true });
}
