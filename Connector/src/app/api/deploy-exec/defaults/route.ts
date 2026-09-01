import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { fetchArtifactDefaults, listDeployments } from '@/lib/deploy-exec/store';

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => ({})) as Record<string, string>;
  const projectId = String(body.project_id || '').trim();
  if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
  const ownership = await verifyProjectOwnership(auth.user.id, projectId, 'deployment.read');
  if ('error' in ownership) return ownership.error;
  const environmentId = String(body.environment_id || '').trim();
  const image = String(body.image || '').trim();
  const deployments = (await listDeployments(auth.user.id, projectId))
    .filter((row) => !environmentId || row.environment_id === environmentId);
  const lastSuccess = deployments.find((row) => ['COMPLETED', 'ROLLED_BACK'].includes(String(row.status || '').toUpperCase()) && !row.dry_run);
  const lastAny = deployments[0] || null;
  const previous = lastSuccess || lastAny;
  let digest = '';
  let resolvedImage = image || String(previous?.artifact_image || '').trim();
  let note = '';
  if (resolvedImage) {
    try {
      const remote = await fetchArtifactDefaults(resolvedImage, {
        aws_access_key_id: body.aws_access_key_id,
        aws_secret_access_key: body.aws_secret_access_key,
        aws_session_token: body.aws_session_token,
        aws_region: body.aws_region || body.region,
        account_id: body.account_id,
      });
      resolvedImage = String(remote.image || resolvedImage);
      digest = String(remote.digest || '').trim();
      note = String(remote.note || '');
    } catch (error) {
      note = error instanceof Error ? error.message : 'Could not read the latest ECR digest.';
    }
  }
  if (resolvedImage && !digest) {
    note = note || 'No image in ECR yet. Redeploy so DeplAI builds the app on the instance from your repository — you do not need to push a Docker image yourself.';
  }
  const previousDigest = String(previous?.artifact_digest || '').trim();
  return NextResponse.json({
    image: resolvedImage,
    digest,
    previous_digest: previousDigest && previousDigest !== digest ? previousDigest : '',
    previous_image: String(previous?.artifact_image || ''),
    note,
  });
}
