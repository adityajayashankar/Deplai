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

export interface InfraConsultantMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Ec2ResourceConfig {
  instance_type: string;
  root_volume_size_gb: number;
  app_port: number;
  ssh_ingress_cidr_blocks: string[];
}

export interface RdsResourceConfig {
  engine: 'postgres' | 'mysql' | 'mariadb' | 'aurora-mysql' | 'aurora-postgresql' | 'oracle-ee' | 'sqlserver-ex' | 'db2-ae';
  engine_version: string;
  instance_class: string;
  allocated_storage: number;
  multi_az: boolean;
  backup_retention_period: number;
  /** For Aurora engines: 'serverless' | 'provisioned'. */
  aurora_mode?: 'serverless' | 'provisioned';
  /** DB instance size tier (non-Aurora): 'production' | 'dev_test' | 'free_tier' */
  instance_size_tier?: 'production' | 'dev_test' | 'free_tier';
  /** DB cluster/instance identifier */
  db_identifier?: string;
  /** Master username */
  master_username?: string;
  /** Credentials mode: managed by Secrets Manager or self-managed */
  credentials_mode?: 'secrets_manager' | 'self_managed';
  /** Auto-generate password (only applies when credentials_mode = 'self_managed') */
  auto_generate_password?: boolean;
  /** Master password (only used when self_managed and not auto_generate) */
  master_password?: string;
  /** Aurora Serverless v2 min ACU (0 = scales to zero after inactivity) */
  aurora_min_acu?: number;
  /** Aurora Serverless v2 max ACU */
  aurora_max_acu?: number;
  /** Aurora Serverless: seconds before pausing after inactivity (300–86400) */
  aurora_pause_after_inactivity?: number;
  /** Storage type for non-Aurora (e.g. gp3, gp2, io1) */
  storage_type?: 'gp3' | 'gp2' | 'io1' | 'standard';
  /** Storage autoscaling (non-Aurora) */
  storage_autoscaling?: boolean;
  /** Maximum allocated storage for autoscaling */
  max_allocated_storage?: number;
  /** Publicly accessible DB instance */
  publicly_accessible?: boolean;
  /** Aurora cluster storage config: standard vs io-optimized */
  aurora_cluster_storage_type?: 'standard' | 'io_optimized';
  /** Number of Aurora reader replicas */
  aurora_replica_count?: number;
  /** Deletion protection */
  deletion_protection?: boolean;
}




export interface RedisResourceConfig {
  node_type: string;
  engine_version: string;
}

export interface EcsResourceConfig {
  cpu: number;
  memory: number;
  desired_count: number;
}

export interface StaticSiteResourceConfig {
  price_class: 'PriceClass_100' | 'PriceClass_200' | 'PriceClass_All';
  spa_fallback: boolean;
}

export interface InfraConsultantDecision {
  components: string[];
  deploy_sequence: string[];
  stack_config: Record<string, unknown>;
  outputs_to_capture: string[];
  consultant_notes?: string[];
  need_alb?: boolean;
  need_eip?: boolean;
  region?: string;
  provider?: string;
  open_questions?: string[];
  intakes?: Record<string, unknown>;
}

export interface InfraConsultantState {
  workspace: string;
  history: InfraConsultantMessage[];
  repo_detection_summary: string;
  turn_count: number;
  decision: InfraConsultantDecision | null;
  summary: string;
  confirmed: boolean;
  /** True when the consultant finished intake and the decision is ready to approve. */
  ready?: boolean;
  budget_cap_usd?: number;
  selected_tier?: 'baseline' | 'recommended' | 'resilient';
  upgrade_suggestions?: Array<{
    extra_monthly_usd?: number;
    title?: string;
    plain_benefit?: string;
    unlocks?: string[];
    tier?: string;
  }>;
  budget_gate?: {
    cap_usd?: number;
    total_usd?: number;
    percent_used?: number;
    status?: string;
    gap_usd?: number;
  };
  advisor_cost_estimate?: {
    subtotal_monthly_usd?: number;
    currency?: string;
    line_items?: unknown[];
  };
  requirements?: Record<string, string>;
}

export interface DeployApiResult {
  success?: boolean;
  mode?: string;
  run_id?: string;
  workspace?: string;
  service_type?: string;
  status?: string;
  workspace_session_id?: string;
  requires_plan_confirmation?: boolean;
  plan_summary?: Record<string, unknown> | null;
  deployment_summary?: Record<string, unknown> | null;
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
  one_time_credentials?: {
    private_key_pem?: string | null;
    key_name?: string | null;
    instance_id?: string | null;
    key_file_name?: string | null;
    database_env?: string | null;
    database_file_name?: string | null;
    download_once?: boolean;
    credentials_downloaded?: boolean;
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
    alb_dns_name?: string | null;
    alb_url?: string | null;
    elastic_ip?: string | null;
    eip_public_ip?: string | null;
  } | null;
  app_url?: string | null;
  alb_url?: string | null;
  alb_dns_name?: string | null;
  elastic_ip?: string | null;
  customization_source?: SavedIacMeta['source_metadata'];
  cdn?: {
    cloudfront_url?: string | null;
    app_url?: string | null;
  } | null;
  error?: string;
}

export interface GeneratedIacFile {
  path: string;
  content: string;
}

