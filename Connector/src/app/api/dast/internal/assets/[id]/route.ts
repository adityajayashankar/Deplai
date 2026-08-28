import { NextRequest, NextResponse } from 'next/server';
import { requireServiceKey } from '@/lib/auth';
import { getAssetById, isAssetVerified } from '@/lib/dast/store';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireServiceKey(request);
  if (denied) return denied;
  const { id } = await params;
  const asset = await getAssetById(id);
  if (!asset) return NextResponse.json({ error: 'Target not found' }, { status: 404 });
  const verified = isAssetVerified(asset);
  return NextResponse.json({
    asset: {
      id: asset.id,
      project_id: asset.project_id,
      hostname: asset.hostname,
      scheme: asset.scheme,
      port: asset.port,
      path_prefix: asset.path_prefix,
      scope_mode: asset.scope_mode,
      status: verified.ok ? asset.status : (asset.status === 'REVOKED' ? 'REVOKED' : asset.status),
      verification_method: asset.verification_method,
      verified_at: asset.verified_at,
      verification_expires_at: asset.expires_at,
      revoked_at: asset.revoked_at,
    },
  });
}
