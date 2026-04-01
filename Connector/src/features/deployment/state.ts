'use client';

export interface ProjectRecord {
  id: string;
  name: string;
  owner?: string;
  repo?: string;
  type: 'local' | 'github';
  source?: string;
  branch?: string;
  installationId?: string;
  access?: string;
  lastSyncedAt?: string | null;
  createdAt?: string;
  canDelete?: boolean;
}

export interface RepositoryContextJson {
  document_kind: 'repository_context';
  workspace: string;
  project_name: string;
  summary?: string;
  language?: Record<string, unknown>;
  frameworks?: Array<Record<string, unknown>>;
  data_stores?: Array<Record<string, unknown>>;
  processes?: Array<Record<string, unknown>>;
  build?: Record<string, unknown>;
  frontend?: Record<string, unknown>;
  environment_variables?: Record<string, unknown>;
  health?: Record<string, unknown>;
  monitoring?: Record<string, unknown>;
  infrastructure_hints?: Record<string, unknown>;
  readme_notes?: string | null;
  conflicts?: Array<{ field?: string; reason?: string }>;
  low_confidence_items?: Array<{ field?: string; reason?: string }>;
}

export interface ArchitectureQuestionOption {
  value: string;
  label: string;
  description?: string | null;
}

export interface ArchitectureQuestion {
  id: string;
  category: string;
  question: string;
  required: boolean;
  default?: string | null;
  options?: ArchitectureQuestionOption[];
}

export interface ArchitectureReviewPayload {
  context_json: RepositoryContextJson;
  questions: ArchitectureQuestion[];
  defaults: Record<string, string>;
  conflicts: Array<{ field?: string; reason?: string }>;
  low_confidence_items: Array<{ field?: string; reason?: string }>;
}

export interface DeployApiResult {
  success?: boolean;
  deployment_verified?: boolean;
  verification_checks?: Array<{
    label?: string;
    url?: string;
    ok?: boolean;
    status?: number | null;
    detail?: string;
  }>;
  cloudfront_url?: string | null;
  outputs?: Record<string, unknown>;
  raw_outputs?: Record<string, unknown>;
  details?: Record<string, unknown> | null;
  sensitive_output_arns?: Record<string, string> | null;
  ec2_key_name?: string | null;
  generated_ec2_private_key_pem?: string | null;
  keypair?: {
    key_name?: string | null;
    private_key_pem?: string | null;
  } | null;
  ec2?: {
    instance_id?: string | null;
    state?: string | null;
    type?: string | null;
    public_ip?: string | null;
    private_ip?: string | null;
    public_dns?: string | null;
    private_dns?: string | null;
    instance_arn?: string | null;
  } | null;
  network?: {
    vpc_id?: string | null;
    subnet_id?: string | null;
  } | null;
  cdn?: {
    cloudfront_url?: string | null;
  } | null;
  error?: string;
}

export interface GeneratedIacFile {
  path: string;
  content: string;
}

export interface DeploymentHistoryEntry {
  id: string;
  createdAt: string;
  status: 'done' | 'error';
  region: string;
  cloudfrontUrl: string;
  instanceId: string;
  deployResult: DeployApiResult | null;
}

export interface DeployStateSnapshot {
  status: 'idle' | 'running' | 'done' | 'error';
  progress: number;
  logs: Array<{ text: string; ts: string; type: 'info' | 'success' | 'error' }>;
  deployResult: DeployApiResult | null;
  deploymentHistory: DeploymentHistoryEntry[];
  updatedAt: string;
}

export interface SavedIacRun {
  run_id: string;
  workspace: string;
  provider_version?: string;
  state_bucket?: string;
  lock_table?: string;
}

export interface AwsSessionConfig {
  aws_access_key_id: string;
  aws_secret_access_key: string;
  aws_region: string;
}

export interface DeploymentInstanceSummary {
  cloudfrontUrl: string;
  albDns: string;
  rdsEndpoint: string;
  keyName: string;
  generatedPem: string | null;
  instanceId: string;
  instanceArn: string;
  instanceState: string;
  instanceType: string;
  publicIp: string;
  privateIp: string;
  publicDns: string;
  privateDns: string;
  vpcId: string;
  subnetId: string;
}

export interface ProjectDeploymentRecord {
  projectId: string;
  projectName: string;
  snapshot: DeployStateSnapshot;
  latest: DeploymentHistoryEntry | null;
  summary: DeploymentInstanceSummary;
}