export interface DeployLogEntry {
  text: string;
  ts: string;
  type: 'info' | 'success' | 'error';
  worker_id?: string;
  worker_role?: string;
  worker_status?: string;
  stage?: string;
  model?: string;
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
  logs: DeployLogEntry[];
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

export interface SavedIacMeta {
  project_id: string;
  workspace?: string;
  runtime_workspace?: string;
  source?: string;
  generated_at?: string;
  has_run?: boolean;
  requested_renderer?: string;
  actual_renderer?: string;
  execution_kind?: string;
  component_catalog_version?: string;
  unsupported_reason?: string;
  deployment_package_id?: string;
  decision_applied?: boolean;
  source_metadata?: {
    kind?: string;
    project_id?: string;
    tenant_id?: string;
    snapshot_id?: string;
    snapshot_path?: string;
    agentic_source_root?: string;
    source_tree_hash?: string;
    created_at?: string | null;
    status?: string;
  } | null;
  decision_drift?: Array<{
    component: string;
    key: string;
    expected: unknown;
    got: unknown;
  }>;
}

export interface AwsSessionConfig {
  aws_access_key_id: string;
  aws_secret_access_key: string;
  aws_session_token: string;
  aws_region: string;
}

/** How long secret key + session token may remain in sessionStorage. */
export const AWS_OPERATOR_CRED_TTL_MS_ASIA = 60 * 60 * 1000; // 1 hour (STS-style)
export const AWS_OPERATOR_CRED_TTL_MS_AKIA = 2 * 60 * 60 * 1000; // 2 hours
const AWS_OPERATOR_STORAGE_KEY = 'pipeline.aws';
const AWS_OPERATOR_LEGACY_LOCAL_KEYS = [
  'pipeline.aws',
  'deplai.pipeline.aws',
  'deplai.aws',
  'deplai.pipeline.awsConfig',
];

type StoredAwsSession = {
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
  aws_region?: string;
  saved_at?: number;
  expires_at?: number;
};

function emptyAwsSession(region = DEFAULT_AWS_REGION): AwsSessionConfig {
  return {
    aws_access_key_id: '',
    aws_secret_access_key: '',
    aws_session_token: '',
    aws_region: region,
  };
}

function awsOperatorCredTtlMs(accessKeyId: string): number {
  return accessKeyId.trim().toUpperCase().startsWith('ASIA')
    ? AWS_OPERATOR_CRED_TTL_MS_ASIA
    : AWS_OPERATOR_CRED_TTL_MS_AKIA;
}

/** Remove leftover localStorage copies of operator AWS credentials. */
export function wipeLegacyAwsLocalStorage(): void {
  if (typeof window === 'undefined') return;
  for (const key of AWS_OPERATOR_LEGACY_LOCAL_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
}

export function clearSavedAws(): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(AWS_OPERATOR_STORAGE_KEY);
  } catch {
    // ignore
  }
  wipeLegacyAwsLocalStorage();
}

export function readSavedAws(): AwsSessionConfig {
  if (typeof window === 'undefined') {
    return emptyAwsSession();
  }
  wipeLegacyAwsLocalStorage();
  try {
    const raw = sessionStorage.getItem(AWS_OPERATOR_STORAGE_KEY);
    if (!raw) return emptyAwsSession();
    const parsed = JSON.parse(raw) as StoredAwsSession;
    const accessKeyId = String(parsed.aws_access_key_id || '');
    const region = String(parsed.aws_region || DEFAULT_AWS_REGION) || DEFAULT_AWS_REGION;
    const savedAt = Number(parsed.saved_at || 0);
    const expiresAt = Number(parsed.expires_at || 0);
    const now = Date.now();
    const expired = Boolean(expiresAt && now > expiresAt)
      || (Boolean(savedAt) && now - savedAt > awsOperatorCredTtlMs(accessKeyId));

    if (expired) {
      // Drop secret material; keep region for UX.
      clearSavedAws();
      return emptyAwsSession(region);
    }

    return {
      aws_access_key_id: accessKeyId,
      aws_secret_access_key: String(parsed.aws_secret_access_key || ''),
      aws_session_token: String(parsed.aws_session_token || ''),
      aws_region: region,
    };
  } catch {
    return emptyAwsSession();
  }
}

export function writeSavedAws(config: AwsSessionConfig): void {
  if (typeof window === 'undefined') return;
  wipeLegacyAwsLocalStorage();
  const accessKeyId = String(config.aws_access_key_id || '').trim();
  const secret = String(config.aws_secret_access_key || '');
  const token = String(config.aws_session_token || '');
  const region = String(config.aws_region || DEFAULT_AWS_REGION).trim() || DEFAULT_AWS_REGION;

  if (!accessKeyId && !secret && !token) {
    clearSavedAws();
    return;
  }

  const now = Date.now();
  const payload: StoredAwsSession = {
    aws_access_key_id: accessKeyId,
    aws_region: region,
    saved_at: now,
    expires_at: now + awsOperatorCredTtlMs(accessKeyId),
    // Secret material is session-scoped and TTL-bound — never localStorage.
    aws_secret_access_key: secret,
    aws_session_token: token,
  };
  const serialized = JSON.stringify(payload);
  try {
    sessionStorage.setItem(AWS_OPERATOR_STORAGE_KEY, serialized);
  } catch (err) {
    const quota = err instanceof DOMException
      && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    if (!quota) return;
    try {
      const compact = compactIacFilesForSession(readIacFilesFromSession());
      sessionStorage.setItem(IAC_FILES_KEY, JSON.stringify(compact));
      sessionStorage.setItem(AWS_OPERATOR_STORAGE_KEY, serialized);
    } catch {
      // Keep credentials in React state even if sessionStorage is full.
    }
  }
}

/** Milliseconds until stored operator credentials expire; 0 if missing/expired. */
export function awsOperatorCredRemainingMs(config?: AwsSessionConfig | null): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = sessionStorage.getItem(AWS_OPERATOR_STORAGE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as StoredAwsSession;
    const expiresAt = Number(parsed.expires_at || 0);
    if (!expiresAt) {
      const accessKeyId = String(config?.aws_access_key_id || parsed.aws_access_key_id || '');
      const savedAt = Number(parsed.saved_at || 0);
      if (!savedAt) return 0;
      return Math.max(0, savedAt + awsOperatorCredTtlMs(accessKeyId) - Date.now());
    }
    return Math.max(0, expiresAt - Date.now());
  } catch {
    return 0;
  }
}

export type PersistedAppSecretMeta = {
  key: string;
  is_set: boolean;
  required?: boolean;
};

