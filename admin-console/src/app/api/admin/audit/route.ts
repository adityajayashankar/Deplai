import { NextRequest, NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/http/request-context';
import { listAuditLogs, listSecurityEvents } from '@/lib/platform/audit';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await requireAdminApi(request, { permission: 'ADMIN_AUDIT_READ' });
  if ('error' in auth) return auth.error;
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind') || 'audit';
  if (kind === 'security') {
    const events = await listSecurityEvents({
      limit: Number(url.searchParams.get('limit') || 50),
      offset: Number(url.searchParams.get('offset') || 0),
    });
    return NextResponse.json({ events });
  }
  const data = await listAuditLogs({
    action: url.searchParams.get('action') || undefined,
    limit: Number(url.searchParams.get('limit') || 50),
    offset: Number(url.searchParams.get('offset') || 0),
  });
  return NextResponse.json(data);
}