export const SELECTED_PROJECT_STORAGE_KEY = 'deplai.pipeline.selectedProjectId';
export const CURRENT_STAGE_STORAGE_PREFIX = 'deplai.pipeline.currentStage.';
export const PLANNING_PROJECT_KEY = 'deplai.pipeline.planningProjectId';
export const REPO_CONTEXT_KEY = 'deplai.pipeline.repoContext';
export const REPO_CONTEXT_MD_KEY = 'deplai.pipeline.repoContextMd';
export const REVIEW_PAYLOAD_KEY = 'deplai.pipeline.reviewPayload';
export const REVIEW_ANSWERS_KEY = 'deplai.pipeline.reviewAnswers';
export const DEPLOYMENT_PROFILE_KEY = 'deplai.pipeline.deploymentProfile';
export const ARCHITECTURE_VIEW_KEY = 'deplai.pipeline.architectureJson';
export const APPROVAL_PAYLOAD_KEY = 'deplai.pipeline.approvalPayload';
export const COST_ESTIMATE_KEY = 'deplai.pipeline.costEstimate';
export const IAC_FILES_KEY = 'deplai.pipeline.iacFiles';
export const IAC_RUN_KEY = 'deplai.pipeline.iacRun';
export const QA_CONTEXT_KEY = 'deplai.pipeline.qaContext';
export const DEPLOY_STATE_STORAGE_PREFIX = 'deplai.pipeline.deployState.';
export const DEPLOY_UI_STAGE_STORAGE_PREFIX = 'deplai.deploy.stage.';
export const DEPLOY_HISTORY_MAX = 20;

export function readStoredJson<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeStoredJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(key, JSON.stringify(value));
}

export function clearPlanningState(): void {
  if (typeof window === 'undefined') return;
  [
    REPO_CONTEXT_KEY,
    REPO_CONTEXT_MD_KEY,
    REVIEW_PAYLOAD_KEY,
    REVIEW_ANSWERS_KEY,
    DEPLOYMENT_PROFILE_KEY,
    ARCHITECTURE_VIEW_KEY,
    APPROVAL_PAYLOAD_KEY,
    COST_ESTIMATE_KEY,
    IAC_FILES_KEY,
    IAC_RUN_KEY,
    QA_CONTEXT_KEY,
  ].forEach((key) => sessionStorage.removeItem(key));
}

export function readSavedAws(): AwsSessionConfig {
  if (typeof window === 'undefined') {
    return { aws_access_key_id: '', aws_secret_access_key: '', aws_region: 'eu-north-1' };
  }
  try {
    const raw = sessionStorage.getItem('pipeline.aws');
    if (!raw) return { aws_access_key_id: '', aws_secret_access_key: '', aws_region: 'eu-north-1' };
    const parsed = JSON.parse(raw) as Partial<AwsSessionConfig>;
    return {
      aws_access_key_id: String(parsed.aws_access_key_id || ''),
      aws_secret_access_key: String(parsed.aws_secret_access_key || ''),
      aws_region: String(parsed.aws_region || 'eu-north-1'),
    };
  } catch {
    return { aws_access_key_id: '', aws_secret_access_key: '', aws_region: 'eu-north-1' };
  }
}

export function writeSavedAws(config: AwsSessionConfig): void {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem('pipeline.aws', JSON.stringify(config));
}

export function readSavedIacRun(): SavedIacRun | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(IAC_RUN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedIacRun>;
    const runId = String(parsed.run_id || '').trim();
    const workspace = String(parsed.workspace || '').trim();
    if (!runId || !workspace) return null;
    return {
      run_id: runId,
      workspace,
      provider_version: String(parsed.provider_version || '').trim() || undefined,
      state_bucket: String(parsed.state_bucket || '').trim() || undefined,
      lock_table: String(parsed.lock_table || '').trim() || undefined,
    };
  } catch {
    return null;
  }
}

export function readIacFilesFromSession(): GeneratedIacFile[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = sessionStorage.getItem(IAC_FILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<{ path?: string; content?: string }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((file) => typeof file.path === 'string' && typeof file.content === 'string')
      .map((file) => ({ path: String(file.path), content: String(file.content) }));
  } catch {
    return [];
  }
}

export function persistDeploySnapshot(projectId: string, snapshot: DeployStateSnapshot): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(`${DEPLOY_STATE_STORAGE_PREFIX}${projectId}`, JSON.stringify(snapshot));
}