/** Persist App Secrets key metadata only — never secret values. */
export function readAppSecretsMeta(projectId: string): PersistedAppSecretMeta[] {
  if (typeof window === 'undefined') return [];
  const id = String(projectId || '').trim();
  if (!id) return [];
  try {
    const raw = sessionStorage.getItem(`${APP_SECRETS_META_STORAGE_PREFIX}${id}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item): PersistedAppSecretMeta | null => {
        const row = item as PersistedAppSecretMeta;
        const key = String(row?.key || '').trim();
        if (!key) return null;
        return {
          key,
          is_set: Boolean(row.is_set),
          required: Boolean(row.required),
        };
      })
      .filter((row): row is PersistedAppSecretMeta => row !== null);
  } catch {
    return [];
  }
}

export function writeAppSecretsMeta(projectId: string, meta: PersistedAppSecretMeta[]): void {
  if (typeof window === 'undefined') return;
  const id = String(projectId || '').trim();
  if (!id) return;
  const safe = (Array.isArray(meta) ? meta : [])
    .map((row) => ({
      key: String(row.key || '').trim(),
      is_set: Boolean(row.is_set),
      required: Boolean(row.required),
    }))
    .filter((row) => row.key);
  sessionStorage.setItem(`${APP_SECRETS_META_STORAGE_PREFIX}${id}`, JSON.stringify(safe));
}

export interface TerraformRuntimeConfig {
  aws_region: string;
  state_bucket: string;
  lock_table: string;
}

export interface DeploymentInstanceSummary {
  cloudfrontUrl: string;
  albDns: string;
  elasticIp: string;
  rdsEndpoint: string;
  rdsPort: string;
  rdsDatabaseName: string;
  redisEndpoint: string;
  redisPort: string;
  ecsCluster: string;
  ecrRepositoryUrl: string;
  logGroup: string;
  healthCheckUrl: string;
  keyName: string;
  keyFileName: string;
  generatedPem: string | null;
  databaseEnv: string | null;
  databaseFileName: string;
  instanceId: string;
  instanceArn: string;
  instanceState: string;
  instanceType: string;
  publicIp: string;
  appUrl: string;
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
export const INFRA_CONSULTANT_KEY = 'deplai.pipeline.infraConsultant';
export const IAC_FILES_KEY = 'deplai.pipeline.iacFiles';
export const IAC_RUN_KEY = 'deplai.pipeline.iacRun';
export const IAC_META_KEY = 'deplai.pipeline.iacMeta';
export const QA_CONTEXT_KEY = 'deplai.pipeline.qaContext';
export const DEPLOY_STATE_STORAGE_PREFIX = 'deplai.pipeline.deployState.';
export const DEPLOY_UI_STAGE_STORAGE_PREFIX = 'deplai.deploy.stage.';
export const TERRAFORM_RUNTIME_STORAGE_PREFIX = 'deplai.pipeline.terraformRuntime.';
export const DEPLOY_HISTORY_MAX = 20;
export const DEFAULT_AWS_REGION = 'eu-north-1';
export const APP_SECRETS_META_STORAGE_PREFIX = 'deplai.pipeline.appSecretsMeta.';
const IAC_SESSION_MAX_TOTAL_CHARS = 400000;
const IAC_SESSION_MAX_FILE_CHARS = 80000;
const IAC_TRUNCATION_NOTE = '\n\n# [truncated in browser session cache]';
const OBSOLETE_IAC_UI_STORAGE_KEYS = [
  'deplai.pipeline.iacMode',
  'deplai.pipeline.iacLlmProvider',
  'deplai.pipeline.iacLlmModel',
  'deplai.pipeline.iacLlmApiKey',
  'deplai.pipeline.iacLlmBaseUrl',
];

export function hasTruncatedIacFiles(value: unknown): boolean {
  return normalizeIacFileList(value).some((entry) => String(entry.content || '').includes(IAC_TRUNCATION_NOTE));
}

function hasRequiredTerraformRootFiles(files: GeneratedIacFile[]): boolean {
  const required = new Set([
    'terraform/providers.tf',
    'terraform/backend.tf',
    'terraform/main.tf',
    'terraform/variables.tf',
    'terraform/terraform.tfvars',
    'terraform/outputs.tf',
  ]);

  for (const file of files) {
    required.delete(String(file.path || '').trim());
    if (required.size === 0) return true;
  }
  return required.size === 0;
}

export function getDeployableIacFiles(value: unknown): GeneratedIacFile[] {
  const normalized = normalizeIacFileList(value);
  if (!normalized.length) return [];
  if (hasTruncatedIacFiles(normalized)) return [];
  if (!hasRequiredTerraformRootFiles(normalized)) return [];
  return normalized;
}

function normalizeIacFileList(value: unknown): GeneratedIacFile[] {
  if (!Array.isArray(value)) return [];
  const byPath = new Map<string, GeneratedIacFile>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as { path?: unknown; content?: unknown };
    const path = String(row.path || '').trim();
    const content = String(row.content || '');
    if (!path) continue;

    // Drop bulk mirrored static asset payloads from UI/session cache.
    if (path.startsWith('terraform/site/') && path !== 'terraform/site/index.html') continue;

    byPath.set(path, { path, content });
  }

  return Array.from(byPath.values());
}

function compactIacFilesForSession(value: unknown): GeneratedIacFile[] {
  const normalized = normalizeIacFileList(value);
  if (!normalized.length) return [];

  const compact: GeneratedIacFile[] = [];
  let usedChars = 0;

  for (const entry of normalized) {
    const path = entry.path;
    const source = entry.content;
    const remaining = IAC_SESSION_MAX_TOTAL_CHARS - usedChars;
    if (remaining <= 0) break;

    const perFileBudget = Math.min(IAC_SESSION_MAX_FILE_CHARS, Math.max(0, remaining - path.length - 64));
    if (perFileBudget <= 0) break;

    let content = source;
    if (content.length > perFileBudget) {
      const safeLen = Math.max(0, perFileBudget - IAC_TRUNCATION_NOTE.length);
      content = `${content.slice(0, safeLen)}${IAC_TRUNCATION_NOTE}`;
    }

    compact.push({ path, content });
    usedChars += path.length + content.length;
  }

  return compact;
}

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
  const serialized = JSON.stringify(key === IAC_FILES_KEY ? normalizeIacFileList(value) : value);
  try {
    sessionStorage.setItem(key, serialized);
    return;
  } catch {
    if (key !== IAC_FILES_KEY) return;
  }

  try {
    const compact = compactIacFilesForSession(value);
    sessionStorage.setItem(key, JSON.stringify(compact));
  } catch {
    // Ignore quota failures; the in-memory state still keeps the generated files.
  }
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
    INFRA_CONSULTANT_KEY,
    IAC_FILES_KEY,
    IAC_RUN_KEY,
    IAC_META_KEY,
    QA_CONTEXT_KEY,
  ].forEach((key) => sessionStorage.removeItem(key));
}

function normalizeTerraformRuntimeConfig(
  value: Partial<TerraformRuntimeConfig> | null | undefined,
  fallbackRegion = DEFAULT_AWS_REGION,
): TerraformRuntimeConfig {
  return {
    aws_region: String(value?.aws_region || fallbackRegion).trim() || fallbackRegion,
    state_bucket: String(value?.state_bucket || '').trim(),
    lock_table: String(value?.lock_table || '').trim(),
  };
}

export function readSavedTerraformRuntimeConfig(projectId: string): TerraformRuntimeConfig | null {
  if (typeof window === 'undefined') return null;
  const normalizedProjectId = String(projectId || '').trim();
  if (!normalizedProjectId) return null;
  try {
    const raw = sessionStorage.getItem(`${TERRAFORM_RUNTIME_STORAGE_PREFIX}${normalizedProjectId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TerraformRuntimeConfig>;
    return normalizeTerraformRuntimeConfig(parsed);
  } catch {
    return null;
  }
}

export function resolveTerraformRuntimeConfig(
  projectId: string,
  options?: {
    aws?: Partial<AwsSessionConfig> | null;
    savedRun?: SavedIacRun | null;
  },
): TerraformRuntimeConfig {
  const existing = readSavedTerraformRuntimeConfig(projectId);
  if (existing) return existing;
  return normalizeTerraformRuntimeConfig({
    aws_region: String(options?.aws?.aws_region || DEFAULT_AWS_REGION).trim() || DEFAULT_AWS_REGION,
    state_bucket: String(options?.savedRun?.state_bucket || '').trim(),
    lock_table: String(options?.savedRun?.lock_table || '').trim(),
  });
}

export function writeSavedTerraformRuntimeConfig(projectId: string, config: TerraformRuntimeConfig): void {
  if (typeof window === 'undefined') return;
  const normalizedProjectId = String(projectId || '').trim();
  if (!normalizedProjectId) return;
  sessionStorage.setItem(
    `${TERRAFORM_RUNTIME_STORAGE_PREFIX}${normalizedProjectId}`,
    JSON.stringify(normalizeTerraformRuntimeConfig(config)),
  );
}

export function clearObsoleteTerraformUiState(): void {
  if (typeof window === 'undefined') return;
  for (const key of OBSOLETE_IAC_UI_STORAGE_KEYS) {
    localStorage.removeItem(key);
  }
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

export function readSavedIacMeta(): SavedIacMeta | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(IAC_META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedIacMeta>;
    const projectId = String(parsed.project_id || '').trim();
    if (!projectId) return null;
    return {
      project_id: projectId,
      workspace: String(parsed.workspace || '').trim() || undefined,
      runtime_workspace: String(parsed.runtime_workspace || '').trim() || undefined,
      source: String(parsed.source || '').trim() || undefined,
      generated_at: String(parsed.generated_at || '').trim() || undefined,
      has_run: parsed.has_run === true,
      requested_renderer: String(parsed.requested_renderer || '').trim() || undefined,
      actual_renderer: String(parsed.actual_renderer || '').trim() || undefined,
      execution_kind: String(parsed.execution_kind || '').trim() || undefined,
      component_catalog_version: String(parsed.component_catalog_version || '').trim() || undefined,
      unsupported_reason: String(parsed.unsupported_reason || '').trim() || undefined,
      deployment_package_id: String(parsed.deployment_package_id || '').trim() || undefined,
      decision_applied: typeof parsed.decision_applied === 'boolean' ? parsed.decision_applied : undefined,
      source_metadata: parsed.source_metadata && typeof parsed.source_metadata === 'object'
        ? {
            kind: String(parsed.source_metadata.kind || '').trim() || undefined,
            project_id: String(parsed.source_metadata.project_id || '').trim() || undefined,
            tenant_id: String(parsed.source_metadata.tenant_id || '').trim() || undefined,
            snapshot_id: String(parsed.source_metadata.snapshot_id || '').trim() || undefined,
            snapshot_path: String(parsed.source_metadata.snapshot_path || '').trim() || undefined,
            agentic_source_root: String(parsed.source_metadata.agentic_source_root || '').trim() || undefined,
            source_tree_hash: String(parsed.source_metadata.source_tree_hash || '').trim() || undefined,
            created_at: parsed.source_metadata.created_at
              ? String(parsed.source_metadata.created_at)
              : null,
            status: String(parsed.source_metadata.status || '').trim() || undefined,
          }
        : null,
      decision_drift: Array.isArray(parsed.decision_drift)
        ? parsed.decision_drift
          .filter((item) => item && typeof item === 'object')
          .map((item) => {
            const row = item as Record<string, unknown>;
            return {
              component: String(row.component || '').trim(),
              key: String(row.key || '').trim(),
              expected: row.expected,
              got: row.got,
            };
          })
          .filter((item) => item.component.length > 0 && item.key.length > 0)
        : undefined,
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
    return normalizeIacFileList(parsed);
  } catch {
    return [];
  }
}

const DEPLOY_LOG_MAX = 80;
const DEPLOY_LOG_TEXT_MAX = 2000;
const DEPLOY_SNAPSHOT_MAX_CHARS = 400000;
const EC2_PEM_SESSION_PREFIX = 'deplai.pipeline.ec2Pem.';
const DEPLOY_DB_ENV_SESSION_PREFIX = 'deplai.pipeline.dbEnv.';
const DEPLOY_SECRETS_DOWNLOADED_PREFIX = 'deplai.pipeline.secretsDownloaded.';

function isQuotaExceededError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = String((err as { name?: string }).name || '');
  const message = String((err as { message?: string }).message || '');
  return name === 'QuotaExceededError'
    || name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || /exceeded the quota/i.test(message)
    || /quota/i.test(message);
}

function capDeployLogs(logs: DeployLogEntry[], maxEntries: number): DeployLogEntry[] {
  return logs.slice(-Math.max(1, maxEntries)).map((row) => {
    const text = String(row?.text || '');
    return {
      ...row,
      text: text.length > DEPLOY_LOG_TEXT_MAX
        ? `${text.slice(0, DEPLOY_LOG_TEXT_MAX)}\n…[truncated]`
        : text,
    };
  });
}

function omitHeavyDeployDetails(details: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!details || typeof details !== 'object') return details ?? null;
  const slim: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const lowered = key.toLowerCase();
    if (
      lowered.endsWith('_log_tail')
      || lowered.endsWith('_log')
      || lowered.includes('private_key')
      || lowered.includes('_pem')
      || lowered === 'files'
      || lowered === 'generated_files'
      || lowered === 'stdout_tail'
      || lowered === 'stderr_tail'
      || lowered === 'retry_errors'
    ) {
      continue;
    }
    slim[key] = value;
  }
  return slim;
}

