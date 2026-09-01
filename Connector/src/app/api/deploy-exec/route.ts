import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { withNamedLock } from '@/lib/db';
import {
  buildContract,
  insertDeployment,
  listDeployments,
  recordEvent,
  startOnAgentic,
  syncDeployment,
} from '@/lib/deploy-exec/store';

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const projectId = String(request.nextUrl.searchParams.get('project_id') || '').trim();
  if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
  const ownership = await verifyProjectOwnership(auth.user.id, projectId, 'deployment.read');
  if ('error' in ownership) return ownership.error;
  const deployments = await listDeployments(auth.user.id, projectId, ownership.project.organization_id);
  return NextResponse.json({ deployments });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const projectId = String(body.project_id || '').trim();
  if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
  const ownership = await verifyProjectOwnership(auth.user.id, projectId, 'deployment.create');
  if ('error' in ownership) return ownership.error;
  const environmentId = String(body.environment_id || 'production').trim() || 'production';
  const image = String(body.image || '').trim();
  const digest = String(body.digest || '').trim().toLowerCase();
  const instanceId = String(body.instance_id || '').trim();
  const region = String(body.region || body.aws_region || '').trim();
  if (!image || !digest || !instanceId || !region) {
    return NextResponse.json({ error: 'image, digest, instance_id, and region are required' }, { status: 400 });
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    return NextResponse.json({ error: 'digest must be sha256:<64 hex chars>' }, { status: 400 });
  }
  const deploymentId = randomUUID();
  const contract = buildContract({
    deploymentId,
    projectId,
    environmentId,
    requestedBy: auth.user.id,
    instanceId,
    region,
    accountId: String(body.account_id || '').trim(),
    image,
    digest,
    repository: String(body.repository || '').trim() || undefined,
    containerName: String(body.container_name || '').trim() || undefined,
    containerPort: Number(body.container_port || 3000),
    hostPort: Number(body.host_port || 80),
    healthEndpoint: String(body.health_endpoint || '/health'),
    publicEndpoint: String(body.public_endpoint || '').trim(),
    sourceCommit: String(body.source_commit || '').trim(),
    previousImage: String(body.previous_image || '').trim() || undefined,
    previousDigest: String(body.previous_digest || '').trim() || undefined,
    secretReferences: Array.isArray(body.secret_references) ? body.secret_references as Array<{ name: string; arn: string }> : [],
  });
  const dryRun = Boolean(body.dry_run);
  const creds = {
    aws_access_key_id: String(body.aws_access_key_id || ''),
    aws_secret_access_key: String(body.aws_secret_access_key || ''),
    aws_session_token: String(body.aws_session_token || ''),
    aws_region: region,
    account_id: String(body.account_id || ''),
  };
  const serialized = ['staging', 'stage', 'production', 'prod'].includes(environmentId.toLowerCase());
  const run = async () => {
    await insertDeployment({
      id: deploymentId,
      userId: auth.user.id,
      organizationId: ownership.project.organization_id,
      projectId,
      environmentId,
      digest,
      image,
      instanceId,
      accountId: creds.account_id,
      region,
      sourceCommit: String(body.source_commit || ''),
      publicEndpoint: String(body.public_endpoint || ''),
      dryRun,
    });
    const remote = await startOnAgentic(contract, creds, dryRun);
    await syncDeployment(deploymentId, remote);
    await recordEvent(deploymentId, projectId, 'DEPLOYMENT_CREATED', String(remote.status || 'CREATED'));
    return remote;
  };
  try {
    const remote = serialized
      ? await withNamedLock(`deploy-exec:${projectId}:${environmentId}`, 20, run)
      : await run();
    return NextResponse.json({
      deployment_id: deploymentId,
      ...remote,
      result: remote.result || remote.result_class || 'PENDING',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Deployment execution failed';
    if (message.includes('Could not acquire lock')) {
      return NextResponse.json({
        error: 'Another deployment is already modifying this environment.',
        code: 'ENVIRONMENT_LOCKED',
        result: 'FAILED',
      }, { status: 409 });
    }
    const status = Number((error as { status?: number }).status || 400);
    const detail = (error as { detail?: unknown }).detail;
    return NextResponse.json({
      error: message,
      detail,
      result: 'FAILED',
    }, { status });
  }
}