export function loadDeploySnapshot(projectId: string): DeployStateSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(`${DEPLOY_STATE_STORAGE_PREFIX}${projectId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeployStateSnapshot>;
    if (!parsed) return null;
    return {
      status: parsed.status === 'running' || parsed.status === 'done' || parsed.status === 'error' ? parsed.status : 'idle',
      progress: Number.isFinite(parsed.progress) ? Number(parsed.progress) : 0,
      logs: Array.isArray(parsed.logs)
        ? parsed.logs.filter((row) => row && typeof row.text === 'string' && typeof row.ts === 'string')
        : [],
      deployResult: parsed.deployResult && typeof parsed.deployResult === 'object' ? parsed.deployResult as DeployApiResult : null,
      deploymentHistory: Array.isArray(parsed.deploymentHistory)
        ? parsed.deploymentHistory
          .filter((row) => row && typeof row.id === 'string' && typeof row.createdAt === 'string')
          .map((row): DeploymentHistoryEntry => ({
            id: String(row.id),
            createdAt: String(row.createdAt),
            status: row.status === 'error' ? 'error' : 'done',
            region: String(row.region || 'eu-north-1'),
            cloudfrontUrl: String(row.cloudfrontUrl || 'n/a'),
            instanceId: String(row.instanceId || 'n/a'),
            deployResult: row.deployResult && typeof row.deployResult === 'object' ? row.deployResult as DeployApiResult : null,
          }))
          .slice(0, DEPLOY_HISTORY_MAX)
        : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveDeployUiStage(projectId: string, stage: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(`${DEPLOY_UI_STAGE_STORAGE_PREFIX}${projectId}`, stage);
}

export function loadDeployUiStage(projectId: string): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(`${DEPLOY_UI_STAGE_STORAGE_PREFIX}${projectId}`);
}

export function pickOutput(outputs: Record<string, unknown> | undefined, candidates: string[]): string {
  if (!outputs) return 'n/a';

  for (const key of candidates) {
    const direct = outputs[key];
    if (typeof direct === 'string' && direct.trim()) return direct;
    if (direct && typeof direct === 'object' && 'value' in (direct as Record<string, unknown>)) {
      const value = (direct as Record<string, unknown>).value;
      if (typeof value === 'string' && value.trim()) return value;
    }
  }

  const lowered = Object.keys(outputs).reduce<Record<string, unknown>>((acc, key) => {
    acc[key.toLowerCase()] = outputs[key];
    return acc;
  }, {});

  for (const key of candidates.map((candidate) => candidate.toLowerCase())) {
    const match = lowered[key];
    if (typeof match === 'string' && match.trim()) return match;
    if (match && typeof match === 'object' && 'value' in (match as Record<string, unknown>)) {
      const value = (match as Record<string, unknown>).value;
      if (typeof value === 'string' && value.trim()) return value;
    }
  }

  const fuzzyKey = Object.keys(outputs).find((key) => candidates.some((candidate) => key.toLowerCase().includes(candidate.toLowerCase())));
  if (fuzzyKey) {
    const match = outputs[fuzzyKey];
    if (typeof match === 'string' && match.trim()) return match;
    if (match && typeof match === 'object' && 'value' in (match as Record<string, unknown>)) {
      const value = (match as Record<string, unknown>).value;
      if (typeof value === 'string' && value.trim()) return value;
    }
  }

  return 'n/a';
}

export function pickOutputRaw(outputs: Record<string, unknown> | undefined, candidates: string[]): string | null {
  if (!outputs) return null;
  for (const key of candidates) {
    const direct = outputs[key];
    if (typeof direct === 'string' && direct.trim()) return direct;
    if (direct && typeof direct === 'object' && 'value' in (direct as Record<string, unknown>)) {
      const value = (direct as Record<string, unknown>).value;
      if (typeof value === 'string' && value.trim()) return value;
    }
  }
  const fuzzyKey = Object.keys(outputs).find((key) => candidates.some((candidate) => key.toLowerCase().includes(candidate.toLowerCase())));
  if (!fuzzyKey) return null;
  const match = outputs[fuzzyKey];
  if (typeof match === 'string' && match.trim()) return match;
  if (match && typeof match === 'object' && 'value' in (match as Record<string, unknown>)) {
    const value = (match as Record<string, unknown>).value;
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

export function pickNestedOutputRaw(source: Record<string, unknown> | undefined, candidates: string[]): string | null {
  if (!source) return null;
  const direct = pickOutputRaw(source, candidates);
  if (direct) return direct;
  for (const value of Object.values(source)) {
    if (!value || typeof value !== 'object') continue;
    const nested = pickOutputRaw(value as Record<string, unknown>, candidates);
    if (nested) return nested;
  }
  return null;
}

export function toHistoryEntry(
  result: DeployApiResult | null,
  status: 'done' | 'error',
  region: string,
): DeploymentHistoryEntry {
  const outputs = result?.outputs;
  const details = result?.details;
  const live = details && typeof details === 'object'
    ? (details as { live_runtime_details?: { instance?: { instance_id?: string } } }).live_runtime_details
    : null;
  const instanceId = String(
    live?.instance?.instance_id
    || pickOutput(outputs, ['ec2_instance_id', 'instance_id'])
    || 'n/a',
  );
  const cloudfrontUrl = String(result?.cdn?.cloudfront_url || result?.cloudfront_url || pickOutput(outputs, ['cloudfront_url', 'cloudfront_domain_name']) || 'n/a');

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    status,
    region: region || 'eu-north-1',
    cloudfrontUrl,
    instanceId,
    deployResult: result,
  };
}

export function extractDeploymentSummary(result: DeployApiResult | null): DeploymentInstanceSummary {
  const runtimeOutputs = result?.raw_outputs || result?.outputs;
  const details = result?.details as Record<string, unknown> | null | undefined;
  const liveRuntimeDetails = details?.live_runtime_details as { instance?: Record<string, unknown> } | undefined;
  const instance = liveRuntimeDetails?.instance as Record<string, unknown> | undefined;

  return {
    cloudfrontUrl: String(result?.cdn?.cloudfront_url || result?.cloudfront_url || pickOutput(runtimeOutputs, ['cloudfront_url', 'cloudfront_domain_name'])),
    albDns: pickOutput(runtimeOutputs, ['alb_dns_name', 'load_balancer_dns_name']),
    rdsEndpoint: pickOutput(runtimeOutputs, ['rds_endpoint', 'database_endpoint', 'db_endpoint']),
    keyName: String(
      result?.keypair?.key_name
      || result?.ec2_key_name
      || pickOutputRaw(runtimeOutputs, ['ec2_key_name', 'generated_ec2_key_name', 'key_name'])
      || pickNestedOutputRaw(details || undefined, ['ec2_key_name', 'generated_ec2_key_name', 'key_name'])
      || 'deplai-ec2-key',
    ),
    generatedPem: result?.keypair?.private_key_pem
      || result?.generated_ec2_private_key_pem
      || pickOutputRaw(runtimeOutputs, ['generated_ec2_private_key_pem', 'generated_private_key_pem', 'ec2_private_key_pem'])
      || pickNestedOutputRaw(details || undefined, ['generated_ec2_private_key_pem', 'generated_private_key_pem', 'ec2_private_key_pem', 'private_key_pem']),
    instanceId: String(instance?.instance_id || result?.ec2?.instance_id || pickOutput(runtimeOutputs, ['ec2_instance_id', 'instance_id'])),
    instanceArn: String(instance?.instance_arn || result?.ec2?.instance_arn || pickOutput(runtimeOutputs, ['ec2_instance_arn', 'instance_arn'])),
    instanceState: String(instance?.instance_state || result?.ec2?.state || pickOutput(runtimeOutputs, ['ec2_instance_state', 'instance_state'])),
    instanceType: String(instance?.instance_type || result?.ec2?.type || pickOutput(runtimeOutputs, ['ec2_instance_type', 'instance_type'])),
    publicIp: String(instance?.public_ipv4_address || result?.ec2?.public_ip || pickOutput(runtimeOutputs, ['ec2_public_ip', 'public_ip', 'instance_public_ip'])),
    privateIp: String(instance?.private_ipv4_address || result?.ec2?.private_ip || pickOutput(runtimeOutputs, ['ec2_private_ip', 'private_ip', 'instance_private_ip'])),
    publicDns: String(instance?.public_dns || result?.ec2?.public_dns || pickOutput(runtimeOutputs, ['ec2_public_dns', 'instance_public_dns', 'public_dns'])),
    privateDns: String(instance?.private_dns || result?.ec2?.private_dns || pickOutput(runtimeOutputs, ['ec2_private_dns', 'private_dns', 'instance_private_dns'])),
    vpcId: String(instance?.vpc_id || result?.network?.vpc_id || pickOutput(runtimeOutputs, ['ec2_vpc_id', 'vpc_id'])),
    subnetId: String(instance?.subnet_id || result?.network?.subnet_id || pickOutput(runtimeOutputs, ['ec2_subnet_id', 'subnet_id'])),
  };
}

export function listProjectDeploymentRecords(projects: ProjectRecord[]): ProjectDeploymentRecord[] {
  const records: ProjectDeploymentRecord[] = [];
  for (const project of projects) {
    const snapshot = loadDeploySnapshot(project.id);
    if (!snapshot) continue;
    const latest = snapshot.deploymentHistory[0] || null;
    records.push({
      projectId: project.id,
      projectName: project.name,
      snapshot,
      latest,
      summary: extractDeploymentSummary(latest?.deployResult || snapshot.deployResult),
    });
  }
  return records.sort((a, b) => Date.parse(b.snapshot.updatedAt) - Date.parse(a.snapshot.updatedAt));
}

export function downloadTextFile(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