function omitSensitiveOutputBag(outputs: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!outputs || typeof outputs !== 'object') return outputs;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(outputs)) {
    if (/private_key|pem|password|secret/i.test(key)) continue;
    next[key] = value;
  }
  return next;
}

function slimDeployResultForStorage(
  result: DeployApiResult | null,
  options: { keepDetails: boolean },
): DeployApiResult | null {
  if (!result) return null;
  const next: DeployApiResult = { ...result };
  next.generated_ec2_private_key_pem = null;
  if (next.keypair) {
    next.keypair = {
      key_name: next.keypair.key_name ?? null,
      private_key_pem: null,
    };
  }
  if (next.one_time_credentials) {
    next.one_time_credentials = {
      ...next.one_time_credentials,
      private_key_pem: null,
      database_env: null,
    };
  }
  next.outputs = omitSensitiveOutputBag(next.outputs);
  next.raw_outputs = undefined;
  if (!options.keepDetails) {
    next.details = null;
    next.plan_summary = null;
  } else if (next.details && typeof next.details === 'object') {
    next.details = omitHeavyDeployDetails(next.details);
  }
  return next;
}

export function buildPersistableDeploySnapshot(
  snapshot: DeployStateSnapshot,
  level: 0 | 1 | 2 = 0,
): DeployStateSnapshot {
  const logMax = level === 0 ? DEPLOY_LOG_MAX : level === 1 ? 30 : 8;
  const historyMax = level === 0 ? 8 : level === 1 ? 3 : 1;
  const keepDetails = level === 0;
  const keepHistoryResults = level < 2;
  return {
    status: snapshot.status,
    progress: snapshot.progress,
    logs: capDeployLogs(Array.isArray(snapshot.logs) ? snapshot.logs : [], logMax),
    deployResult: slimDeployResultForStorage(snapshot.deployResult, { keepDetails }),
    deploymentHistory: (Array.isArray(snapshot.deploymentHistory) ? snapshot.deploymentHistory : [])
      .slice(0, historyMax)
      .map((entry) => ({
        ...entry,
        deployResult: keepHistoryResults
          ? slimDeployResultForStorage(entry.deployResult, { keepDetails: false })
          : null,
      })),
    updatedAt: snapshot.updatedAt,
  };
}

