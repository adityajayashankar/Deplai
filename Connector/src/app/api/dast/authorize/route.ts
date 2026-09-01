import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { createScanRecord, resolveAuthorizedAsset } from '@/lib/dast/store';
import { denyUnlessPlanFeature } from '@/lib/billing/plan-access-guard';

function profileIntent(profile: string): { profile: 'BASELINE' | 'FULL' | 'API'; intent: 'PASSIVE' | 'ACTIVE' | 'API_ACTIVE' } {
  const value = String(profile || 'BASELINE').toUpperCase();
  if (value === 'FULL') return { profile: 'FULL', intent: 'ACTIVE' };
  if (value === 'API') return { profile: 'API', intent: 'API_ACTIVE' };
  return { profile: 'BASELINE', intent: 'PASSIVE' };
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const denied = await denyUnlessPlanFeature(request, auth.user, 'dast');
  if (denied) return denied;
  const body = await request.json().catch(() => ({})) as {
    project_id?: string;
    asset_id?: string;
    target_url?: string;
    scan_profile?: string;
    idempotency_key?: string;
  };
  const projectId = String(body.project_id || '').trim();
  if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
  const ownership = await verifyProjectOwnership(auth.user.id, projectId, 'security.scan.run');
  if ('error' in ownership) return ownership.error;
  try {
    const { asset, grant, targetUrl } = await resolveAuthorizedAsset({
      userId: auth.user.id,
      projectId,
      assetId: String(body.asset_id || '').trim() || undefined,
      targetUrl: String(body.target_url || '').trim() || undefined,
    });
    const { profile, intent } = profileIntent(body.scan_profile || 'BASELINE');
    const scanId = await createScanRecord({
      userId: auth.user.id,
      projectId,
      asset,
      targetUrl,
      profile,
      intent,
      idempotencyKey: String(body.idempotency_key || '').trim() || undefined,
    });
    return NextResponse.json({
      authorized: true,
      scan_id: scanId,
      target_url: targetUrl,
      asset_id: asset.id,
      scan_profile: profile,
      scan_intent: intent,
      grant,
    });
  } catch (error) {
    const code = (error as { code?: string }).code || 'DAST_TARGET_NOT_AUTHORIZED';
    const status = Number((error as { status?: number }).status || 403);
    return NextResponse.json({
      authorized: false,
      code,
      error: error instanceof Error ? error.message : 'This target is not associated with the selected project and ownership has not been verified.',
    }, { status });
  }
}
