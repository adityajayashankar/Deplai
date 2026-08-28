import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';
import { resolveAuthorizedAsset } from '@/lib/dast/store';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { id } = await params;
  const rows = await query<Array<{
    id: string;
    project_id: string;
    asset_id: string;
    target_url: string;
    scan_profile: string;
  }>>(
    `SELECT id, project_id, asset_id, target_url, scan_profile FROM dast_scans WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, auth.user.id],
  );
  const scan = rows[0];
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 });
  try {
    const resolved = await resolveAuthorizedAsset({
      userId: auth.user.id,
      projectId: String(scan.project_id),
      assetId: String(scan.asset_id),
      targetUrl: String(scan.target_url),
    });
    return NextResponse.json({
      authorized: true,
      retry_of: id,
      target_url: resolved.targetUrl,
      asset_id: resolved.asset.id,
      scan_profile: scan.scan_profile,
      grant: resolved.grant,
    });
  } catch (error) {
    const code = (error as { code?: string }).code || 'DAST_TARGET_NOT_AUTHORIZED';
    return NextResponse.json({
      authorized: false,
      code,
      error: error instanceof Error ? error.message : 'Scan is no longer authorized.',
    }, { status: 403 });
  }
}