function stashDeployPem(projectId: string, snapshot: DeployStateSnapshot): void {
  if (wereDeploySecretsDownloaded(projectId)) return;
  const pem = String(
    snapshot.deployResult?.one_time_credentials?.private_key_pem
    || snapshot.deployResult?.generated_ec2_private_key_pem
    || snapshot.deployResult?.keypair?.private_key_pem
    || '',
  ).trim();
  const databaseEnv = String(snapshot.deployResult?.one_time_credentials?.database_env || '').trim();
  try {
    if (pem && pem.includes('BEGIN')) {
      sessionStorage.setItem(`${EC2_PEM_SESSION_PREFIX}${projectId}`, pem);
    }
    if (databaseEnv) {
      sessionStorage.setItem(`${DEPLOY_DB_ENV_SESSION_PREFIX}${projectId}`, databaseEnv);
    }
  } catch {
    // Session quota is separate; in-memory UI still has the key.
  }
}

function readStashedDeployPem(projectId: string): string | null {
  if (wereDeploySecretsDownloaded(projectId)) return null;
  try {
    const pem = sessionStorage.getItem(`${EC2_PEM_SESSION_PREFIX}${projectId}`);
    return pem && pem.includes('BEGIN') ? pem : null;
  } catch {
    return null;
  }
}

