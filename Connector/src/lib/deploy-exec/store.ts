import { randomUUID } from 'node:crypto';
import { query } from '@/lib/db';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { ensureDeployExecSchema } from './schema';

export type DeployExecRow = {
  id: string;
  project_id: string;
  user_id: string;
  environment_id: string;
  status: string;
  result_class: string;
  stage: string | null;
  artifact_digest: string;
  artifact_image: string;
  instance_id: string;
  account_id: string | null;
  region: string;
  source_commit: string | null;
  public_endpoint: string | null;
  error_code: string | null;
  error_message: string | null;
  dry_run: number;
  retry_count: number;
  created_at: string | Date;
};

type AwsCreds = {
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
  aws_region?: string;
  account_id?: string;
};

async function agentic<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${AGENTIC_URL}${path}`, {
    ...init,
    headers: agenticHeaders({ 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> | undefined) }),
    signal: init?.signal || AbortSignal.timeout(30_000),
  });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = (payload as { detail?: unknown }).detail;
      const fromDetail = typeof detail === 'string'
        ? detail
        : detail && typeof detail === 'object' && 'user_message' in detail
          ? String((detail as { user_message?: string }).user_message || '')
          : '';
      const error = new Error(fromDetail || (payload as { error?: string }).error || 'Deployment execution failed') as Error & {
        status: number;
        detail: unknown;
      };
    error.status = response.status;
    error.detail = detail;
    throw error;
  }
  return payload as T;
}

export async function listDeployments(userId: string, projectId: string): Promise<DeployExecRow[]> {
  await ensureDeployExecSchema();
  return query<DeployExecRow[]>(
    `SELECT * FROM deploy_exec_deployments WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 50`,
    [userId, projectId],
  );
}

export async function getDeployment(userId: string, id: string): Promise<DeployExecRow | null> {
  await ensureDeployExecSchema();
  const rows = await query<DeployExecRow[]>(
    `SELECT * FROM deploy_exec_deployments WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, userId],
  );
  return rows[0] || null;
}

