import { NextRequest, NextResponse } from 'next/server';
import { writeAdminAuditLog } from '@/lib/audit/logger';
import { requireAdminApi } from '@/lib/http/request-context';
import { listProjectsWithAdminStatus, setProjectAdminStatus } from '@/lib/platform/projects-admin';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await requireAdminApi(request, { permission: 'ADMIN_PROJECT_READ' });
  if ('error' in auth) return auth.error;

  const url = new URL(request.url);
  const projects = await listProjectsWithAdminStatus({
    search: url.searchParams.get('q') || undefined,
    limit: Number(url.searchParams.get('limit') || 50),
    offset: Number(url.searchParams.get('offset') || 0),
  });
  return NextResponse.json({ projects });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminApi(request, {
    permission: 'ADMIN_PROJECT_WRITE',
    stepUp: 'project.delete',
  });
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => ({})) as {
    projectId?: string;
    action?: 'disable' | 'enable';
    reason?: string;
  };

  const projectId = String(body.projectId || '');
  const action = body.action;
  const reason = String(body.reason || '').trim();
  if (!projectId || !action || !reason) {
    return NextResponse.json({ error: 'projectId, action, and reason are required' }, { status: 400 });
  }

  await setProjectAdminStatus({
    projectId,
    disabled: action === 'disable',
    reason,
    adminId: auth.context.session.adminId,
  });

  await writeAdminAuditLog({
    actorAdminId: auth.context.session.adminId,
    action: action === 'disable' ? 'PROJECT_DISABLED' : 'PROJECT_ENABLED',
    targetType: 'project',
    targetId: projectId,
    ip: auth.context.ip,
    sessionId: auth.context.session.id,
    reason,
  });

  return NextResponse.json({ projectId, disabled: action === 'disable' });
}