function readStashedDatabaseEnv(projectId: string): string | null {
  if (wereDeploySecretsDownloaded(projectId)) return null;
  try {
    const value = sessionStorage.getItem(`${DEPLOY_DB_ENV_SESSION_PREFIX}${projectId}`);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export function wereDeploySecretsDownloaded(projectId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return sessionStorage.getItem(`${DEPLOY_SECRETS_DOWNLOADED_PREFIX}${projectId}`) === '1';
  } catch {
    return false;
  }
}

function rehydrateDeployResultPem(projectId: string, result: DeployApiResult | null): DeployApiResult | null {
  if (!result) return null;
  if (wereDeploySecretsDownloaded(projectId)) {
    return {
      ...result,
      generated_ec2_private_key_pem: null,
      keypair: result.keypair ? { ...result.keypair, private_key_pem: null } : result.keypair,
      one_time_credentials: result.one_time_credentials
        ? { ...result.one_time_credentials, private_key_pem: null, database_env: null, credentials_downloaded: true }
        : result.one_time_credentials,
    };
  }
  const pem = result.generated_ec2_private_key_pem
    || result.keypair?.private_key_pem
    || result.one_time_credentials?.private_key_pem
    || readStashedDeployPem(projectId);
  const databaseEnv = result.one_time_credentials?.database_env || readStashedDatabaseEnv(projectId);
  if (!pem && !databaseEnv) return result;
  return {
    ...result,
    generated_ec2_private_key_pem: pem || null,
    keypair: {
      key_name: result.keypair?.key_name ?? result.ec2_key_name ?? result.one_time_credentials?.key_name ?? null,
      private_key_pem: pem || null,
    },
    one_time_credentials: {
      ...(result.one_time_credentials || {}),
      private_key_pem: pem || result.one_time_credentials?.private_key_pem || null,
      database_env: databaseEnv || null,
      download_once: true,
    },
  };
}

export function clearDownloadedDeploySecrets(projectId: string, result: DeployApiResult | null): DeployApiResult | null {
  try {
    sessionStorage.setItem(`${DEPLOY_SECRETS_DOWNLOADED_PREFIX}${projectId}`, '1');
    sessionStorage.removeItem(`${EC2_PEM_SESSION_PREFIX}${projectId}`);
    sessionStorage.removeItem(`${DEPLOY_DB_ENV_SESSION_PREFIX}${projectId}`);
  } catch {
    // ignore
  }
  if (!result) return null;
  return {
    ...result,
    generated_ec2_private_key_pem: null,
    keypair: result.keypair ? { ...result.keypair, private_key_pem: null } : null,
    one_time_credentials: result.one_time_credentials
      ? {
        ...result.one_time_credentials,
        private_key_pem: null,
        database_env: null,
        credentials_downloaded: true,
      }
      : { download_once: true, credentials_downloaded: true },
  };
}

function evictOtherDeploySnapshots(keepProjectId: string): void {
  const keepKey = `${DEPLOY_STATE_STORAGE_PREFIX}${keepProjectId}`;
  const remove: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key && key.startsWith(DEPLOY_STATE_STORAGE_PREFIX) && key !== keepKey) {
      remove.push(key);
    }
  }
  for (const key of remove) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
}

export function persistDeploySnapshot(projectId: string, snapshot: DeployStateSnapshot): void {
  if (typeof window === 'undefined') return;
  try {
    const storageKey = `${DEPLOY_STATE_STORAGE_PREFIX}${projectId}`;
    stashDeployPem(projectId, snapshot);

    const candidates: DeployStateSnapshot[] = [
      buildPersistableDeploySnapshot(snapshot, 0),
      buildPersistableDeploySnapshot(snapshot, 1),
      buildPersistableDeploySnapshot(snapshot, 2),
    ];

    const write = (payload: DeployStateSnapshot): boolean => {
      let serialized = '';
      try {
        serialized = JSON.stringify(payload);
      } catch {
        return false;
      }
      if (serialized.length > DEPLOY_SNAPSHOT_MAX_CHARS && payload !== candidates[candidates.length - 1]) {
        return false;
      }
      try {
        localStorage.setItem(storageKey, serialized);
        return true;
      } catch (err) {
        if (!isQuotaExceededError(err)) return true;
        return false;
      }
    };

    for (const candidate of candidates) {
      if (write(candidate)) return;
    }

    evictOtherDeploySnapshots(projectId);
    try {
      localStorage.setItem(storageKey, JSON.stringify(candidates[candidates.length - 1]));
    } catch {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // ignore
      }
    }
  } catch {
    // Persistence must never take down the deploy console.
  }
}

export function removeDeploySnapshot(projectId: string): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(`${DEPLOY_STATE_STORAGE_PREFIX}${projectId}`);
  try {
    sessionStorage.removeItem(`${EC2_PEM_SESSION_PREFIX}${projectId}`);
    sessionStorage.removeItem(`${DEPLOY_DB_ENV_SESSION_PREFIX}${projectId}`);
    sessionStorage.removeItem(`${DEPLOY_SECRETS_DOWNLOADED_PREFIX}${projectId}`);
  } catch {
    // ignore
  }
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
        ? parsed.logs
          .filter((row) => row && typeof row.text === 'string' && typeof row.ts === 'string')
          .map((row): DeployLogEntry => ({
            text: String(row.text),
            ts: String(row.ts),
            type: row.type === 'success' || row.type === 'error' ? row.type : 'info',
            worker_id: typeof row.worker_id === 'string' ? row.worker_id : undefined,
            worker_role: typeof row.worker_role === 'string' ? row.worker_role : undefined,
            worker_status: typeof row.worker_status === 'string' ? row.worker_status : undefined,
            stage: typeof row.stage === 'string' ? row.stage : undefined,
            model: typeof row.model === 'string' ? row.model : undefined,
          }))
        : [],
      deployResult: rehydrateDeployResultPem(
        projectId,
        parsed.deployResult && typeof parsed.deployResult === 'object' ? parsed.deployResult as DeployApiResult : null,
      ),
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

export function projectHasSuccessfulDeploy(projectId: string): boolean {
  const snapshot = loadDeploySnapshot(projectId);
  if (!snapshot) return false;
  if (isLiveManagedDeployment(snapshot)) return true;
  return snapshot.deploymentHistory.some((entry) => entry.status === 'done' && entry.deployResult?.success !== false);
}

/** True when Terraform plan finished and the UI must wait for Confirm plan & deploy. */
export function isAwaitingPlanConfirmation(args: {
  uiPhase?: string | null;
  requiresPlanConfirmation?: boolean;
  result?: Pick<DeployApiResult, 'requires_plan_confirmation' | 'status'> | null;
}): boolean {
  if (args.requiresPlanConfirmation) return true;
  if (String(args.uiPhase || '').trim().toLowerCase() === 'awaiting_plan') return true;
  if (args.result?.requires_plan_confirmation) return true;
  return String(args.result?.status || '').trim().toLowerCase() === 'awaiting_plan_confirmation';
}