export async function insertDeployment(input: {
  id: string;
  userId: string;
  projectId: string;
  environmentId: string;
  digest: string;
  image: string;
  instanceId: string;
  accountId?: string;
  region: string;
  sourceCommit?: string;
  publicEndpoint?: string;
  dryRun?: boolean;
}): Promise<void> {
  await ensureDeployExecSchema();
  await query(
    `INSERT INTO deploy_exec_deployments (
      id, project_id, user_id, environment_id, status, result_class, artifact_digest, artifact_image,
      instance_id, account_id, region, source_commit, public_endpoint, dry_run, started_at
    ) VALUES (?, ?, ?, ?, 'CREATED', 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [
      input.id,
      input.projectId,
      input.userId,
      input.environmentId,
      input.digest,
      input.image,
      input.instanceId,
      input.accountId || null,
      input.region,
      input.sourceCommit || null,
      input.publicEndpoint || null,
      input.dryRun ? 1 : 0,
    ],
  );
}

export async function syncDeployment(id: string, remote: Record<string, unknown>) {
  await ensureDeployExecSchema();
  const error = (remote.error && typeof remote.error === 'object') ? remote.error as Record<string, unknown> : {};
  const status = String(remote.status || 'CREATED');
  const terminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'ROLLED_BACK'].includes(status);
  await query(
    `UPDATE deploy_exec_deployments
     SET status = ?, result_class = ?, stage = ?, error_code = ?, error_message = ?,
         public_endpoint = COALESCE(?, public_endpoint), updated_at = UTC_TIMESTAMP(),
         finished_at = CASE WHEN ? = 1 THEN UTC_TIMESTAMP() ELSE finished_at END
     WHERE id = ?`,
    [
      status,
      String(remote.result || remote.result_class || 'PENDING'),
      String(remote.stage || '') || null,
      error.code ? String(error.code) : null,
      error.user_message ? String(error.user_message).slice(0, 512) : null,
      remote.public_endpoint ? String(remote.public_endpoint) : null,
      terminal ? 1 : 0,
      id,
    ],
  );
}

export async function recordEvent(deploymentId: string, projectId: string, eventName: string, status?: string, payload?: unknown) {
  await ensureDeployExecSchema();
  await query(
    `INSERT INTO deploy_exec_events (id, deployment_id, project_id, event_name, status, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [randomUUID(), deploymentId, projectId, eventName, status || null, payload ? JSON.stringify(payload) : null],
  );
}

export function credentialsPayload(body: AwsCreds) {
  return {
    aws_access_key_id: String(body.aws_access_key_id || '').trim(),
    aws_secret_access_key: String(body.aws_secret_access_key || '').trim(),
    aws_session_token: String(body.aws_session_token || '').trim(),
    aws_region: String(body.aws_region || '').trim(),
    account_id: String(body.account_id || '').trim(),
  };
}

export async function startOnAgentic(contract: Record<string, unknown>, creds: AwsCreds, dryRun: boolean) {
  return agentic<Record<string, unknown>>('/api/deploy-exec', {
    method: 'POST',
    body: JSON.stringify({
      contract,
      dry_run: dryRun,
      background: !dryRun,
      credentials: credentialsPayload(creds),
    }),
  });
}

export async function fetchAgentic(id: string) {
  return agentic<Record<string, unknown>>(`/api/deploy-exec/${encodeURIComponent(id)}`);
}

export async function fetchAgenticEvents(id: string) {
  return agentic<{ events?: unknown[] }>(`/api/deploy-exec/${encodeURIComponent(id)}/events`);
}

export async function fetchAgenticLogs(id: string) {
  return agentic<{ logs?: unknown[] }>(`/api/deploy-exec/${encodeURIComponent(id)}/logs`);
}

export async function postAgentic(id: string, action: 'cancel' | 'retry' | 'rollback' | 'resume', creds: AwsCreds) {
  return agentic<Record<string, unknown>>(`/api/deploy-exec/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    body: JSON.stringify({ credentials: credentialsPayload(creds) }),
  });
}

export async function postPreflight(contract: Record<string, unknown>, creds: AwsCreds) {
  return agentic<Record<string, unknown>>('/api/deploy-exec/preflight', {
    method: 'POST',
    body: JSON.stringify({ contract, credentials: credentialsPayload(creds) }),
  });
}

export async function fetchArtifactDefaults(image: string, creds: AwsCreds) {
  return agentic<{ image?: string; digest?: string; note?: string }>('/api/deploy-exec/artifact-defaults', {
    method: 'POST',
    body: JSON.stringify({ image, credentials: credentialsPayload(creds) }),
  });
}

export function buildContract(input: {
  deploymentId: string;
  projectId: string;
  environmentId: string;
  requestedBy: string;
  instanceId: string;
  region: string;
  accountId: string;
  image: string;
  digest: string;
  repository?: string;
  containerName?: string;
  containerPort?: number;
  hostPort?: number;
  healthEndpoint?: string;
  publicEndpoint?: string;
  sourceCommit?: string;
  previousImage?: string;
  previousDigest?: string;
  secretReferences?: Array<{ name: string; arn: string }>;
}): Record<string, unknown> {
  const repository = String(input.repository || input.image.split('/').pop() || 'app').replace(/:.+$/, '');
  const previous = input.previousDigest
    ? {
        artifact_id: 'previous',
        repository,
        image: input.previousImage || input.image,
        digest: input.previousDigest,
        status: 'PROMOTED',
      }
    : undefined;
  return {
    metadata: {
      project_id: input.projectId,
      deployment_id: input.deploymentId,
      environment_id: input.environmentId,
      requested_by: input.requestedBy,
      source_commit: input.sourceCommit || '',
    },
    artifact: {
      artifact_id: 'current',
      repository,
      image: input.image,
      digest: input.digest,
      status: 'PROMOTED',
    },
    target: {
      provider: 'aws',
      account_id: input.accountId,
      region: input.region,
      environment: input.environmentId,
      target_id: input.instanceId,
      instance_id: input.instanceId,
    },
    application: {
      name: repository,
      container_name: input.containerName || repository.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64) || 'app',
    },
    network: {
      container_port: input.containerPort || 3000,
      host_port: input.hostPort || 80,
      health_endpoint: input.healthEndpoint || '/health',
      public_endpoint: input.publicEndpoint || '',
    },
    secret_references: input.secretReferences || [],
    rollback: {
      enabled: Boolean(previous),
      previous_artifact: previous,
    },
  };
}
