import { NextRequest, NextResponse } from 'next/server';
import { isAdminUser, requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { getAsset, publicAsset, revokeAsset } from '@/lib/dast/store';
import { query } from '@/lib/db';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { id } = await params;
  const asset = await getAsset(auth.user.id, id);
  if (!asset) return NextResponse.json({ error: 'Target not found' }, { status: 404 });
  const ownership = await verifyProjectOwnership(auth.user.id, asset.project_id);
  if ('error' in ownership) return ownership.error;
  const payload: Record<string, unknown> = { asset: publicAsset(asset, { includeToken: asset.status === 'PENDING' }) };
  if (isAdminUser(auth.user)) {
    const audit = await query(
      `SELECT id, action, decision, reason, created_at FROM dast_audit_events WHERE asset_id = ? ORDER BY created_at DESC LIMIT 50`,
      [id],
    );
    payload.audit = audit;
  }
  return NextResponse.json(payload);
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { id } = await params;
  const asset = await revokeAsset(auth.user.id, id);
  if (!asset) return NextResponse.json({ error: 'Target not found' }, { status: 404 });
  return NextResponse.json({ asset: publicAsset(asset) });
}