/** True when an apply has already failed and Redeploy should be available. */
export function isFailedDeployAttempt(args: {
  status?: string | null;
  uiPhase?: string | null;
  result?: Pick<DeployApiResult, 'success' | 'error'> | null;
}): boolean {
  if (args.status === 'error' || args.uiPhase === 'error') return true;
  if (args.result?.success === false) return true;
  if (args.result?.success === true) return false;
  return Boolean(String(args.result?.error || '').trim());
}

/** True while Terraform apply is actually in flight — not while waiting for plan confirmation. */
export function isLiveDeployAttempt(args: {
  status?: string | null;
  uiPhase?: string | null;
  failed?: boolean;
  requiresPlanConfirmation?: boolean;
  result?: Pick<DeployApiResult, 'requires_plan_confirmation' | 'status'> | null;
}): boolean {
  if (args.failed) return false;
  const phase = String(args.uiPhase || '').trim().toLowerCase();
  // Confirm click leaves awaiting_plan immediately; keep the button in the live
  // state even if the previous result still carries plan-gate flags.
  if (phase === 'starting' || phase === 'waiting_api' || phase === 'reconciling') return true;
  if (isAwaitingPlanConfirmation(args)) return false;
  return args.status === 'running';
}

/** True after a successful apply that has not been destroyed (status reset to idle). */
export function isLiveManagedDeployment(snapshot: DeployStateSnapshot | null | undefined): boolean {
  if (!snapshot || snapshot.status !== 'done') return false;
  const result = snapshot.deployResult;
  if (!result || typeof result !== 'object') return false;
  if (result.success === false) return false;
  return true;
}

export function isApplyingDeployment(snapshot: DeployStateSnapshot | null | undefined): boolean {
  if (snapshot?.status !== 'running') return false;
  if (isAwaitingPlanConfirmation({ result: snapshot.deployResult })) return false;
  return true;
}

export function isRealAwsInstanceId(value: string | null | undefined): boolean {
  const text = String(value || '').trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  if (['n/a', 'na', 'null', 'undefined', 'none', '-', '—'].includes(lower)) return false;
  if (text.startsWith('project-')) return false;
  return /^i-[a-z0-9]+$/i.test(text);
}

export function listManagedDeploymentRecords(projects: ProjectRecord[]): ProjectDeploymentRecord[] {
  return listProjectDeploymentRecords(projects).filter((record) => isLiveManagedDeployment(record.snapshot));
}

export function listApplyingDeploymentRecords(projects: ProjectRecord[]): ProjectDeploymentRecord[] {
  return listProjectDeploymentRecords(projects).filter((record) => isApplyingDeployment(record.snapshot));
}

export function iacRunIdFromResult(result: DeployApiResult | null | undefined): string | null {
  const runId = String(result?.run_id || '').trim();
  return runId || null;
}

export function isIacPipelineResult(result: DeployApiResult | null | undefined): boolean {
  return String(result?.mode || '').trim() === 'iac_pipeline';
}

export function saveDeployUiStage(projectId: string, stage: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(`${DEPLOY_UI_STAGE_STORAGE_PREFIX}${projectId}`, stage);
}

export function loadDeployUiStage(projectId: string): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(`${DEPLOY_UI_STAGE_STORAGE_PREFIX}${projectId}`);
}

function scalarOutputValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => scalarOutputValue(item))
      .filter((item): item is string => Boolean(item))
      .join(', ');
    return joined || null;
  }
  return null;
}

/** Flatten IaC pipeline `{ outputs: [{ key, value }] }` bags into a lookup map. */
export function flattenDeployOutputs(outputs: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!outputs) return undefined;
  const nested = outputs.outputs;
  if (!Array.isArray(nested)) return outputs;
  const flat: Record<string, unknown> = { ...outputs };
  for (const entry of nested) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const key = String(record.key || '').trim();
    if (!key) continue;
    flat[key] = record.value;
  }
  return flat;
}

export function pickOutput(outputs: Record<string, unknown> | undefined, candidates: string[]): string {
  if (!outputs) return 'n/a';

  for (const key of candidates) {
    const direct = outputs[key];
    const scalar = scalarOutputValue(direct);
    if (scalar) return scalar;
    if (direct && typeof direct === 'object' && 'value' in (direct as Record<string, unknown>)) {
      const value = scalarOutputValue((direct as Record<string, unknown>).value);
      if (value) return value;
    }
  }

  const lowered = Object.keys(outputs).reduce<Record<string, unknown>>((acc, key) => {
    acc[key.toLowerCase()] = outputs[key];
    return acc;
  }, {});

  for (const key of candidates.map((candidate) => candidate.toLowerCase())) {
    const match = lowered[key];
    const scalar = scalarOutputValue(match);
    if (scalar) return scalar;
    if (match && typeof match === 'object' && 'value' in (match as Record<string, unknown>)) {
      const value = scalarOutputValue((match as Record<string, unknown>).value);
      if (value) return value;
    }
  }

  const fuzzyKey = Object.keys(outputs).find((key) => candidates.some((candidate) => key.toLowerCase().includes(candidate.toLowerCase())));
  if (fuzzyKey) {
    const match = outputs[fuzzyKey];
    const scalar = scalarOutputValue(match);
    if (scalar) return scalar;
    if (match && typeof match === 'object' && 'value' in (match as Record<string, unknown>)) {
      const value = scalarOutputValue((match as Record<string, unknown>).value);
      if (value) return value;
    }
  }

  return 'n/a';
}

