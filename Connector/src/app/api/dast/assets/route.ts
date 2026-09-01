import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { createAsset, listAssets, publicAsset } from '@/lib/dast/store';
import type { DastScopeMode } from '@/lib/dast/scope';

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const projectId = String(request.nextUrl.searchParams.get('project_id') || '').trim();
  if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
  const ownership = await verifyProjectOwnership(auth.user.id, projectId, 'security.scan.read');
  if ('error' in ownership) return ownership.error;
  const rows = await listAssets(auth.user.id, projectId, ownership.project.organization_id);
  return NextResponse.json({ assets: rows.map((row) => publicAsset(row, { includeToken: row.status === 'PENDING' })) });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => ({})) as {
    project_id?: string;
    target_url?: string;
    environment?: string;
    scope_mode?: string;
  };
  const projectId = String(body.project_id || '').trim();
  if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
  const ownership = await verifyProjectOwnership(auth.user.id, projectId, 'security.scan.run');
  if ('error' in ownership) return ownership.error;
  const scopeMode = String(body.scope_mode || 'VERIFIED_HOST').toUpperCase() as DastScopeMode;
  if (scopeMode !== 'VERIFIED_HOST' && scopeMode !== 'VERIFIED_DOMAIN' && scopeMode !== 'PROJECT_ASSET') {
    return NextResponse.json({ error: 'Invalid scope_mode' }, { status: 400 });
  }
  try {
    const asset = await createAsset({
      userId: auth.user.id,
      organizationId: ownership.project.organization_id,
      projectId,
      targetUrl: String(body.target_url || ''),
      environment: String(body.environment || 'production'),
      scopeMode,
    });
    return NextResponse.json({ asset: publicAsset(asset, { includeToken: true }) }, { status: 201 });
  } catch (error) {
    const code = (error as { code?: string }).code;
    const status = Number((error as { status?: number }).status || 400);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to add target', code }, { status });
  }
}
