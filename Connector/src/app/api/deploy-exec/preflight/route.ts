import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { buildContract, postPreflight } from '@/lib/deploy-exec/store';

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const projectId = String(body.project_id || '').trim();
  if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
  const ownership = await verifyProjectOwnership(auth.user.id, projectId);
  if ('error' in ownership) return ownership.error;
  const contract = buildContract({
    deploymentId: 'preflight',
    projectId,
    environmentId: String(body.environment_id || 'production'),
    requestedBy: auth.user.id,
    instanceId: String(body.instance_id || ''),
    region: String(body.region || body.aws_region || ''),
    accountId: String(body.account_id || ''),
    image: String(body.image || ''),
    digest: String(body.digest || '').toLowerCase(),
    containerPort: Number(body.container_port || 3000),
    hostPort: Number(body.host_port || 80),
    healthEndpoint: String(body.health_endpoint || '/health'),
    publicEndpoint: String(body.public_endpoint || ''),
    previousDigest: String(body.previous_digest || '') || undefined,
    previousImage: String(body.previous_image || '') || undefined,
  });
  try {
    const remote = await postPreflight(contract, {
      aws_access_key_id: String(body.aws_access_key_id || ''),
      aws_secret_access_key: String(body.aws_secret_access_key || ''),
      aws_session_token: String(body.aws_session_token || ''),
      aws_region: String(body.region || body.aws_region || ''),
      account_id: String(body.account_id || ''),
    });
    return NextResponse.json({ ready: remote.status === 'COMPLETED', ...remote, result: remote.result || 'PENDING' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Preflight failed';
    return NextResponse.json({ ready: false, error: message, result: 'FAILED' }, { status: 400 });
  }
}