export function pickOutputRaw(outputs: Record<string, unknown> | undefined, candidates: string[]): string | null {
  if (!outputs) return null;
  for (const key of candidates) {
    const direct = outputs[key];
    const scalar = scalarOutputValue(direct);
    if (scalar) return scalar;
    if (direct && typeof direct === 'object' && 'value' in (direct as Record<string, unknown>)) {
      const value = scalarOutputValue((direct as Record<string, unknown>).value);
      if (value) return value;
    }
  }
  const fuzzyKey = Object.keys(outputs).find((key) => candidates.some((candidate) => key.toLowerCase().includes(candidate.toLowerCase())));
  if (!fuzzyKey) return null;
  const match = outputs[fuzzyKey];
  const scalar = scalarOutputValue(match);
  if (scalar) return scalar;
  if (match && typeof match === 'object' && 'value' in (match as Record<string, unknown>)) {
    return scalarOutputValue((match as Record<string, unknown>).value);
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
  const runtimeOutputs = flattenDeployOutputs(result?.raw_outputs || result?.outputs);
  const details = result?.details as Record<string, unknown> | null | undefined;
  const liveRuntimeDetails = details?.live_runtime_details as { instance?: Record<string, unknown> } | undefined;
  const instance = liveRuntimeDetails?.instance as Record<string, unknown> | undefined;
  const network = result?.network;
  const publicIp = String(instance?.public_ipv4_address || result?.ec2?.public_ip || pickOutput(runtimeOutputs, ['ec2_public_ip', 'public_ip', 'instance_public_ip']));
  const albDns = String(
    result?.alb_dns_name
    || network?.alb_dns_name
    || pickOutputRaw(runtimeOutputs, ['alb_dns_name', 'load_balancer_dns_name', 'alb_dns'])
    || 'n/a',
  );
  const elasticIp = String(
    result?.elastic_ip
    || network?.elastic_ip
    || network?.eip_public_ip
    || pickOutputRaw(runtimeOutputs, ['elastic_ip', 'eip_public_ip', 'eip_allocation_public_ip'])
    || 'n/a',
  );
  const cloudfrontUrl = String(
    result?.cdn?.cloudfront_url
    || result?.cloudfront_url
    || pickOutput(runtimeOutputs, ['cloudfront_url', 'cloudfront_domain_name']),
  );
  const explicitAppUrl = String(
    result?.app_url
    || result?.cdn?.app_url
    || result?.alb_url
    || network?.alb_url
    || pickOutputRaw(runtimeOutputs, ['app_url', 'application_url', 'site_url', 'alb_url'])
    || '',
  ).trim();
  const appUrl = String(
    explicitAppUrl
    || (cloudfrontUrl !== 'n/a' ? (cloudfrontUrl.startsWith('http') ? cloudfrontUrl : `https://${cloudfrontUrl}`) : '')
    || (albDns !== 'n/a' ? `http://${albDns}` : '')
    || (elasticIp !== 'n/a' ? `http://${elasticIp}` : '')
    || (publicIp !== 'n/a' ? `http://${publicIp}` : 'n/a'),
  );

  return {
    cloudfrontUrl,
    albDns,
    elasticIp,
    rdsEndpoint: String(
      pickOutputRaw(runtimeOutputs, ['rds_endpoint', 'database_endpoint', 'db_endpoint', 'rds_address'])
      || 'n/a',
    ),
    rdsPort: String(pickOutputRaw(runtimeOutputs, ['rds_port', 'database_port', 'db_port']) || 'n/a'),
    rdsDatabaseName: String(pickOutputRaw(runtimeOutputs, ['rds_database_name', 'db_name', 'database_name']) || 'n/a'),
    redisEndpoint: String(
      pickOutputRaw(runtimeOutputs, ['redis_endpoint', 'elasticache_endpoint', 'cache_endpoint'])
      || 'n/a',
    ),
    redisPort: String(pickOutputRaw(runtimeOutputs, ['redis_port', 'cache_port', 'elasticache_port']) || 'n/a'),
    ecsCluster: String(
      pickOutputRaw(runtimeOutputs, ['ecs_cluster_name', 'ecs_cluster'])
      || 'n/a',
    ),
    ecrRepositoryUrl: String(
      pickOutputRaw(runtimeOutputs, ['ecr_repository_url', 'ecr_url'])
      || 'n/a',
    ),
    logGroup: String(
      pickOutputRaw(runtimeOutputs, ['log_group_name', 'cloudwatch_log_group', 'ecs_log_group'])
      || 'n/a',
    ),
    healthCheckUrl: String(
      pickOutputRaw(runtimeOutputs, ['health_check_url', 'health_url'])
      || 'n/a',
    ),
    keyName: String(
      result?.one_time_credentials?.key_name
      || result?.keypair?.key_name
      || result?.ec2_key_name
      || pickOutputRaw(runtimeOutputs, ['ec2_key_name', 'generated_ec2_key_name', 'key_name'])
      || pickNestedOutputRaw(details || undefined, ['ec2_key_name', 'generated_ec2_key_name', 'key_name'])
      || 'deplai-ec2-key',
    ),
    keyFileName: String(
      result?.one_time_credentials?.key_file_name
      || '',
    ),
    generatedPem: result?.one_time_credentials?.private_key_pem
      || result?.keypair?.private_key_pem
      || result?.generated_ec2_private_key_pem
      || pickOutputRaw(runtimeOutputs, ['generated_ec2_private_key_pem', 'generated_private_key_pem', 'ec2_private_key_pem', 'private_key_pem'])
      || pickNestedOutputRaw(details || undefined, ['generated_ec2_private_key_pem', 'generated_private_key_pem', 'ec2_private_key_pem', 'private_key_pem'])
      || null,
    databaseEnv: result?.one_time_credentials?.database_env || null,
    databaseFileName: String(result?.one_time_credentials?.database_file_name || ''),
    instanceId: String(instance?.instance_id || result?.ec2?.instance_id || result?.one_time_credentials?.instance_id || pickOutput(runtimeOutputs, ['ec2_instance_id', 'instance_id'])),
    instanceArn: String(instance?.instance_arn || result?.ec2?.instance_arn || pickOutput(runtimeOutputs, ['ec2_instance_arn', 'instance_arn'])),
    instanceState: String(instance?.instance_state || result?.ec2?.state || pickOutput(runtimeOutputs, ['ec2_instance_state', 'instance_state'])),
    instanceType: String(instance?.instance_type || result?.ec2?.type || pickOutput(runtimeOutputs, ['ec2_instance_type', 'instance_type'])),
    publicIp,
    appUrl,
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
