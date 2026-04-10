'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, CheckCircle2, ChevronRight, CircleDashed, Download, ExternalLink, RefreshCw, Rocket, Server, Terminal } from 'lucide-react';
import { buildDeploymentWorkspace } from '@/lib/deployment-planning-contract';
import {
  APPROVAL_PAYLOAD_KEY,
  ARCHITECTURE_VIEW_KEY,
  COST_ESTIMATE_KEY,
  CURRENT_STAGE_STORAGE_PREFIX,
  DEPLOYMENT_PROFILE_KEY,
  DEPLOY_HISTORY_MAX,
  IAC_FILES_KEY,
  IAC_META_KEY,
  IAC_RUN_KEY,
  PLANNING_PROJECT_KEY,
  QA_CONTEXT_KEY,
  REPO_CONTEXT_MD_KEY,
  REVIEW_ANSWERS_KEY,
  REVIEW_PAYLOAD_KEY,
  SELECTED_PROJECT_STORAGE_KEY,
  clearPlanningState,
  downloadTextFile,
  extractDeploymentSummary,
  getDeployableIacFiles,
  hasTruncatedIacFiles,
  loadDeploySnapshot,
  loadDeployUiStage,
  persistDeploySnapshot,
  readIacFilesFromSession,
  readSavedIacMeta,
  readSavedAws,
  readSavedIacRun,
  readStoredJson,
  saveDeployUiStage,
  toHistoryEntry,
  type ArchitectureReviewPayload,
  type AwsSessionConfig,
  type DeployApiResult,
  type DeployLogEntry,
  type DeployStateSnapshot,
  type GeneratedIacFile,
  type ProjectRecord,
  type RepositoryContextJson,
  writeSavedAws,
  writeStoredJson,
} from './state';

type PipelineStageId = 'analysis' | 'qa' | 'architecture' | 'approval' | 'terraform' | 'aws_config' | 'deploy' | 'outputs';
type IacMode = 'deterministic' | 'llm';
type IacLlmProvider = 'groq' | 'openrouter' | 'ollama' | 'opencode';

type IacPrResponse = {
  attempted?: boolean;
  success?: boolean;
  pr_url?: string | null;
  reason?: string;
  error?: string;
};

const IAC_MODE_STORAGE_KEY = 'deplai.pipeline.iacMode';
const IAC_LLM_PROVIDER_STORAGE_KEY = 'deplai.pipeline.iacLlmProvider';
const IAC_LLM_MODEL_STORAGE_KEY = 'deplai.pipeline.iacLlmModel';
const IAC_LLM_API_KEY_STORAGE_KEY = 'deplai.pipeline.iacLlmApiKey';
const IAC_LLM_BASE_URL_STORAGE_KEY = 'deplai.pipeline.iacLlmBaseUrl';

const IAC_LLM_DEFAULT_MODELS: Record<IacLlmProvider, string> = {
  groq: 'llama-3.1-8b-instant',
  openrouter: 'meta-llama/llama-3.3-70b-instruct:free',
  ollama: 'llama3.1:8b',
  opencode: 'openai/gpt-oss-20b',
};

const SIDEBAR_STAGES: Array<{ id: PipelineStageId; label: string; details: string }> = [
  { id: 'analysis', label: 'Repository Analysis', details: 'Codebase Scan' },
  { id: 'qa', label: 'Questions', details: 'Interactive Q&A' },
  { id: 'architecture', label: 'Architecture', details: 'Diagram + Cost' },
  { id: 'approval', label: 'Approval', details: 'Sign-off' },
  { id: 'terraform', label: 'Terraform', details: 'IaC Generation' },
  { id: 'aws_config', label: 'AWS Config', details: 'GitOps & Secrets' },
  { id: 'deploy', label: 'Deploy', details: 'Execution' },
  { id: 'outputs', label: 'Outputs', details: 'Credentials & URLs' },
];

function timestampLabel(date = new Date()) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function normalizeIacFiles(files: GeneratedIacFile[]): GeneratedIacFile[] {
  const byPath = new Map<string, GeneratedIacFile>();
  for (const file of files) {
    const path = String(file.path || '').trim();
    if (!path) continue;
    if (path.startsWith('terraform/site/') && path !== 'terraform/site/index.html') continue;
    byPath.set(path, { path, content: String(file.content || '') });
  }
  return Array.from(byPath.values());
}

function readCostEstimate() {
  const raw = readStoredJson<{ total_monthly_usd?: number; budget_cap_usd?: number }>(COST_ESTIMATE_KEY);
  return { total: Number(raw?.total_monthly_usd || 0), cap: Number(raw?.budget_cap_usd || 100) };
}

type RuntimeArchNode = {
  id: string;
  label: string;
  type: string;
};

type RuntimeArchEdge = {
  from: string;
  to: string;
  label?: string;
};

type RuntimeCostItem = {
  service: string;
  type: string;
  monthly: number;
  note: string;
};

type ApprovalPayload = {
  diagram?: {
    nodes?: Array<Record<string, unknown>>;
    edges?: Array<Record<string, unknown>>;
    region?: string;
  };
  cost_estimate?: {
    line_items?: unknown;
    total_monthly_usd?: number;
  };
  budget_gate?: {
    cap_usd?: number;
  };
};

type PipelineSocketState = 'idle' | 'connecting' | 'connected' | 'error';

type DeployStatusResponse = {
  success?: boolean;
  status?: string;
  result?: unknown;
  error?: string;
};

type EndpointVerificationCheck = {
  label: string;
  url: string;
  ok: boolean;
  status: number | null;
  detail: string;
};

type OutputBannerState = {
  tone: 'success' | 'warning' | 'error';
  label: string;
  title: string;
  description: string;
};

type AwsRuntimeLiveInstance = {
  instance_id?: string;
  public_ipv4_address?: string;
  private_ipv4_address?: string;
  instance_state?: string;
  instance_type?: string;
  public_dns?: string;
  private_dns?: string;
  vpc_id?: string;
  subnet_id?: string;
  instance_arn?: string;
};

type AwsRuntimeLiveCounts = {
  ec2_instances_total?: number;
  ec2_instances_running?: number;
  vpcs?: number;
  subnets?: number;
  nat_gateways?: number;
  internet_gateways?: number;
  route_tables?: number;
  security_groups?: number;
  key_pairs?: number;
  s3_buckets?: number;
  cloudfront_distributions?: number;
};

type AwsRuntimeLiveDetails = {
  region?: string;
  account_id?: string;
  instance?: AwsRuntimeLiveInstance;
  resource_counts?: AwsRuntimeLiveCounts;
};

type DeployStatus = DeployStateSnapshot['status'];
type DeployLog = DeployStateSnapshot['logs'][number];

type ActiveDeployState = {
  status: DeployStatus;
  progress: number;
  logs: DeployLog[];
  deployResult: DeployApiResult | null;
  deploymentHistory: DeployStateSnapshot['deploymentHistory'];
  updatedAt?: string;
};

type ActiveDeployEntry = {
  state: ActiveDeployState;
  listeners: Set<(state: ActiveDeployState) => void>;
  inFlight: boolean;
};

const activeDeployments = new Map<string, ActiveDeployEntry>();

function toDeployState(snapshot?: Partial<ActiveDeployState>): ActiveDeployState {
  return {
    status: snapshot?.status === 'running' || snapshot?.status === 'done' || snapshot?.status === 'error' ? snapshot.status : 'idle',
    progress: Number.isFinite(snapshot?.progress) ? Number(snapshot?.progress) : 0,
    logs: Array.isArray(snapshot?.logs) ? snapshot.logs : [],
    deployResult: snapshot?.deployResult && typeof snapshot.deployResult === 'object' ? snapshot.deployResult : null,
    deploymentHistory: Array.isArray(snapshot?.deploymentHistory) ? snapshot.deploymentHistory : [],
    updatedAt: typeof snapshot?.updatedAt === 'string' ? snapshot.updatedAt : undefined,
  };
}

function getOrCreateActiveDeployment(projectId: string, seed?: Partial<ActiveDeployState>): ActiveDeployEntry {
  const existing = activeDeployments.get(projectId);
  if (existing) return existing;
  const created: ActiveDeployEntry = {
    state: toDeployState(seed),
    listeners: new Set(),
    inFlight: false,
  };
  activeDeployments.set(projectId, created);
  return created;
}

function emitActiveDeployment(projectId: string): void {
  const entry = activeDeployments.get(projectId);
  if (!entry) return;
  for (const listener of entry.listeners) listener(entry.state);
}

function persistActiveDeploymentState(projectId: string, state: ActiveDeployState): void {
  if (typeof window === 'undefined') return;
  persistDeploySnapshot(projectId, {
    status: state.status,
    progress: state.progress,
    logs: state.logs,
    deployResult: state.deployResult,
    deploymentHistory: state.deploymentHistory,
    updatedAt: new Date().toISOString(),
  });
}

function setActiveDeploymentState(projectId: string, next: ActiveDeployState): void {
  const entry = getOrCreateActiveDeployment(projectId);
  entry.state = toDeployState(next);
  persistActiveDeploymentState(projectId, entry.state);
  emitActiveDeployment(projectId);
}

function patchActiveDeploymentState(
  projectId: string,
  patch: Partial<ActiveDeployState> | ((prev: ActiveDeployState) => ActiveDeployState),
): ActiveDeployState {
  const entry = getOrCreateActiveDeployment(projectId);
  const next = typeof patch === 'function'
    ? patch(entry.state)
    : { ...entry.state, ...patch };
  entry.state = toDeployState({ ...next, updatedAt: new Date().toISOString() });
  persistActiveDeploymentState(projectId, entry.state);
  emitActiveDeployment(projectId);
  return entry.state;
}

function extractLiveRuntimeDetails(result: DeployApiResult | null): AwsRuntimeLiveDetails | null {
  const details = result?.details;
  if (!details || typeof details !== 'object') return null;
  const live = (details as { live_runtime_details?: AwsRuntimeLiveDetails }).live_runtime_details;
  return live && typeof live === 'object' ? live : null;
}

function mergeDeployResultWithRuntimeDetails(
  result: DeployApiResult | null,
  details: AwsRuntimeLiveDetails,
): DeployApiResult {
  return {
    ...((result || {}) as DeployApiResult),
    details: {
      ...(((result?.details as Record<string, unknown> | null | undefined) || {})),
      live_runtime_details: details,
    },
  };
}

function getLiveRuntimeInstanceId(result: DeployApiResult | null): string {
  const liveDetails = extractLiveRuntimeDetails(result);
  return String(liveDetails?.instance?.instance_id || '').trim();
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readStringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBooleanValue(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item) => !!item && typeof item === 'object' && !Array.isArray(item)).map((item) => item as Record<string, unknown>)
    : [];
}

function deriveArchitectureFromDeploymentProfile(profile: Record<string, unknown> | null): { nodes: RuntimeArchNode[]; edges: RuntimeArchEdge[] } {
  const root = asObject(profile);
  if (!root) return { nodes: [], edges: [] };
  const compute = asObject(root.compute);
  const networking = asObject(root.networking);
  const dataLayer = readRecordArray(root.data_layer);
  const services = readRecordArray(compute?.services);
  const strategy = readStringValue(compute?.strategy);
  const hasLoadBalancer = !!networking?.load_balancer && typeof networking.load_balancer === 'object';
  const nodes: RuntimeArchNode[] = [];
  const edges: RuntimeArchEdge[] = [];
  const addNode = (id: string, type: string, label: string) => {
    if (!nodes.some((node) => node.id === id)) nodes.push({ id, type, label });
  };
  const addEdge = (from: string, to: string, label?: string) => {
    if (!edges.some((edge) => edge.from === from && edge.to === to && edge.label === label)) {
      edges.push({ from, to, label });
    }
  };

  if (strategy === 's3_cloudfront') {
    addNode('websiteBucket', 'AmazonS3', 'Website Bucket');
    addNode('cloudFrontDistribution', 'AmazonCloudFront', 'CloudFront Distribution');
    addEdge('cloudFrontDistribution', 'websiteBucket', 'origin');
  } else {
    addNode('applicationVpc', 'AmazonVPC', 'Application VPC');
    if (strategy === 'ec2') {
      addNode('websiteBucket', 'AmazonS3', 'Website Bucket');
      addNode('cloudFrontDistribution', 'AmazonCloudFront', 'CloudFront Distribution');
      addNode('appSecurityGroup', 'AmazonVPC', 'App Security Group');
      addEdge('cloudFrontDistribution', 'websiteBucket', 'origin');
      addEdge('applicationVpc', 'appSecurityGroup', 'security');
    } else if (hasLoadBalancer) {
      const lbConfig = asObject(networking?.load_balancer);
      addNode('applicationAlb', 'ELB', readBooleanValue(lbConfig?.public, true) ? 'Public Application Load Balancer' : 'Application Load Balancer');
      addEdge('applicationAlb', 'applicationVpc', 'ingress');
    }

    if (strategy === 'ecs_fargate') {
      addNode('ecsCluster', 'AmazonECS', 'ECS Cluster');
      services.forEach((service, index) => {
        const baseId = readStringValue(service.id) || `service-${index + 1}`;
        const label = readStringValue(service.id).toUpperCase() || `SERVICE ${index + 1}`;
        const port = Number(service.port || 0);
        const serviceNodeId = `${baseId}Service`;
        addNode(serviceNodeId, 'AmazonECS', label);
        addEdge('ecsCluster', serviceNodeId, 'task');
        if (hasLoadBalancer && port > 0) addEdge('applicationAlb', serviceNodeId, String(port));
      });
    } else {
      services.forEach((service, index) => {
        const baseId = readStringValue(service.id) || `service-${index + 1}`;
        const label = readStringValue(service.id).toUpperCase() || `SERVICE ${index + 1}`;
        const port = Number(service.port || 80) || 80;
        const serviceNodeId = `${baseId}Instance`;
        addNode(serviceNodeId, 'AmazonEC2', label);
        if (strategy === 'ec2') {
          addEdge('applicationVpc', serviceNodeId, 'subnet');
          addEdge('appSecurityGroup', serviceNodeId, String(port));
        } else if (hasLoadBalancer) {
          addEdge('applicationAlb', serviceNodeId, String(port));
        }
      });
    }
  }

  dataLayer.forEach((item) => {
    const itemType = readStringValue(item.type);
    if (itemType === 'postgresql') {
      addNode('primaryDatabase', 'AmazonRDS', 'Primary PostgreSQL');
      services.forEach((service, index) => {
        const baseId = readStringValue(service.id) || `service-${index + 1}`;
        addEdge(strategy === 'ecs_fargate' ? `${baseId}Service` : `${baseId}Instance`, 'primaryDatabase');
      });
    } else if (itemType === 'redis') {
      addNode('cacheCluster', 'AmazonElastiCache', 'Redis Cache');
      services.forEach((service, index) => {
        const baseId = readStringValue(service.id) || `service-${index + 1}`;
        addEdge(strategy === 'ecs_fargate' ? `${baseId}Service` : `${baseId}Instance`, 'cacheCluster');
      });
    }
  });

  return { nodes, edges };
}

function architectureViewLooksStale(view: Record<string, unknown> | null, profile: Record<string, unknown> | null): boolean {
  const root = asObject(profile);
  if (!root || !Array.isArray(view?.nodes)) return false;
  const compute = asObject(root.compute);
  const strategy = readStringValue(compute?.strategy);
  if (strategy !== 'ec2') return false;
  const nodeIds = view.nodes
    .map((node) => (node && typeof node === 'object' ? readStringValue((node as Record<string, unknown>).id) : ''))
    .filter(Boolean);
  const hasAlb = nodeIds.includes('applicationAlb');
  const hasCloudFront = nodeIds.includes('cloudFrontDistribution');
  const hasBucket = nodeIds.includes('websiteBucket');
  return hasAlb && (!hasCloudFront || !hasBucket);
}

function normalizeCostBreakdown(raw: unknown): RuntimeCostItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return {
        service: String(row.service || row.name || 'Service'),
        type: String(row.type || row.category || 'General'),
        monthly: Number(row.monthly_usd || row.monthly_cost_usd || row.monthly || 0),
        note: String(row.note || row.description || ''),
      };
    })
    .filter((item) => item.service.trim().length > 0);
}

function normalizeVerificationChecks(raw: unknown): EndpointVerificationCheck[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const entry = item && typeof item === 'object' ? item as Record<string, unknown> : null;
      if (!entry) return null;
      return {
        label: String(entry.label || 'endpoint'),
        url: String(entry.url || ''),
        ok: Boolean(entry.ok),
        status: typeof entry.status === 'number' ? entry.status : null,
        detail: String(entry.detail || ''),
      } satisfies EndpointVerificationCheck;
    })
    .filter((item): item is EndpointVerificationCheck => item !== null);
}

function pickNodeColor(type: string): string {
  const value = String(type || '').toLowerCase();
  if (value.includes('cloudfront')) return '#06b6d4';
  if (value.includes('ec2') || value.includes('compute')) return '#22c55e';
  if (value.includes('rds') || value.includes('database') || value.includes('postgres')) return '#f59e0b';
  if (value.includes('s3') || value.includes('bucket') || value.includes('storage')) return '#f97316';
  if (value.includes('security')) return '#94a3b8';
  if (value.includes('vpc') || value.includes('subnet') || value.includes('network')) return '#64748b';
  return '#a1a1aa';
}

function labelForAnswer(
  review: ArchitectureReviewPayload | null,
  questionId: string,
  value: string,
): string {
  const question = review?.questions.find((entry) => entry.id === questionId);
  return question?.options?.find((option) => option.value === value)?.label || value;
}

function formatQuestionCategory(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return 'Deployment';
  return raw
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function questionInputPlaceholder(questionId: string, fallback: string | null | undefined): string {
  const value = String(fallback || '').trim();
  if (value) return value;
  if (questionId === 'q_domain') return 'api.example.com';
  return 'Type your answer';
}

function buildQaSummary(
  review: ArchitectureReviewPayload | null,
  answers: Record<string, string>,
  repoContext: RepositoryContextJson | null,
  repoContextMd: string,
): string {
  const blocks: string[] = [];
  const summary = String(repoContext?.summary || '').trim();
  if (summary) {
    blocks.push(`Repository summary:\n${summary}`);
  }
  const runtime = String(repoContext?.language?.runtime || '').trim();
  const frameworks = Array.isArray(repoContext?.frameworks)
    ? repoContext.frameworks.map((item) => String(item.name || '')).filter(Boolean)
    : [];
  const dataStores = Array.isArray(repoContext?.data_stores)
    ? repoContext.data_stores.map((item) => String(item.type || '')).filter(Boolean)
    : [];
  const processes = Array.isArray(repoContext?.processes)
    ? repoContext.processes.map((item) => `${String(item.type || 'process')}: ${String(item.command || item.source || '').trim()}`).filter(Boolean)
    : [];
  const requiredSecrets = Array.isArray(repoContext?.environment_variables?.required_secrets)
    ? (repoContext.environment_variables?.required_secrets as unknown[]).map((item) => String(item || '')).filter(Boolean)
    : [];
  const buildCommand = String(repoContext?.build?.build_command || '').trim();
  const startCommand = String(repoContext?.build?.start_command || '').trim();
  const healthPath = String(repoContext?.health?.endpoint || '').trim();
  const detailLines = [
    runtime ? `Runtime: ${runtime}` : '',
    frameworks.length > 0 ? `Frameworks: ${frameworks.join(', ')}` : '',
    dataStores.length > 0 ? `Data stores: ${dataStores.join(', ')}` : '',
    buildCommand ? `Build command: ${buildCommand}` : '',
    startCommand ? `Start command: ${startCommand}` : '',
    healthPath ? `Health endpoint: ${healthPath}` : '',
    processes.length > 0 ? `Processes: ${processes.join(' | ')}` : '',
    requiredSecrets.length > 0 ? `Required secrets: ${requiredSecrets.join(', ')}` : '',
  ].filter(Boolean);
  if (detailLines.length > 0) {
    blocks.push(`Repository analysis details:\n${detailLines.join('\n')}`);
  }
  const markdown = String(repoContextMd || '').trim();
  if (markdown) {
    blocks.push(`Repository analysis markdown:\n${markdown}`);
  }
  if (review) {
    review.questions.forEach((question) => {
      const answer = String(answers[question.id] || '').trim();
      if (!answer) return;
      blocks.push(`Q: ${question.question}\nA: ${labelForAnswer(review, question.id, answer)}`);
    });
  }
  return blocks.join('\n\n').trim();
}

export default function DeploymentTrackApp() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const logEndRef = useRef<HTMLDivElement>(null);
  const pipelineSocketRef = useRef<WebSocket | null>(null);
  const deployRequestRef = useRef<string | null>(null);
  const idleRecoveryRef = useRef<string | null>(null);
  const analysisRequestRef = useRef<string | null>(null);
  const reviewRequestRef = useRef<string | null>(null);
  const terraformAutostartRef = useRef<string | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeStage, setActiveStage] = useState<PipelineStageId>('analysis');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [repoContext, setRepoContext] = useState<RepositoryContextJson | null>(() => readStoredJson<RepositoryContextJson>('deplai.pipeline.repoContext'));
  const [repoContextMd, setRepoContextMd] = useState<string>(() => readStoredJson<string>(REPO_CONTEXT_MD_KEY) || '');
  const [review, setReview] = useState<ArchitectureReviewPayload | null>(() => readStoredJson<ArchitectureReviewPayload>(REVIEW_PAYLOAD_KEY));
  const [answers, setAnswers] = useState<Record<string, string>>(() => readStoredJson<Record<string, string>>(REVIEW_ANSWERS_KEY) || {});
  const [deploymentProfile, setDeploymentProfile] = useState<Record<string, unknown> | null>(() => readStoredJson<Record<string, unknown>>(DEPLOYMENT_PROFILE_KEY));
  const [architectureView, setArchitectureView] = useState<Record<string, unknown> | null>(() => readStoredJson<Record<string, unknown>>(ARCHITECTURE_VIEW_KEY));
  const [approvalPayload, setApprovalPayload] = useState<ApprovalPayload | null>(() => readStoredJson<ApprovalPayload>(APPROVAL_PAYLOAD_KEY));
  const [approved, setApproved] = useState(false);
  const [iacFiles, setIacFiles] = useState<GeneratedIacFile[]>(() => readIacFilesFromSession());
  const [selectedFile, setSelectedFile] = useState<string>(() => readIacFilesFromSession()[0]?.path || '');
  const [iacPrUrl, setIacPrUrl] = useState<string | null>(null);
  const [iacPrCreating, setIacPrCreating] = useState(false);
  const [terraformGenerating, setTerraformGenerating] = useState(false);
  const [aws, setAws] = useState<AwsSessionConfig>(() => readSavedAws());
  const [iacMode, setIacMode] = useState<IacMode>(() => {
    if (typeof window === 'undefined') return 'deterministic';
    return localStorage.getItem(IAC_MODE_STORAGE_KEY) === 'llm' ? 'llm' : 'deterministic';
  });
  const [llmProvider, setLlmProvider] = useState<IacLlmProvider>(() => {
    if (typeof window === 'undefined') return 'groq';
    const stored = String(localStorage.getItem(IAC_LLM_PROVIDER_STORAGE_KEY) || '').toLowerCase();
    return stored === 'openrouter' || stored === 'ollama' || stored === 'opencode' ? stored : 'groq';
  });
  const [llmModel, setLlmModel] = useState<string>(() => {
    if (typeof window === 'undefined') return IAC_LLM_DEFAULT_MODELS.groq;
    const storedModel = String(localStorage.getItem(IAC_LLM_MODEL_STORAGE_KEY) || '').trim();
    const provider = String(localStorage.getItem(IAC_LLM_PROVIDER_STORAGE_KEY) || 'groq').toLowerCase() as IacLlmProvider;
    return storedModel || IAC_LLM_DEFAULT_MODELS[provider] || IAC_LLM_DEFAULT_MODELS.groq;
  });
  const [llmApiKey, setLlmApiKey] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return String(localStorage.getItem(IAC_LLM_API_KEY_STORAGE_KEY) || '');
  });
  const [llmApiBaseUrl, setLlmApiBaseUrl] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return String(localStorage.getItem(IAC_LLM_BASE_URL_STORAGE_KEY) || '');
  });
  const [deployStatus, setDeployStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [deployProgress, setDeployProgress] = useState(0);
  const [deployLogs, setDeployLogs] = useState<DeployLogEntry[]>([]);
  const [deployResult, setDeployResult] = useState<DeployApiResult | null>(null);
  const [deploymentHistory, setDeploymentHistory] = useState<DeployStateSnapshot['deploymentHistory']>([]);
  const [deploySocketState, setDeploySocketState] = useState<PipelineSocketState>('idle');
  const [stopLoading, setStopLoading] = useState(false);
  const [destroyLoading, setDestroyLoading] = useState(false);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [budgetOverride, setBudgetOverride] = useState(false);
  const [endpointChecks, setEndpointChecks] = useState<EndpointVerificationCheck[]>([]);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProject = useMemo(() => projects.find((project) => project.id === selectedProjectId) || null, [projects, selectedProjectId]);
  const expectedWorkspace = useMemo(() => (
    selectedProject ? buildDeploymentWorkspace(selectedProject.id, selectedProject.name) : ''
  ), [selectedProject]);
  const reviewQuestions = useMemo(() => review?.questions || [], [review]);
  const requiredQuestions = useMemo(
    () => reviewQuestions.filter((question) => question.required !== false),
    [reviewQuestions],
  );
  const answeredRequiredCount = useMemo(
    () => requiredQuestions.filter((question) => String(answers[question.id] || '').trim()).length,
    [answers, requiredQuestions],
  );
  const answeredQuestionCount = useMemo(
    () => reviewQuestions.filter((question) => String(answers[question.id] || '').trim()).length,
    [answers, reviewQuestions],
  );
  const allQuestionsAnswered = Boolean(
    review && requiredQuestions.every((question) => String(answers[question.id] || '').trim()),
  );
  const nextRequiredQuestion = useMemo(
    () => requiredQuestions.find((question) => !String(answers[question.id] || '').trim()) || null,
    [answers, requiredQuestions],
  );
  const optionalQuestionCount = Math.max(reviewQuestions.length - requiredQuestions.length, 0);
  const groupedQuestions = useMemo(() => {
    const groups = new Map<string, typeof reviewQuestions>();
    reviewQuestions.forEach((question) => {
      const key = formatQuestionCategory(question.category);
      groups.set(key, [...(groups.get(key) || []), question]);
    });
    return Array.from(groups.entries());
  }, [reviewQuestions]);
  const reviewCompletionPercent = useMemo(() => {
    if (requiredQuestions.length === 0) return 0;
    return Math.round((answeredRequiredCount / requiredQuestions.length) * 100);
  }, [answeredRequiredCount, requiredQuestions.length]);
  const hasAwsSecrets = Boolean(aws.aws_access_key_id.trim() && aws.aws_secret_access_key.trim());
  const costEstimate = readCostEstimate();
  const patchState = useCallback((patch: Partial<ActiveDeployState> | ((prev: ActiveDeployState) => ActiveDeployState)) => {
    if (!selectedProjectId) return;
    patchActiveDeploymentState(selectedProjectId, patch);
  }, [selectedProjectId]);
  const appendLog = useCallback((
    text: string,
    type: 'info' | 'success' | 'error' = 'info',
    meta?: Omit<DeployLogEntry, 'text' | 'ts' | 'type'>,
  ) => {
    patchState((prev) => {
      const last = prev.logs[prev.logs.length - 1];
      if (
        last &&
        last.text === text &&
        last.type === type &&
        last.worker_id === meta?.worker_id &&
        last.worker_status === meta?.worker_status
      ) {
        return prev;
      }
      return {
        ...prev,
        logs: [...prev.logs, { text, ts: timestampLabel(), type, ...meta }],
      };
    });
  }, [patchState]);
  const updateIacFileContent = useCallback((filePath: string, nextContent: string) => {
    setIacFiles((prev) => {
      const nextFiles = prev.map((file) => (
        file.path === filePath
          ? { ...file, content: nextContent }
          : file
      ));
      writeStoredJson(IAC_FILES_KEY, nextFiles);
      return nextFiles;
    });
  }, []);
  const pushDeploymentHistory = useCallback((result: DeployApiResult | null, status: 'done' | 'error') => {
    if (!result) return;
    patchState((prev) => {
      const nextEntry = toHistoryEntry(result, status, aws.aws_region);
      const previous = prev.deploymentHistory[0];
      if (
        previous &&
        previous.status === nextEntry.status &&
        previous.instanceId === nextEntry.instanceId &&
        previous.cloudfrontUrl === nextEntry.cloudfrontUrl
      ) {
        return prev;
      }
      return {
        ...prev,
        deploymentHistory: [nextEntry, ...prev.deploymentHistory].slice(0, DEPLOY_HISTORY_MAX),
      };
    });
  }, [aws.aws_region, patchState]);
  const mergeRuntimeDetailsIntoResult = useCallback((details: AwsRuntimeLiveDetails) => {
    patchState((prev) => ({
      ...prev,
      deployResult: mergeDeployResultWithRuntimeDetails(prev.deployResult, details),
    }));
  }, [patchState]);
  const deploySummary = useMemo(() => extractDeploymentSummary(deployResult), [deployResult]);
  const liveRuntimeDetails = useMemo(() => extractLiveRuntimeDetails(deployResult), [deployResult]);
  const keyPairDownloadMessage = useMemo(() => {
    const details = deployResult?.details as Record<string, unknown> | null | undefined;
    const reusedKey = Boolean(details?.key_pair_reused);
    const existingKeyName = String(details?.existing_ec2_key_pair_name || deploySummary.keyName || '').trim();
    if (deploySummary.generatedPem) return '';
    if (reusedKey && existingKeyName) {
      return `This deploy reused existing EC2 key pair '${existingKeyName}'. No new private PEM was generated, so there is nothing to download. Use the original private key for SSH access.`;
    }
    return 'No generated private key is available in this deployment result.';
  }, [deployResult?.details, deploySummary.generatedPem, deploySummary.keyName]);
  const terraformWorkerStates = useMemo(() => {
    const latest = new Map<string, DeployLogEntry>();
    deployLogs.forEach((log) => {
      if (!log.worker_id || log.stage !== 'terraform_generation') return;
      latest.set(log.worker_id, log);
    });
    return Array.from(latest.values());
  }, [deployLogs]);
  const terraformGenerationLogs = useMemo(
    () => deployLogs.filter((log) => log.stage === 'terraform_generation' || Boolean(log.worker_id)),
    [deployLogs],
  );
  const hasLiveRuntimeDetails = useMemo(
    () => Boolean(liveRuntimeDetails && getLiveRuntimeInstanceId(deployResult) && getLiveRuntimeInstanceId(deployResult) !== 'n/a'),
    [deployResult, liveRuntimeDetails],
  );
  const persistedEndpointChecks = useMemo(() => normalizeVerificationChecks(deployResult?.verification_checks), [deployResult?.verification_checks]);
  const effectiveEndpointChecks = endpointChecks.length > 0 ? endpointChecks : persistedEndpointChecks;
  const verificationFailed = useMemo(
    () => effectiveEndpointChecks.some((check) => !check.ok) || deployResult?.deployment_verified === false,
    [deployResult?.deployment_verified, effectiveEndpointChecks],
  );
  const verificationPassed = useMemo(() => {
    if (effectiveEndpointChecks.length > 0) {
      return effectiveEndpointChecks.every((check) => check.ok);
    }
    return deployResult?.deployment_verified === true;
  }, [deployResult?.deployment_verified, effectiveEndpointChecks]);
  const backendErrorMessage = useMemo(() => {
    const direct = String(deployResult?.error || '').trim();
    if (direct) return direct;
    if (verificationFailed) {
      return 'Deployment verification failed or runtime data is incomplete.';
    }
    if (deployStatus === 'error') {
      return 'The backend reported a deployment error.';
    }
    return '';
  }, [deployResult?.error, deployStatus, verificationFailed]);
  const hasEndpointTargets = useMemo(
    () => deploySummary.cloudfrontUrl !== 'n/a' || deploySummary.publicIp !== 'n/a',
    [deploySummary.cloudfrontUrl, deploySummary.publicIp],
  );
  const outputBanner = useMemo<OutputBannerState>(() => {
    if (deployStatus === 'running') {
      return {
        tone: 'warning',
        label: 'Deployment Running',
        title: 'Deployment In Progress',
        description: 'The backend runtime is still applying infrastructure. Outputs will hydrate when the current repo reaches a terminal state.',
      };
    }
    if (deployStatus === 'error' || backendErrorMessage) {
      return {
        tone: 'error',
        label: 'Error',
        title: 'Deployment Error',
        description: backendErrorMessage || 'The deployment did not complete successfully. Review the runtime error and verification details below.',
      };
    }
    if (!deployResult) {
      return {
        tone: 'warning',
        label: 'No Deployment Data',
        title: 'Infrastructure Outputs',
        description: 'No deployment snapshot is bound to this repo yet. Run deploy or reconcile backend status to hydrate outputs.',
      };
    }
    if (verificationFailed) {
      return {
        tone: 'error',
        label: 'Verification Failed',
        title: 'Infrastructure Outputs',
        description: 'The backend returned outputs, but verification failed or the runtime data is incomplete for this repo.',
      };
    }
    if (!deployResult.success) {
      return {
        tone: 'warning',
        label: 'Pending Runtime Confirmation',
        title: 'Infrastructure Outputs',
        description: 'The deploy track has a partial payload, but the backend has not confirmed a successful terminal runtime state yet.',
      };
    }
    if (!hasLiveRuntimeDetails) {
      return {
        tone: 'warning',
        label: 'Missing Runtime Data',
        title: 'Infrastructure Outputs',
        description: 'The deployment payload exists, but live runtime details are missing. Fetch runtime details before treating this deploy as healthy.',
      };
    }
    if (verificationPassed) {
      return {
        tone: 'success',
        label: 'Live',
        title: 'Infrastructure Outputs',
        description: 'The backend confirmed a successful terminal state and the current repo has live runtime data.',
      };
    }
    return {
      tone: 'warning',
      label: 'Pending Verification',
      title: 'Infrastructure Outputs',
      description: 'The backend confirmed infrastructure, but live endpoint verification has not been recorded for this repo yet.',
    };
  }, [backendErrorMessage, deployResult, deployStatus, hasLiveRuntimeDetails, verificationFailed, verificationPassed]);
  const outputBannerClassName = useMemo(() => {
    if (outputBanner.tone === 'success') return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400';
    if (outputBanner.tone === 'error') return 'border-red-500/20 bg-red-500/10 text-red-300';
    return 'border-amber-500/20 bg-amber-500/10 text-amber-300';
  }, [outputBanner.tone]);
  const savedRun = readSavedIacRun();
  const savedIacMeta = readSavedIacMeta();
  const activeSavedRun = useMemo(() => {
    if (!savedRun || !savedIacMeta?.has_run) return null;
    if (!selectedProjectId || savedIacMeta.project_id !== selectedProjectId) return null;
    if (savedIacMeta.workspace && expectedWorkspace && savedIacMeta.workspace !== expectedWorkspace) return null;
    return savedRun;
  }, [expectedWorkspace, savedIacMeta, savedRun, selectedProjectId]);
  const sessionIacTruncated = useMemo(() => hasTruncatedIacFiles(iacFiles), [iacFiles]);
  const deployableIacFiles = useMemo(() => getDeployableIacFiles(iacFiles), [iacFiles]);
  const shouldUseSavedRunForDeploy = Boolean(activeSavedRun?.run_id) && deployableIacFiles.length === 0;
  const activeIacFilePath = selectedFile || iacFiles[0]?.path || '';
  const hasCurrentIacMeta = useMemo(() => {
    if (!selectedProjectId || !savedIacMeta) return false;
    if (savedIacMeta.project_id !== selectedProjectId) return false;
    if (savedIacMeta.workspace && expectedWorkspace && savedIacMeta.workspace !== expectedWorkspace) return false;
    return true;
  }, [expectedWorkspace, savedIacMeta, selectedProjectId]);
  const terraformRunLabel = useMemo(() => {
    if (terraformGenerating) return 'Generating with live websocket telemetry';
    if (shouldUseSavedRunForDeploy) return 'Connected to saved run';
    if (sessionIacTruncated) return 'Cached preview requires regeneration or saved run';
    if (hasCurrentIacMeta) return 'Using generated file bundle';
    if (iacFiles.length > 0) return 'Cached bundle pending refresh';
    return 'Awaiting Terraform generation';
  }, [hasCurrentIacMeta, iacFiles.length, sessionIacTruncated, shouldUseSavedRunForDeploy, terraformGenerating]);
  const shouldConnectPipelineSocket = Boolean(
    selectedProject && (
      activeStage === 'terraform'
      || activeStage === 'deploy'
      || activeStage === 'outputs'
      || deployStatus === 'running'
      || terraformGenerating
    )
  );
  const canFetchRuntimeDetails = Boolean(selectedProject && hasAwsSecrets);
  const canVerifyLiveEndpoints = Boolean(
    selectedProject &&
    deployStatus !== 'running' &&
    deployResult?.success &&
    hasLiveRuntimeDetails &&
    hasEndpointTargets &&
    !backendErrorMessage,
  );
  const canOpenCloudfront = Boolean(hasLiveRuntimeDetails && deploySummary.cloudfrontUrl !== 'n/a');
  const qaSummary = useMemo(() => buildQaSummary(review, answers, repoContext, repoContextMd), [answers, repoContext, repoContextMd, review]);
  const analysisFrameworkNames = useMemo(() => (
    Array.isArray(repoContext?.frameworks)
      ? repoContext.frameworks.map((item) => String(item.name || '')).filter(Boolean)
      : []
  ), [repoContext?.frameworks]);
  const analysisDataStoreNames = useMemo(() => (
    Array.isArray(repoContext?.data_stores)
      ? repoContext.data_stores.map((item) => String(item.type || '')).filter(Boolean)
      : []
  ), [repoContext?.data_stores]);
  const analysisProcessLines = useMemo(() => (
    Array.isArray(repoContext?.processes)
      ? repoContext.processes.map((item) => `${String(item.type || 'process')}: ${String(item.command || item.source || '').trim()}`).filter(Boolean)
      : []
  ), [repoContext?.processes]);
  const analysisSecretNames = useMemo(() => (
    Array.isArray(repoContext?.environment_variables?.required_secrets)
      ? (repoContext.environment_variables?.required_secrets as unknown[]).map((item) => String(item || '')).filter(Boolean)
      : []
  ), [repoContext?.environment_variables?.required_secrets]);
  const analysisConfigNames = useMemo(() => (
    Array.isArray(repoContext?.environment_variables?.config_values)
      ? (repoContext.environment_variables?.config_values as unknown[]).map((item) => String(item || '')).filter(Boolean)
      : []
  ), [repoContext?.environment_variables?.config_values]);
  const analysisFlagLines = useMemo(() => (
    [
      ...(Array.isArray(repoContext?.conflicts) ? repoContext.conflicts.map((item) => String(item.reason || '').trim()) : []),
      ...(Array.isArray(repoContext?.low_confidence_items) ? repoContext.low_confidence_items.map((item) => String(item.reason || '').trim()) : []),
    ].filter(Boolean)
  ), [repoContext?.conflicts, repoContext?.low_confidence_items]);
  const derivedArchitecture = useMemo(() => deriveArchitectureFromDeploymentProfile(deploymentProfile), [deploymentProfile]);
  const shouldUseDerivedArchitecture = useMemo(
    () => architectureViewLooksStale(architectureView, deploymentProfile) || (!Array.isArray(architectureView?.nodes) && derivedArchitecture.nodes.length > 0),
    [architectureView, deploymentProfile, derivedArchitecture.nodes.length],
  );
  const architectureNodes = useMemo<RuntimeArchNode[]>(() => {
    if (shouldUseDerivedArchitecture) {
      return derivedArchitecture.nodes;
    }
    if (Array.isArray(architectureView?.nodes)) {
      return architectureView.nodes.map((node, index) => {
        const entry = node && typeof node === 'object' ? node as Record<string, unknown> : {};
        return {
          id: String(entry.id || `node_${index + 1}`),
          label: String(entry.label || entry.type || `Node ${index + 1}`),
          type: String(entry.type || ''),
        };
      });
    }
    if (Array.isArray(approvalPayload?.diagram?.nodes)) {
      return approvalPayload.diagram.nodes.map((node, index) => ({
        id: String(node.id || `node_${index + 1}`),
        label: String(node.label || node.type || `Node ${index + 1}`),
        type: String(node.type || ''),
      }));
    }
    return [];
  }, [approvalPayload, architectureView, derivedArchitecture.nodes, shouldUseDerivedArchitecture]);
  const architectureEdges = useMemo<RuntimeArchEdge[]>(() => {
    if (shouldUseDerivedArchitecture) {
      return derivedArchitecture.edges;
    }
    if (Array.isArray(architectureView?.edges)) {
      return architectureView.edges.map((edge) => {
        const entry = edge && typeof edge === 'object' ? edge as Record<string, unknown> : {};
        return {
          from: String(entry.from || ''),
          to: String(entry.to || ''),
          label: String(entry.label || ''),
        };
      });
    }
    if (Array.isArray(approvalPayload?.diagram?.edges)) {
      return approvalPayload.diagram.edges.map((edge) => ({
        from: String(edge.from || ''),
        to: String(edge.to || ''),
        label: String(edge.label || edge.style || ''),
      }));
    }
    return [];
  }, [approvalPayload, architectureView, derivedArchitecture.edges, shouldUseDerivedArchitecture]);
  const architectureCostRows = useMemo(() => normalizeCostBreakdown(approvalPayload?.cost_estimate?.line_items), [approvalPayload]);
  const architectureRegion = String(approvalPayload?.diagram?.region || aws.aws_region || 'eu-north-1');
  const architectureLayout = useMemo(() => {
    const columns = 3;
    return architectureNodes.map((node, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      return {
        ...node,
        x: 140 + col * 210,
        y: 56 + row * 96,
        color: pickNodeColor(node.type),
      };
    });
  }, [architectureNodes]);
  const architectureNodePositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    architectureLayout.forEach((node) => {
      map.set(node.id, { x: node.x, y: node.y });
    });
    return map;
  }, [architectureLayout]);
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [deployLogs]);

  useEffect(() => {
    writeSavedAws(aws);
  }, [aws]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(IAC_MODE_STORAGE_KEY, iacMode);
  }, [iacMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(IAC_LLM_PROVIDER_STORAGE_KEY, llmProvider);
    if (!String(llmModel || '').trim()) {
      setLlmModel(IAC_LLM_DEFAULT_MODELS[llmProvider]);
    }
  }, [llmModel, llmProvider]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(IAC_LLM_MODEL_STORAGE_KEY, llmModel);
  }, [llmModel]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(IAC_LLM_API_KEY_STORAGE_KEY, llmApiKey);
  }, [llmApiKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(IAC_LLM_BASE_URL_STORAGE_KEY, llmApiBaseUrl);
  }, [llmApiBaseUrl]);

  useEffect(() => {
    setIacPrUrl(null);
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) return;
    writeStoredJson(REVIEW_ANSWERS_KEY, answers);
  }, [answers, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) return;
    const entry = getOrCreateActiveDeployment(selectedProjectId);
    const apply = (next: ActiveDeployState) => {
      setDeployStatus(next.status);
      setDeployProgress(next.progress);
      setDeployLogs(next.logs);
      setDeployResult(next.deployResult);
      setDeploymentHistory(next.deploymentHistory);
    };
    entry.listeners.add(apply);
    apply(entry.state);
    return () => {
      entry.listeners.delete(apply);
    };
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) return;
    writeStoredJson(QA_CONTEXT_KEY, {
      qa_summary: qaSummary,
      deployment_region: aws.aws_region || 'eu-north-1',
    });
  }, [aws.aws_region, qaSummary, selectedProjectId]);

  useEffect(() => {
    fetch('/api/projects', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data: { projects?: ProjectRecord[] }) => setProjects(Array.isArray(data.projects) ? data.projects : []))
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    const queryProjectId = searchParams.get('projectId');
    const entry = searchParams.get('entry');
    const nextProjectId = queryProjectId || null;
    if (!nextProjectId) {
      idleRecoveryRef.current = null;
      setSelectedProjectId(null);
      setActiveStage('analysis');
      setDeployStatus('idle');
      setDeployProgress(0);
      setDeployLogs([]);
      setDeployResult(null);
      setDeploymentHistory([]);
      setBudgetOverride(false);
      setEndpointChecks([]);
      setError(null);
      return;
    }
    const previousPlanningProjectId = sessionStorage.getItem(PLANNING_PROJECT_KEY);
    const freshLaunch = entry === 'card' || entry === 'selector';
    const projectChanged = !previousPlanningProjectId || previousPlanningProjectId !== nextProjectId;
    if (freshLaunch || projectChanged) {
      clearPlanningState();
      idleRecoveryRef.current = null;
      analysisRequestRef.current = null;
      reviewRequestRef.current = null;
      setAnalysisLoading(false);
      setReviewLoading(false);
      setRepoContext(null);
      setRepoContextMd('');
      setReview(null);
      setAnswers({});
      setDeploymentProfile(null);
      setArchitectureView(null);
      setApprovalPayload(null);
      setIacFiles([]);
      setSelectedFile('');
      setApproved(false);
      setDeployStatus('idle');
      setDeployProgress(0);
      setDeployLogs([]);
      setDeployResult(null);
      setDeploymentHistory([]);
      setEndpointChecks([]);
      setError(null);
    }
    setSelectedProjectId(nextProjectId);
    localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, nextProjectId);
    sessionStorage.setItem(PLANNING_PROJECT_KEY, nextProjectId);
    setActiveStage(freshLaunch ? 'analysis' : ((loadDeployUiStage(nextProjectId) as PipelineStageId | null) || 'analysis'));
    const snapshot = loadDeploySnapshot(nextProjectId);
    const existing = activeDeployments.get(nextProjectId);
    const nextState = existing?.state || toDeployState(snapshot || undefined);
    setActiveDeploymentState(nextProjectId, nextState);
    setEndpointChecks([]);
  }, [searchParams]);

  useEffect(() => {
    if (!selectedProjectId) return;
    if (hasCurrentIacMeta || iacFiles.length === 0) return;
    sessionStorage.removeItem(IAC_FILES_KEY);
    sessionStorage.removeItem(IAC_RUN_KEY);
    sessionStorage.removeItem(IAC_META_KEY);
    setIacFiles([]);
    setSelectedFile('');
  }, [hasCurrentIacMeta, iacFiles.length, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) return;
    persistDeploySnapshot(selectedProjectId, {
      status: deployStatus,
      progress: deployProgress,
      logs: deployLogs,
      deployResult,
      deploymentHistory,
      updatedAt: new Date().toISOString(),
    });
  }, [deployLogs, deployProgress, deployResult, deployStatus, deploymentHistory, selectedProjectId]);

  useEffect(() => {
    if (!selectedProject || !hasAwsSecrets) return;
    if (deployStatus !== 'idle') return;
    if (idleRecoveryRef.current === selectedProject.id) return;
    if (deployResult?.details && typeof deployResult.details === 'object' && 'live_runtime_details' in (deployResult.details as Record<string, unknown>)) return;

    idleRecoveryRef.current = selectedProject.id;
    let cancelled = false;

    const recover = async () => {
      try {
        const response = await fetch('/api/pipeline/runtime-details', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: selectedProject.id,
            aws_access_key_id: aws.aws_access_key_id,
            aws_secret_access_key: aws.aws_secret_access_key,
            aws_region: aws.aws_region,
          }),
        });
        const data = await response.json().catch(() => ({})) as { success?: boolean; details?: Record<string, unknown>; error?: string };
        const recoveredInstanceId = String((data.details as { instance?: { instance_id?: string } } | undefined)?.instance?.instance_id || '').trim();
        if (cancelled || !response.ok || data.success !== true || !data.details || !recoveredInstanceId || recoveredInstanceId === 'n/a') return;

        const recoveredResult: DeployApiResult = {
          success: true,
          details: {
            live_runtime_details: data.details,
          },
        };
        patchState((prev) => ({
          ...prev,
          status: 'done',
          progress: 100,
          deployResult: mergeDeployResultWithRuntimeDetails(prev.deployResult || recoveredResult, data.details as AwsRuntimeLiveDetails),
        }));
        pushDeploymentHistory(recoveredResult, 'done');
        appendLog(`Recovered existing deployment for this project (${recoveredInstanceId}).`, 'success');
      } catch {
        // best-effort recovery only
      }
    };

    void recover();

    return () => {
      cancelled = true;
    };
  }, [appendLog, aws.aws_access_key_id, aws.aws_region, aws.aws_secret_access_key, deployResult?.details, deployStatus, hasAwsSecrets, patchState, pushDeploymentHistory, selectedProject]);

  useEffect(() => {
    if (!selectedProject || !shouldConnectPipelineSocket) {
      pipelineSocketRef.current?.close();
      pipelineSocketRef.current = null;
      setDeploySocketState('idle');
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;

    const connect = async () => {
      try {
        setDeploySocketState('connecting');
        const [wsConfigRes, tokenRes] = await Promise.all([
          fetch('/api/pipeline/ws-config', { cache: 'no-store' }),
          fetch(`/api/scan/ws-token?project_id=${encodeURIComponent(selectedProject.id)}`, { cache: 'no-store' }),
        ]);
        const wsConfig = await wsConfigRes.json().catch(() => ({})) as { success?: boolean; ws_base?: string; error?: string };
        const tokenData = await tokenRes.json().catch(() => ({})) as { token?: string; error?: string };
        if (!wsConfigRes.ok || !wsConfig.success || !wsConfig.ws_base) {
          throw new Error(wsConfig.error || 'Failed to resolve pipeline websocket base.');
        }
        if (!tokenRes.ok || !tokenData.token) {
          throw new Error(tokenData.error || 'Failed to issue pipeline websocket token.');
        }
        if (disposed) return;

        const wsUrl = `${wsConfig.ws_base.replace(/\/$/, '')}/ws/pipeline/${encodeURIComponent(selectedProject.id)}?token=${encodeURIComponent(tokenData.token)}`;
        socket = new WebSocket(wsUrl);
        pipelineSocketRef.current = socket;

        socket.onopen = () => {
          if (disposed) return;
          setDeploySocketState('connected');
          socket?.send(JSON.stringify({ action: 'start' }));
        };

        socket.onmessage = (event) => {
          if (disposed) return;
          try {
            const payload = JSON.parse(String(event.data || '')) as {
              type?: string;
              data?: {
                type?: 'info' | 'success' | 'error';
                content?: string;
                worker_id?: string;
                worker_role?: string;
                worker_status?: string;
                stage?: string;
                model?: string;
              };
            };
            if (payload.type !== 'message' || !payload.data?.content) return;
            appendLog(payload.data.content, payload.data.type || 'info', {
              worker_id: payload.data.worker_id,
              worker_role: payload.data.worker_role,
              worker_status: payload.data.worker_status,
              stage: payload.data.stage,
              model: payload.data.model,
            });
          } catch {
            // ignore malformed websocket payloads
          }
        };

        socket.onerror = () => {
          if (disposed) return;
          setDeploySocketState('error');
        };

        socket.onclose = () => {
          if (disposed) return;
          setDeploySocketState('error');
        };
      } catch (reason) {
        if (disposed) return;
        setDeploySocketState('error');
        appendLog(reason instanceof Error ? reason.message : 'Failed to connect to live pipeline websocket.', 'error');
      }
    };

    void connect();

    return () => {
      disposed = true;
      socket?.close();
      if (pipelineSocketRef.current === socket) {
        pipelineSocketRef.current = null;
      }
    };
  }, [appendLog, selectedProject, shouldConnectPipelineSocket]);

  const setAndPersistStage = useCallback((stage: PipelineStageId) => {
    if (!selectedProjectId) {
      setActiveStage('analysis');
      return;
    }
    setActiveStage(stage);
    if (selectedProjectId) {
      saveDeployUiStage(selectedProjectId, stage);
      localStorage.setItem(`${CURRENT_STAGE_STORAGE_PREFIX}${selectedProjectId}`, stage);
    }
  }, [selectedProjectId]);

  const runAnalysis = useCallback(async () => {
    if (!selectedProject) return;
    const workspace = buildDeploymentWorkspace(selectedProject.id, selectedProject.name);
    if (analysisRequestRef.current === workspace) return;
    analysisRequestRef.current = workspace;
    setAnalysisLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/repository-analysis/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: selectedProject.id, workspace }),
      });
      const data = await response.json().catch(() => ({})) as { success?: boolean; context_json?: RepositoryContextJson; context_md?: string; error?: string };
      if (!response.ok || !data.success || !data.context_json) {
        throw new Error(data.error || 'Repository analysis failed.');
      }
      const contextMd = String(data.context_md || '');
      setRepoContext(data.context_json);
      setRepoContextMd(contextMd);
      writeStoredJson('deplai.pipeline.repoContext', data.context_json);
      writeStoredJson(REPO_CONTEXT_MD_KEY, contextMd);
      writeStoredJson(QA_CONTEXT_KEY, { qa_summary: String(data.context_json.summary || '') });
    } finally {
      setAnalysisLoading(false);
      if (analysisRequestRef.current === workspace) {
        analysisRequestRef.current = null;
      }
    }
  }, [selectedProject]);

  useEffect(() => {
    if (activeStage !== 'analysis' || !selectedProject) return;
    if (repoContext && repoContext.workspace === expectedWorkspace) return;
    void runAnalysis().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Repository analysis failed.'));
  }, [activeStage, expectedWorkspace, repoContext, runAnalysis, selectedProject]);

  const loadReview = useCallback(async () => {
    if (!selectedProject) return;
    const workspace = repoContext?.workspace || buildDeploymentWorkspace(selectedProject.id, selectedProject.name);
    if (reviewRequestRef.current === workspace) return;
    reviewRequestRef.current = workspace;
    setReviewLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/architecture/review/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: selectedProject.id, workspace }),
      });
      const data = await response.json().catch(() => ({})) as { success?: boolean; review?: ArchitectureReviewPayload; error?: string };
      if (!response.ok || !data.success || !data.review) {
        throw new Error(data.error || 'Failed to start architecture review.');
      }
      setReview(data.review);
      const initialAnswers = Object.keys(answers).length > 0 ? answers : {};
      setAnswers(initialAnswers);
      writeStoredJson(REVIEW_PAYLOAD_KEY, data.review);
      writeStoredJson(REVIEW_ANSWERS_KEY, initialAnswers);
    } finally {
      setReviewLoading(false);
      if (reviewRequestRef.current === workspace) {
        reviewRequestRef.current = null;
      }
    }
  }, [answers, repoContext?.workspace, selectedProject]);

  useEffect(() => {
    if (activeStage !== 'qa' || !selectedProject) return;
    if (!repoContext || repoContext.workspace !== expectedWorkspace) {
      setAndPersistStage('analysis');
      return;
    }
    if (review && review.context_json.workspace === expectedWorkspace && review.questions.length > 0) return;
    void loadReview().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Failed to start architecture review.'));
  }, [activeStage, expectedWorkspace, loadReview, repoContext, review, selectedProject, setAndPersistStage]);

  const updateAnswer = useCallback((questionId: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
  }, []);

  const generatePlan = useCallback(async () => {
    if (!selectedProject || !review) return;
    setError(null);
    const response = await fetch('/api/architecture/review/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: selectedProject.id, workspace: review.context_json.workspace || buildDeploymentWorkspace(selectedProject.id, selectedProject.name), answers }),
    });
    const data = await response.json().catch(() => ({})) as {
      success?: boolean;
      deployment_profile?: Record<string, unknown>;
      architecture_view?: Record<string, unknown>;
      approval_payload?: Record<string, unknown>;
      error?: string;
    };
    if (!response.ok || !data.success || !data.deployment_profile || !data.architecture_view) {
      throw new Error(data.error || 'Failed to generate deployment profile.');
    }
    setDeploymentProfile(data.deployment_profile);
    setArchitectureView(data.architecture_view);
    setApprovalPayload(data.approval_payload || null);
    writeStoredJson(DEPLOYMENT_PROFILE_KEY, data.deployment_profile);
    writeStoredJson(ARCHITECTURE_VIEW_KEY, data.architecture_view);
    writeStoredJson(APPROVAL_PAYLOAD_KEY, data.approval_payload || {});
    writeStoredJson(COST_ESTIMATE_KEY, {
      total_monthly_usd: Number((data.approval_payload?.cost_estimate as { total_monthly_usd?: number } | undefined)?.total_monthly_usd || 0),
      budget_cap_usd: Number((data.approval_payload?.budget_gate as { cap_usd?: number } | undefined)?.cap_usd || 100),
    });
    setAndPersistStage('architecture');
  }, [answers, review, selectedProject, setAndPersistStage]);

  const generateTerraform = useCallback(async () => {
    if (!selectedProject) return;
    setError(null);
    setIacPrUrl(null);
    setTerraformGenerating(true);
    appendLog('Starting Terraform generation from the approved deployment profile.');
    try {
      const response = await fetch('/api/pipeline/iac', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: selectedProject.id,
          provider: 'aws',
          iac_mode: iacMode,
          llm_provider: iacMode === 'llm' ? llmProvider : undefined,
          llm_model: iacMode === 'llm' ? (llmModel.trim() || IAC_LLM_DEFAULT_MODELS[llmProvider]) : undefined,
          llm_api_key: iacMode === 'llm' ? (llmApiKey.trim() || undefined) : undefined,
          llm_api_base_url: iacMode === 'llm' ? (llmApiBaseUrl.trim() || undefined) : undefined,
          qa_summary: qaSummary,
          architecture_context: String(repoContext?.summary || ''),
          repository_context: repoContext || undefined,
          deployment_profile: deploymentProfile || undefined,
          approval_payload: approvalPayload || undefined,
          architecture_json: deploymentProfile || architectureView || undefined,
          aws_region: aws.aws_region.trim() || 'eu-north-1',
        }),
      });
      const data = await response.json().catch(() => ({})) as {
        success?: boolean;
        files?: GeneratedIacFile[];
        summary?: string;
        warnings?: string[];
        run_id?: string;
        workspace?: string;
        provider_version?: string;
        state_bucket?: string;
        lock_table?: string;
        source?: string;
        error?: string;
      };
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'IaC generation failed.');
      }
      const files = normalizeIacFiles(Array.isArray(data.files) ? data.files : []);
      setIacFiles(files);
      if (files[0]?.path) setSelectedFile(files[0].path);
      writeStoredJson(IAC_FILES_KEY, files);
      if (data.run_id && data.workspace) {
        sessionStorage.setItem(IAC_RUN_KEY, JSON.stringify({ run_id: data.run_id, workspace: data.workspace, provider_version: data.provider_version || '', state_bucket: data.state_bucket || '', lock_table: data.lock_table || '' }));
      } else {
        sessionStorage.removeItem(IAC_RUN_KEY);
      }
      sessionStorage.setItem(IAC_META_KEY, JSON.stringify({
        project_id: selectedProject.id,
        workspace: data.workspace || expectedWorkspace,
        source: String(data.source || ''),
        generated_at: new Date().toISOString(),
        has_run: Boolean(data.run_id && data.workspace),
      }));
      appendLog(data.summary || `Terraform generation completed with ${files.length} file(s).`, 'success');
      for (const warning of Array.isArray(data.warnings) ? data.warnings : []) {
        appendLog(String(warning), 'info');
      }
    } finally {
      setTerraformGenerating(false);
    }
  }, [appendLog, approvalPayload, architectureView, aws.aws_region, deploymentProfile, expectedWorkspace, iacMode, llmApiBaseUrl, llmApiKey, llmModel, llmProvider, qaSummary, repoContext, selectedProject]);

  const createIacPr = useCallback(async () => {
    if (!selectedProject || iacPrCreating || terraformGenerating || deployableIacFiles.length === 0) return;
    setError(null);
    setIacPrCreating(true);
    try {
      const response = await fetch('/api/pipeline/iac/pr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: selectedProject.id,
          project_name: selectedProject.name,
          files: deployableIacFiles,
        }),
      });
      const data = await response.json().catch(() => ({})) as IacPrResponse;
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to create IaC PR.');
      }
      const prUrl = String(data.pr_url || '').trim();
      setIacPrUrl(prUrl || null);
      appendLog(prUrl ? `IaC PR created: ${prUrl}` : 'IaC PR created.', 'success');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to create IaC PR.');
    } finally {
      setIacPrCreating(false);
    }
  }, [appendLog, deployableIacFiles, iacPrCreating, selectedProject, terraformGenerating]);

  useEffect(() => {
    if (activeStage !== 'terraform' || !selectedProject) return;
    if (terraformGenerating || hasCurrentIacMeta) return;
    if (terraformGenerationLogs.length > 0) return;
    if (!repoContext || repoContext.workspace !== expectedWorkspace) return;
    if (!deploymentProfile && !architectureView) return;

    if (shouldUseSavedRunForDeploy) {
      sessionStorage.removeItem(IAC_RUN_KEY);
      sessionStorage.removeItem(IAC_META_KEY);
    }

    const autostartKey = `${selectedProject.id}:${expectedWorkspace}`;
    if (terraformAutostartRef.current === autostartKey) return;
    terraformAutostartRef.current = autostartKey;

    sessionStorage.removeItem(IAC_FILES_KEY);
    sessionStorage.removeItem(IAC_RUN_KEY);
    sessionStorage.removeItem(IAC_META_KEY);
    setIacFiles([]);
    setSelectedFile('');
    appendLog('No current Terraform run metadata found for this repo. Starting a fresh Terraform generation.', 'info');
    void generateTerraform().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'IaC generation failed.');
    });
  }, [
    activeStage,
    appendLog,
    architectureView,
    deploymentProfile,
    expectedWorkspace,
    generateTerraform,
    hasCurrentIacMeta,
    repoContext,
    selectedProject,
    shouldUseSavedRunForDeploy,
    terraformGenerating,
    terraformGenerationLogs.length,
  ]);

  const hydrateTerminalDeployResult = useCallback(async (baseResult: DeployApiResult | null) => {
    if (!baseResult?.success || String(baseResult.error || '').trim()) {
      throw new Error(String(baseResult?.error || 'Deployment runtime returned an error.'));
    }
    const existingInstanceId = getLiveRuntimeInstanceId(baseResult);
    if (existingInstanceId && existingInstanceId !== 'n/a') {
      return baseResult;
    }
    if (!selectedProject || !hasAwsSecrets) {
      throw new Error('Deployment completed, but live runtime details are missing for this repo.');
    }

    const response = await fetch('/api/pipeline/runtime-details', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: selectedProject.id,
        aws_access_key_id: aws.aws_access_key_id,
        aws_secret_access_key: aws.aws_secret_access_key,
        aws_region: aws.aws_region,
        instance_id: extractDeploymentSummary(baseResult).instanceId !== 'n/a' ? extractDeploymentSummary(baseResult).instanceId : undefined,
      }),
    });
    const data = await response.json().catch(() => ({})) as { success?: boolean; details?: AwsRuntimeLiveDetails; error?: string };
    const hydratedInstanceId = String(data.details?.instance?.instance_id || '').trim();
    if (!response.ok || data.success !== true || !data.details || !hydratedInstanceId || hydratedInstanceId === 'n/a') {
      throw new Error(data.error || 'Deployment completed, but live runtime details could not be verified.');
    }
    return mergeDeployResultWithRuntimeDetails(baseResult, data.details);
  }, [aws.aws_access_key_id, aws.aws_region, aws.aws_secret_access_key, hasAwsSecrets, selectedProject]);

  const reconcileDeploymentStatus = useCallback(async () => {
    if (!selectedProject) return;
    const response = await fetch('/api/pipeline/deploy/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: selectedProject.id, project_name: selectedProject.name }),
    });
    const data = await response.json().catch(() => ({})) as DeployStatusResponse;
    if (!response.ok || data.success !== true) {
      throw new Error(data.error || 'Failed to fetch deployment status.');
    }

    const runtimeStatus = String(data.status || 'idle').toLowerCase();
    const runtimeResult = data.result && typeof data.result === 'object'
      ? data.result as DeployApiResult
      : null;

    if (runtimeStatus === 'running') {
      patchState((prev) => ({
        ...prev,
        status: 'running',
        progress: Math.max(prev.progress, 55),
        deployResult: runtimeResult || prev.deployResult,
      }));
      return;
    }

    if (runtimeStatus === 'completed' && runtimeResult?.success) {
      try {
        const hydratedResult = await hydrateTerminalDeployResult(runtimeResult);
        const hydratedChecks = normalizeVerificationChecks(hydratedResult.verification_checks);
        if (hydratedResult.deployment_verified === false || hydratedChecks.some((check) => !check.ok)) {
          throw new Error(hydratedResult.error || 'Deployment verification failed for the current repo.');
        }
        patchState((prev) => ({
          ...prev,
          status: 'done',
          progress: 100,
          deployResult: hydratedResult,
        }));
        getOrCreateActiveDeployment(selectedProject.id).inFlight = false;
        pushDeploymentHistory(hydratedResult, 'done');
        appendLog('Recovered completed deployment state from backend runtime.', 'success');
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : 'Deployment completed, but runtime verification failed.';
        const errorResult: DeployApiResult = {
          ...((runtimeResult || {}) as DeployApiResult),
          success: false,
          error: runtimeResult?.error || message,
        };
        patchState((prev) => ({
          ...prev,
          status: 'error',
          progress: 100,
          deployResult: errorResult,
        }));
        getOrCreateActiveDeployment(selectedProject.id).inFlight = false;
        pushDeploymentHistory(errorResult, 'error');
        appendLog(message, 'error');
      }
      return;
    }

    if (runtimeStatus === 'completed' || runtimeStatus === 'error') {
      const message = runtimeResult?.error || 'Deployment runtime returned an error.';
      patchState((prev) => ({
        ...prev,
        status: 'error',
        progress: 100,
        deployResult: runtimeResult || prev.deployResult || { success: false, error: message },
      }));
      getOrCreateActiveDeployment(selectedProject.id).inFlight = false;
      pushDeploymentHistory(runtimeResult, 'error');
      appendLog(message, 'error');
      return;
    }

    patchState((prev) => ({
      ...prev,
      status: 'error',
      progress: 100,
      deployResult: prev.deployResult || { success: false, error: 'No active deployment process found.' },
    }));
    getOrCreateActiveDeployment(selectedProject.id).inFlight = false;
    appendLog('No active deployment process found. Marking stale UI run as stopped.', 'error');
  }, [appendLog, hydrateTerminalDeployResult, patchState, pushDeploymentHistory, selectedProject]);

  const startDeploy = useCallback(async () => {
    if (!selectedProject) return;
    const activeDeployment = getOrCreateActiveDeployment(selectedProject.id, {
      status: deployStatus,
      progress: deployProgress,
      logs: deployLogs,
      deployResult,
      deploymentHistory,
    });
    if (deployRequestRef.current === selectedProject.id || activeDeployment.inFlight) {
      appendLog('Deployment already running in background for this project.');
      return;
    }
    activeDeployment.inFlight = true;
    if (!hasAwsSecrets) {
      setError('AWS credentials are required before deployment.');
      patchState({
        status: 'error',
        progress: 100,
        deployResult: { success: false, error: 'AWS credentials are required before deployment.' },
      });
      appendLog('AWS credentials are missing. Configure them first.', 'error');
      activeDeployment.inFlight = false;
      return;
    }
    if (!activeSavedRun && deployableIacFiles.length === 0) {
      const message = sessionIacTruncated
        ? 'Session-cached Terraform files were truncated. Regenerate Terraform or reuse a saved run before deployment.'
        : 'No generated Terraform bundle found. Generate Terraform first.';
      setError(message);
      patchState({
        status: 'error',
        progress: 100,
        deployResult: { success: false, error: message },
      });
      appendLog(message, 'error');
      activeDeployment.inFlight = false;
      return;
    }
    deployRequestRef.current = selectedProject.id;
    setError(null);
    patchState({
      status: 'running',
      progress: 5,
      logs: [],
      deployResult: null,
    });
    setEndpointChecks([]);
    appendLog('Preparing runtime deploy payload...');
    try {
      patchState({ progress: 20 });
      appendLog('Calling /api/pipeline/deploy for runtime apply...');
      const response = await fetch('/api/pipeline/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: selectedProject.id,
          provider: 'aws',
          runtime_apply: true,
          run_id: shouldUseSavedRunForDeploy ? activeSavedRun?.run_id : undefined,
          workspace: shouldUseSavedRunForDeploy ? activeSavedRun?.workspace : undefined,
          state_bucket: shouldUseSavedRunForDeploy ? activeSavedRun?.state_bucket : undefined,
          lock_table: shouldUseSavedRunForDeploy ? activeSavedRun?.lock_table : undefined,
          files: shouldUseSavedRunForDeploy ? [] : deployableIacFiles,
          aws_access_key_id: aws.aws_access_key_id,
          aws_secret_access_key: aws.aws_secret_access_key,
          aws_region: aws.aws_region,
          estimated_monthly_usd: costEstimate.total,
          budget_limit_usd: costEstimate.cap,
          budget_override: budgetOverride,
        }),
      });
      const data = await response.json().catch(() => ({})) as DeployApiResult;
      if (!response.ok || !data.success) {
        const message = data.error || 'Deployment failed.';
        patchState((prev) => ({
          ...prev,
          status: 'error',
          progress: 100,
          deployResult: data || { success: false, error: message },
        }));
        pushDeploymentHistory(data || null, 'error');
        appendLog(message, 'error');
        setError(message);
        return;
      }
      patchState((prev) => ({
        ...prev,
        status: 'running',
        progress: Math.max(prev.progress, 80),
        deployResult: data,
      }));
      appendLog('Runtime apply request returned. Waiting for backend runtime to reach a terminal state...');
      try {
        await reconcileDeploymentStatus();
      } catch {
        patchState((prev) => ({
          ...prev,
          status: 'running',
          progress: Math.max(prev.progress, 90),
          deployResult: data,
        }));
        appendLog('Backend confirmation is still pending. Use Reconcile Backend Status if this state persists.', 'info');
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Deployment failed.';
      patchState((prev) => ({
        ...prev,
        status: 'error',
        progress: 100,
        deployResult: prev.deployResult || { success: false, error: message },
      }));
      appendLog(message, 'error');
      setError(message);
    } finally {
      if (deployRequestRef.current === selectedProject.id) {
        deployRequestRef.current = null;
      }
      activeDeployment.inFlight = false;
    }
  }, [activeSavedRun, appendLog, aws.aws_access_key_id, aws.aws_region, aws.aws_secret_access_key, budgetOverride, costEstimate.cap, costEstimate.total, deployLogs, deployProgress, deployResult, deployStatus, deployableIacFiles, deploymentHistory, hasAwsSecrets, patchState, pushDeploymentHistory, reconcileDeploymentStatus, selectedProject, sessionIacTruncated, shouldUseSavedRunForDeploy]);

  const stopDeployment = useCallback(async () => {
    if (!selectedProject || stopLoading || deployStatus !== 'running') return;
    setStopLoading(true);
    try {
      appendLog('Stop requested. Terminating deployment process...');
      const response = await fetch('/api/pipeline/deploy/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: selectedProject.id, project_name: selectedProject.name }),
      });
      const data = await response.json().catch(() => ({})) as { success?: boolean; message?: string; error?: string };
      if (!response.ok || data.success !== true) {
        const backendMessage = String(data.error || data.message || '');
        if (/no active deployment process found/i.test(backendMessage)) {
          await reconcileDeploymentStatus();
          appendLog('No active deployment process found on backend. UI state reconciled.', 'info');
          return;
        }
        throw new Error(backendMessage || 'Failed to stop deployment process.');
      }
      deployRequestRef.current = null;
      getOrCreateActiveDeployment(selectedProject.id).inFlight = false;
      const stopMessage = data.message || 'Deployment process terminated.';
      patchState((prev) => ({
        ...prev,
        status: 'error',
        progress: 100,
        deployResult: {
          ...((prev.deployResult || {}) as DeployApiResult),
          success: false,
          error: stopMessage,
        },
      }));
      appendLog(stopMessage, 'success');
    } catch (reason) {
      appendLog(reason instanceof Error ? reason.message : 'Failed to stop deployment process.', 'error');
    } finally {
      setStopLoading(false);
    }
  }, [appendLog, deployStatus, patchState, reconcileDeploymentStatus, selectedProject, stopLoading]);

  const fetchRuntimeDetails = useCallback(async () => {
    if (!selectedProject || !hasAwsSecrets) return;
    const response = await fetch('/api/pipeline/runtime-details', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: selectedProject.id,
        aws_access_key_id: aws.aws_access_key_id,
        aws_secret_access_key: aws.aws_secret_access_key,
        aws_region: aws.aws_region,
        instance_id: deploySummary.instanceId !== 'n/a' ? deploySummary.instanceId : undefined,
      }),
    });
    const data = await response.json().catch(() => ({})) as { success?: boolean; details?: AwsRuntimeLiveDetails; error?: string };
    if (!response.ok || !data.success || !data.details) {
      throw new Error(data.error || 'Failed to fetch runtime details.');
    }
    mergeRuntimeDetailsIntoResult(data.details);
    appendLog('Live AWS runtime details updated.', 'success');
  }, [appendLog, aws.aws_access_key_id, aws.aws_region, aws.aws_secret_access_key, deploySummary.instanceId, hasAwsSecrets, mergeRuntimeDetailsIntoResult, selectedProject]);

  const verifyLiveEndpoints = useCallback(async () => {
    setVerifyLoading(true);
    try {
      const response = await fetch('/api/pipeline/deploy/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cloudfront_url: deploySummary.cloudfrontUrl !== 'n/a' ? deploySummary.cloudfrontUrl : '',
          public_ip: deploySummary.publicIp !== 'n/a' ? deploySummary.publicIp : '',
        }),
      });
      const data = await response.json().catch(() => ({})) as {
        success?: boolean;
        checks?: EndpointVerificationCheck[];
        error?: string;
      };
      if (!response.ok || data.success !== true) {
        throw new Error(data.error || 'Endpoint verification failed.');
      }
      const checks = Array.isArray(data.checks) ? data.checks : [];
      const verified = checks.length > 0 && checks.every((check) => check.ok);
      setEndpointChecks(checks);
      patchState((prev) => ({
        ...prev,
        deployResult: {
          ...((prev.deployResult || { success: deployStatus === 'done' }) as DeployApiResult),
          deployment_verified: verified,
          verification_checks: checks,
        },
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Endpoint verification failed.');
    } finally {
      setVerifyLoading(false);
    }
  }, [deployStatus, deploySummary.cloudfrontUrl, deploySummary.publicIp, patchState]);

  const downloadPpk = useCallback(async () => {
    if (!deploySummary.generatedPem) return;
    const response = await fetch('/api/pipeline/keypair/ppk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ private_key_pem: deploySummary.generatedPem, key_name: deploySummary.keyName, project_name: selectedProject?.name }),
    });
    const data = await response.json().catch(() => ({})) as { success?: boolean; file_name?: string; content_base64?: string; error?: string; hint?: string };
    if (!response.ok || !data.success || !data.content_base64) {
      throw new Error(data.hint ? `${data.error || 'PPK conversion failed.'} ${data.hint}` : (data.error || 'PPK conversion failed.'));
    }
    const bytes = Uint8Array.from(atob(data.content_base64), (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = data.file_name || `${deploySummary.keyName}.ppk`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [deploySummary.generatedPem, deploySummary.keyName, selectedProject?.name]);

  const destroyDeployment = useCallback(async () => {
    if (!selectedProject || destroyLoading) return;
    if (deployStatus === 'running') {
      appendLog('Stop deployment first, then run destroy.', 'error');
      return;
    }
    if (!hasAwsSecrets) {
      appendLog('AWS credentials are missing. Configure them first.', 'error');
      return;
    }
    setDestroyLoading(true);
    try {
      const response = await fetch('/api/pipeline/deploy/destroy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: selectedProject.id,
          aws_access_key_id: aws.aws_access_key_id,
          aws_secret_access_key: aws.aws_secret_access_key,
          aws_region: aws.aws_region,
        }),
      });
      const data = await response.json().catch(() => ({})) as {
        success?: boolean;
        details?: {
          instances_terminated?: string[];
          s3_buckets_deleted?: string[];
          cloudfront_deleted?: string[];
          cloudfront_pending_disable?: string[];
          security_groups_deleted?: string[];
          volumes_deleted?: string[];
          errors?: string[];
        };
        error?: string;
      };
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Destroy failed.');
      }
      deployRequestRef.current = null;
      getOrCreateActiveDeployment(selectedProject.id).inFlight = false;
      patchState((prev) => ({
        ...prev,
        status: 'idle',
        progress: 0,
        deployResult: null,
      }));
      setEndpointChecks([]);
      const details = data.details || {};
      appendLog(
        `Destroy complete: ec2=${(details.instances_terminated || []).length}, s3=${(details.s3_buckets_deleted || []).length}, cloudfront=${(details.cloudfront_deleted || []).length}, sg=${(details.security_groups_deleted || []).length}, ebs=${(details.volumes_deleted || []).length}`,
        'success',
      );
      if ((details.cloudfront_pending_disable || []).length > 0) {
        appendLog(
          `CloudFront pending disable/delete: ${(details.cloudfront_pending_disable || []).join(', ')}. Re-run destroy after distributions are disabled/deployed.`,
          'info',
        );
      }
      for (const warning of (details.errors || []).slice(0, 5)) {
        appendLog(`Destroy warning: ${warning}`, 'error');
      }
    } finally {
      setDestroyLoading(false);
    }
  }, [appendLog, aws.aws_access_key_id, aws.aws_region, aws.aws_secret_access_key, deployStatus, destroyLoading, hasAwsSecrets, patchState, selectedProject]);

  useEffect(() => {
    if (!selectedProject || deployStatus !== 'running') return;
    const activeDeployment = getOrCreateActiveDeployment(selectedProject.id);
    if (activeDeployment.inFlight) return;
    let cancelled = false;

    const probe = async () => {
      if (cancelled) return;
      try {
        await reconcileDeploymentStatus();
      } catch {
        // best-effort reconciliation while backend apply is in flight
      }
    };

    const timerId = window.setInterval(() => {
      void probe();
    }, 10_000);

    void probe();

    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [deployProgress, deployStatus, reconcileDeploymentStatus, selectedProject]);

  const showRegenerateTerraformButton =
    Boolean(selectedProject) &&
    /provided terraform bundle (is|appears) outdated|stale terraform bundle|default-vpc conditional mode|key pair reuse variable is missing/i.test(String(error || ''));

  return (
    <div className="flex h-screen overflow-hidden bg-black font-sans text-zinc-300">
      <aside className="flex h-full w-65 shrink-0 flex-col border-r border-[#1A1A1A] bg-[#050505]">
        <div className="flex h-16 items-center border-b border-[#1A1A1A] px-6"><div className="flex items-center gap-3"><div className="flex h-6 w-6 items-center justify-center rounded border border-[#262626] bg-[#111111] text-xs font-bold text-white">N</div><span className="text-sm font-semibold tracking-wide text-white">DepLAI</span></div></div>
        <div className="custom-scrollbar flex-1 space-y-1 overflow-y-auto px-3 py-6">
          {SIDEBAR_STAGES.map((stage) => <button key={stage.id} onClick={() => setAndPersistStage(stage.id)} className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left ${activeStage === stage.id ? 'bg-[#111111] text-zinc-100' : 'text-zinc-400 hover:bg-[#0A0A0A]'}`}><div className="flex shrink-0 items-center justify-center">{activeStage === stage.id ? <CircleDashed className="h-4 w-4 animate-spin text-indigo-500" /> : <div className="h-4 w-4 rounded-full border border-zinc-700" />}</div><div><div className="text-[13px] font-medium">{stage.label}</div><div className="text-[10px] uppercase tracking-widest text-zinc-600">{stage.details}</div></div></button>)}
        </div>
      </aside>
      <div className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-16 items-center justify-between border-b border-[#1A1A1A] bg-[#050505] px-8">
          <div className="flex items-center gap-2 text-sm"><button onClick={() => router.push('/dashboard')} className="font-medium text-zinc-500 hover:text-white">Dashboard</button><ChevronRight className="h-4 w-4 text-zinc-700" /><span className="font-medium text-zinc-100">{SIDEBAR_STAGES.find((stage) => stage.id === activeStage)?.label}</span></div>
          {selectedProject && <div className="flex items-center gap-3"><span className="rounded-md border border-[#262626] bg-[#111111] px-3 py-1.5 font-mono text-xs text-zinc-400">{selectedProject.name}</span><button onClick={() => router.push('/dashboard')} className="text-xs font-semibold text-zinc-400 hover:text-white">Exit</button></div>}
        </header>
        <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
          {error && (
            <div className="mx-auto mb-6 flex max-w-5xl items-center justify-between gap-4 rounded-md border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-300">
              <div>{error}</div>
              {showRegenerateTerraformButton ? (
                <button
                  onClick={() => {
                    setAndPersistStage('terraform');
                    void generateTerraform().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'IaC generation failed.'));
                  }}
                  className="shrink-0 rounded-md border border-red-400/30 bg-red-500/20 px-4 py-2 text-xs font-semibold text-red-100 hover:bg-red-500/30"
                >
                  Regenerate Terraform
                </button>
              ) : null}
            </div>
          )}
          {selectedProject && (activeStage === 'approval' || activeStage === 'terraform') && (
            <div className="mx-auto mb-6 max-w-5xl rounded-lg border border-[#1A1A1A] bg-[#050505] p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <div className="text-sm font-semibold text-zinc-100">IaC Generation Mode</div>
                  <div className="mt-1 text-xs text-zinc-500">AWS always runs through the Agentic multi-worker Terraform pipeline. This setting only chooses whether workers render HCL directly or whether the pipeline stays in deterministic rescue mode.</div>
                </div>
                <div className="grid w-full gap-3 md:grid-cols-2 lg:w-auto lg:min-w-130">
                  <select
                    value={iacMode}
                    onChange={(event) => setIacMode(event.target.value === 'llm' ? 'llm' : 'deterministic')}
                    className="rounded-md border border-[#262626] bg-black px-3 py-2 text-xs font-semibold text-zinc-200 outline-none"
                  >
                    <option value="deterministic">Deterministic rescue only</option>
                    <option value="llm">Agentic workers</option>
                  </select>
                  {iacMode === 'llm' ? (
                    <select
                      value={llmProvider}
                      onChange={(event) => {
                        const nextProvider = event.target.value as IacLlmProvider;
                        setLlmProvider(nextProvider);
                        setLlmModel((prev) => String(prev || '').trim() || IAC_LLM_DEFAULT_MODELS[nextProvider]);
                      }}
                      className="rounded-md border border-[#262626] bg-black px-3 py-2 text-xs font-semibold text-zinc-200 outline-none"
                    >
                      <option value="groq">Groq</option>
                      <option value="openrouter">OpenRouter</option>
                      <option value="ollama">Ollama Cloud API</option>
                      <option value="opencode">OpenCode API</option>
                    </select>
                  ) : null}
                  {iacMode === 'llm' ? (
                    <input
                      value={llmModel}
                      onChange={(event) => setLlmModel(event.target.value)}
                      placeholder={IAC_LLM_DEFAULT_MODELS[llmProvider]}
                      className="rounded-md border border-[#262626] bg-black px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 outline-none"
                    />
                  ) : null}
                  {iacMode === 'llm' ? (
                    <input
                      type="password"
                      value={llmApiKey}
                      onChange={(event) => setLlmApiKey(event.target.value)}
                      placeholder={llmProvider === 'groq' ? 'gsk_...' : llmProvider === 'openrouter' ? 'sk-or-v1-...' : 'API key'}
                      className="rounded-md border border-[#262626] bg-black px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 outline-none"
                    />
                  ) : null}
                  {iacMode === 'llm' ? (
                    <input
                      value={llmApiBaseUrl}
                      onChange={(event) => setLlmApiBaseUrl(event.target.value)}
                      placeholder="Optional base URL override (https://.../v1)"
                      className="md:col-span-2 rounded-md border border-[#262626] bg-black px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 outline-none"
                    />
                  ) : null}
                </div>
              </div>
            </div>
          )}
          {activeStage === 'analysis' && <div className="mx-auto max-w-5xl space-y-6">{selectedProject ? <><div><h1 className="mb-1 text-2xl font-semibold text-zinc-100">Repository Analysis</h1><p className="text-sm text-zinc-400">{analysisLoading ? 'Scanning codebase and waiting for Agentic Layer.' : 'Scanning codebase to infer runtime and deployment requirements.'}</p></div><div className="grid grid-cols-3 gap-6"><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Runtime</div><div className="text-lg font-medium text-zinc-100">{analysisLoading ? 'Scanning...' : String(repoContext?.language?.runtime || 'Unknown')}</div></div><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Frameworks</div><div className="text-lg font-medium text-zinc-100">{analysisLoading ? 'Scanning...' : analysisFrameworkNames.join(' / ') || 'None detected'}</div></div><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Data Stores</div><div className="text-lg font-medium text-zinc-100">{analysisLoading ? 'Scanning...' : analysisDataStoreNames.join(', ') || 'None detected'}</div></div></div>{!analysisLoading && repoContext && <div className="grid grid-cols-2 gap-6"><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Scanner Summary</div><div className="space-y-2 text-sm text-zinc-300"><div>{String(repoContext.summary || 'No summary generated yet.')}</div><div className="text-zinc-500">Workspace: <span className="font-mono text-zinc-300">{repoContext.workspace}</span></div><div className="text-zinc-500">Build: <span className="font-mono text-zinc-300">{String(repoContext.build?.build_command || 'not detected')}</span></div><div className="text-zinc-500">Start: <span className="font-mono text-zinc-300">{String(repoContext.build?.start_command || 'not detected')}</span></div><div className="text-zinc-500">Health: <span className="font-mono text-zinc-300">{String(repoContext.health?.endpoint || 'not detected')}</span></div></div></div><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Terraform Context</div><pre className="max-h-55 overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-400">{qaSummary || 'Repository context will appear here after the scanner completes.'}</pre></div><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Processes & Config</div><div className="space-y-2 text-sm text-zinc-300">{analysisProcessLines.length > 0 ? analysisProcessLines.map((line) => <div key={line}>{line}</div>) : <div className="text-zinc-500">No explicit processes detected.</div>}{analysisConfigNames.length > 0 && <div className="pt-3 text-zinc-500">Config values: <span className="text-zinc-300">{analysisConfigNames.join(', ')}</span></div>}</div></div><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Secrets & Flags</div><div className="space-y-2 text-sm text-zinc-300">{analysisSecretNames.length > 0 ? <div>Required secrets: {analysisSecretNames.join(', ')}</div> : <div className="text-zinc-500">No required secrets detected.</div>}{analysisFlagLines.length > 0 ? analysisFlagLines.map((line) => <div key={line} className="text-amber-300">{line}</div>) : <div className="text-zinc-500">No major flags raised by the scanner.</div>}{repoContext.readme_notes && <div className="text-zinc-400">{String(repoContext.readme_notes)}</div>}</div></div></div>}{!analysisLoading && repoContextMd && <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Scanner Markdown</div><pre className="max-h-80 overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-400">{repoContextMd}</pre></div>}<div className="flex justify-end"><button onClick={() => setAndPersistStage('qa')} disabled={analysisLoading || !repoContext || repoContext.workspace !== expectedWorkspace} className="flex items-center gap-2 rounded-md bg-zinc-100 px-6 py-2.5 text-sm font-semibold text-black hover:bg-white disabled:cursor-not-allowed disabled:bg-[#111111] disabled:text-zinc-500">{analysisLoading ? 'Scanning Repository...' : 'Continue to Questions'} <ArrowRight className="h-4 w-4" /></button></div></> : <div className="rounded-xl border border-[#1A1A1A] bg-[#050505] p-8"><h1 className="mb-2 text-2xl font-semibold text-zinc-100">Choose a Repository from the Dashboard</h1><p className="max-w-2xl text-sm leading-relaxed text-zinc-400">Deployment Track only runs against a specific repository. Start from a repo card on the dashboard so the AWS deployment flow is bound to the correct project.</p><div className="mt-6"><button onClick={() => router.push('/dashboard')} className="rounded-md bg-zinc-100 px-5 py-2.5 text-sm font-semibold text-black hover:bg-white">Back to Dashboard</button></div></div>}</div>}
          {activeStage === 'qa' && (
            <div className="mx-auto max-w-6xl space-y-6">
              <div className="border-b border-[#1A1A1A] py-6">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Deployment Questions</h1>
                    <p className="text-sm text-zinc-400">
                      {reviewLoading
                        ? 'Preparing deployment questions from repository analysis.'
                        : 'Answer the required deployment questions so DeplAI can generate an AWS architecture and Terraform plan.'}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] px-4 py-3">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Required</div>
                      <div className="mt-1 text-xl font-semibold text-zinc-100">{answeredRequiredCount}/{requiredQuestions.length || 0}</div>
                    </div>
                    <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] px-4 py-3">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Progress</div>
                      <div className="mt-1 text-xl font-semibold text-zinc-100">{reviewCompletionPercent}%</div>
                    </div>
                    <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] px-4 py-3 sm:col-span-1 col-span-2">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Next Up</div>
                      <div className="mt-1 text-sm font-medium text-zinc-200">{nextRequiredQuestion ? formatQuestionCategory(nextRequiredQuestion.category) : 'Ready to generate'}</div>
                    </div>
                  </div>
                </div>
              </div>

              {reviewLoading ? (
                <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
                  <div className="space-y-4">
                    {Array.from({ length: 4 }).map((_, index) => (
                      <div key={index} className="animate-pulse rounded-2xl border border-[#1A1A1A] bg-[#050505] p-6">
                        <div className="mb-4 h-3 w-24 rounded bg-[#111111]" />
                        <div className="mb-3 h-6 w-3/4 rounded bg-[#111111]" />
                        <div className="h-10 w-full rounded bg-[#111111]" />
                      </div>
                    ))}
                  </div>
                  <div className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-6 text-sm text-zinc-400">
                    Building the deployment questionnaire from repository analysis...
                  </div>
                </div>
              ) : review ? (
                <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
                  <div className="space-y-6">
                    <div className="grid gap-4 md:grid-cols-3">
                      <div className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-5">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Repository</div>
                        <div className="mt-2 text-sm font-medium text-zinc-100">{selectedProject?.name || 'Unknown project'}</div>
                        <div className="mt-2 text-xs text-zinc-500">{String(repoContext?.language?.runtime || 'Unknown runtime')}</div>
                      </div>
                      <div className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-5">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Detected Stack</div>
                        <div className="mt-2 text-sm text-zinc-200">
                          {analysisFrameworkNames.length > 0 ? analysisFrameworkNames.join(' / ') : 'Frameworks not detected'}
                        </div>
                        <div className="mt-2 text-xs text-zinc-500">
                          {analysisDataStoreNames.length > 0 ? `Data: ${analysisDataStoreNames.join(', ')}` : 'No managed datastore detected'}
                        </div>
                      </div>
                      <div className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-5">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Question Scope</div>
                        <div className="mt-2 text-sm text-zinc-200">{reviewQuestions.length} total questions</div>
                        <div className="mt-2 text-xs text-zinc-500">{optionalQuestionCount} optional</div>
                      </div>
                    </div>

                    {groupedQuestions.map(([category, questions]) => (
                      <section key={category} className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-6">
                        <div className="mb-5 flex items-center justify-between gap-4">
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">{category}</div>
                            <div className="mt-1 text-sm text-zinc-400">
                              {questions.filter((question) => String(answers[question.id] || '').trim()).length}/{questions.length} answered
                            </div>
                          </div>
                          <div className="h-2 w-28 overflow-hidden rounded-full bg-[#111111]">
                            <div
                              className="h-full rounded-full bg-indigo-500"
                              style={{
                                width: `${Math.round((questions.filter((question) => String(answers[question.id] || '').trim()).length / Math.max(questions.length, 1)) * 100)}%`,
                              }}
                            />
                          </div>
                        </div>

                        <div className="space-y-4">
                          {questions.map((question, index) => {
                            const answer = String(answers[question.id] || '').trim();
                            const suggested = String(question.default || '').trim();
                            const isRequired = question.required !== false;
                            const isNext = nextRequiredQuestion?.id === question.id;
                            return (
                              <div
                                key={question.id}
                                className={`rounded-2xl border p-5 transition-colors ${
                                  isNext
                                    ? 'border-indigo-500/40 bg-indigo-500/5'
                                    : answer
                                      ? 'border-emerald-500/20 bg-emerald-500/5'
                                      : 'border-[#1A1A1A] bg-black/40'
                                }`}
                              >
                                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                                  <div>
                                    <div className="mb-2 flex flex-wrap items-center gap-2">
                                      <span className="rounded-full border border-[#262626] bg-[#111111] px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                                        Question {index + 1}
                                      </span>
                                      <span
                                        className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest ${
                                          isRequired
                                            ? 'border-amber-500/20 bg-amber-500/10 text-amber-300'
                                            : 'border-zinc-700 bg-[#111111] text-zinc-500'
                                        }`}
                                      >
                                        {isRequired ? 'Required' : 'Optional'}
                                      </span>
                                      {isNext ? (
                                        <span className="rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-indigo-300">
                                          Next
                                        </span>
                                      ) : null}
                                    </div>
                                    <h2 className="text-base font-medium leading-relaxed text-zinc-100">{question.question}</h2>
                                  </div>
                                  {answer ? (
                                    <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
                                      <CheckCircle2 className="h-3.5 w-3.5" />
                                      Answered
                                    </div>
                                  ) : null}
                                </div>

                                {Array.isArray(question.options) && question.options.length > 0 ? (
                                  <div className="grid gap-3 md:grid-cols-2">
                                    {question.options.map((option) => {
                                      const selected = answer === option.value;
                                      const suggestedOption = !answer && suggested === option.value;
                                      return (
                                        <button
                                          key={option.value}
                                          type="button"
                                          onClick={() => updateAnswer(question.id, option.value)}
                                          className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                                            selected
                                              ? 'border-indigo-500 bg-indigo-500/10 text-white'
                                              : 'border-[#262626] bg-[#050505] text-zinc-300 hover:border-[#3f3f46] hover:bg-[#0A0A0A]'
                                          }`}
                                        >
                                          <div className="flex items-start justify-between gap-3">
                                            <div>
                                              <div className="text-sm font-medium">{option.label}</div>
                                              {option.description ? (
                                                <div className="mt-1 text-xs leading-relaxed text-zinc-500">{option.description}</div>
                                              ) : null}
                                            </div>
                                            {selected ? (
                                              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-indigo-300" />
                                            ) : suggestedOption ? (
                                              <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] uppercase tracking-widest text-zinc-500">
                                                Suggested
                                              </span>
                                            ) : null}
                                          </div>
                                        </button>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <div className="space-y-3">
                                    <input
                                      value={answer}
                                      onChange={(event) => updateAnswer(question.id, event.target.value)}
                                      placeholder={questionInputPlaceholder(question.id, question.default)}
                                      className="w-full rounded-xl border border-[#262626] bg-[#050505] px-4 py-3 text-sm text-zinc-200 outline-none transition-colors placeholder:text-zinc-600 focus:border-indigo-500/50"
                                    />
                                    {suggested ? (
                                      <div className="text-xs text-zinc-500">
                                        Suggested default: <span className="font-mono text-zinc-300">{suggested}</span>
                                      </div>
                                    ) : null}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    ))}
                  </div>

                  <div className="space-y-4 lg:sticky lg:top-8 lg:self-start">
                    <div className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-6">
                      <div className="mb-4 text-[10px] font-bold uppercase tracking-widest text-zinc-500">Readiness</div>
                      <div className="mb-3 text-3xl font-semibold text-zinc-100">{reviewCompletionPercent}%</div>
                      <div className="h-2 overflow-hidden rounded-full bg-[#111111]">
                        <div className="h-full rounded-full bg-indigo-500" style={{ width: `${reviewCompletionPercent}%` }} />
                      </div>
                      <div className="mt-4 space-y-2 text-xs text-zinc-400">
                        <div>Required answered: <span className="font-mono text-zinc-200">{answeredRequiredCount}/{requiredQuestions.length || 0}</span></div>
                        <div>Total answered: <span className="font-mono text-zinc-200">{answeredQuestionCount}/{reviewQuestions.length || 0}</span></div>
                        {nextRequiredQuestion ? (
                          <div>Next question: <span className="text-zinc-200">{nextRequiredQuestion.question}</span></div>
                        ) : (
                          <div className="text-emerald-300">All required deployment questions are complete.</div>
                        )}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-6">
                      <div className="mb-4 text-[10px] font-bold uppercase tracking-widest text-zinc-500">Repository Signal</div>
                      <div className="space-y-3 text-sm text-zinc-300">
                        <div>
                          <div className="text-zinc-500">Workspace</div>
                          <div className="mt-1 font-mono text-xs text-zinc-200">{review.context_json.workspace}</div>
                        </div>
                        <div>
                          <div className="text-zinc-500">Runtime</div>
                          <div className="mt-1 text-zinc-200">{String(repoContext?.language?.runtime || 'Unknown')}</div>
                        </div>
                        <div>
                          <div className="text-zinc-500">Build Command</div>
                          <div className="mt-1 font-mono text-xs text-zinc-200">{String(repoContext?.build?.build_command || 'not detected')}</div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-6">
                      <div className="mb-4 text-[10px] font-bold uppercase tracking-widest text-zinc-500">What Happens Next</div>
                      <div className="space-y-2 text-sm text-zinc-400">
                        <div>1. Generate AWS architecture and cost estimate.</div>
                        <div>2. Review and approve the plan.</div>
                        <div>3. Generate Terraform and continue to deployment.</div>
                      </div>
                      <button
                        onClick={() => void generatePlan().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Failed to generate deployment profile.'))}
                        disabled={!allQuestionsAnswered}
                        className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-[#111111] disabled:text-zinc-500"
                      >
                        Generate Architecture & Cost
                        <ArrowRight className="h-4 w-4" />
                      </button>
                      {!allQuestionsAnswered ? (
                        <div className="mt-3 text-xs text-zinc-500">
                          Finish the required questions to unlock the plan.
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-8 text-sm text-zinc-400">
                  The deployment questionnaire could not be loaded. Return to repository analysis and retry.
                </div>
              )}
            </div>
          )}
          {activeStage === 'architecture' && <div className="mx-auto max-w-6xl space-y-6"><div><h1 className="mb-1 text-2xl font-semibold text-zinc-100">Architecture & Cost Estimate</h1><p className="text-sm text-zinc-400">Generated topology for AWS ({architectureRegion}) from repository analysis and deployment Q&A.</p></div><div className="grid grid-cols-3 gap-6"><div className="col-span-2 overflow-hidden rounded-lg border border-[#1A1A1A] bg-[#050505]"><div className="flex items-center justify-between border-b border-[#1A1A1A] px-5 py-4"><div><div className="text-sm font-semibold text-zinc-100">Generated Architecture Graph</div><div className="text-xs text-zinc-500">{architectureNodes.length} nodes / {architectureEdges.length} edges</div></div></div><div className="p-5">{architectureLayout.length > 0 ? <svg viewBox="0 0 700 400" className="w-full rounded-lg bg-black"><defs><marker id="deploy-track-arrow" markerWidth="8" markerHeight="6" refX="6" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#3f3f46" /></marker></defs>{architectureEdges.map((edge, index) => { const from = architectureNodePositions.get(edge.from); const to = architectureNodePositions.get(edge.to); if (!from || !to) return null; return <line key={`${edge.from}-${edge.to}-${index}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#3f3f46" strokeWidth="1.5" strokeDasharray="5,3" markerEnd="url(#deploy-track-arrow)" />; })}{architectureLayout.map((node) => <g key={node.id} transform={`translate(${node.x - 60},${node.y - 22})`}><rect width="120" height="44" rx="8" fill={`${node.color}18`} stroke={node.color} strokeWidth="1" strokeOpacity=".65" /><text x="60" y="17" textAnchor="middle" fill={node.color} fontSize="9" fontFamily="monospace" fontWeight="600">{node.id.toUpperCase()}</text><text x="60" y="31" textAnchor="middle" fill="#a1a1aa" fontSize="10" fontFamily="-apple-system,sans-serif">{node.label || node.type}</text></g>)}<text x="350" y="392" textAnchor="middle" fill="#52525b" fontSize="10" fontFamily="-apple-system,sans-serif">Rendered from architecture review output</text></svg> : <div className="rounded-lg border border-dashed border-[#262626] bg-black px-6 py-16 text-center text-sm text-zinc-500">Architecture output is not available yet. Complete Q&A generation to populate the graph.</div>}</div></div><div className="space-y-6"><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-4 text-[10px] font-bold uppercase tracking-widest text-zinc-500">Monthly Estimate</div><div className="text-3xl font-semibold text-zinc-100">${costEstimate.total.toFixed(2)}</div><div className="mt-2 text-xs text-zinc-500">Budget cap: ${costEstimate.cap.toFixed(2)}</div></div><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-4 text-[10px] font-bold uppercase tracking-widest text-zinc-500">Q&A Context</div><div className="text-xs leading-relaxed text-zinc-400">{qaSummary ? <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-zinc-400">{qaSummary}</pre> : 'Waiting for deployment answers.'}</div></div><button onClick={() => setAndPersistStage('approval')} className="w-full rounded-md bg-zinc-100 py-3 text-sm font-semibold text-black hover:bg-white">Review & Approve</button></div></div>{architectureCostRows.length > 0 && <div className="overflow-hidden rounded-lg border border-[#1A1A1A] bg-[#050505]"><div className="border-b border-[#1A1A1A] px-5 py-4 text-sm font-semibold text-zinc-100">Cost Breakdown</div><table className="w-full text-sm"><thead><tr className="border-b border-[#1A1A1A] text-left text-[11px] uppercase tracking-widest text-zinc-500"><th className="px-5 py-3">Service</th><th className="px-5 py-3">Type</th><th className="px-5 py-3">Monthly</th><th className="px-5 py-3">Notes</th></tr></thead><tbody>{architectureCostRows.map((row, index) => <tr key={`${row.service}-${index}`} className="border-b border-[#111111] last:border-0"><td className="px-5 py-3 text-zinc-200">{row.service}</td><td className="px-5 py-3 text-zinc-400">{row.type}</td><td className="px-5 py-3 font-mono text-zinc-200">${row.monthly.toFixed(2)}</td><td className="px-5 py-3 text-zinc-500">{row.note || '-'}</td></tr>)}<tr className="bg-black/60"><td className="px-5 py-3 font-semibold text-zinc-100">Total</td><td className="px-5 py-3" /><td className="px-5 py-3 font-mono font-semibold text-zinc-100">${costEstimate.total.toFixed(2)}</td><td className="px-5 py-3" /></tr></tbody></table></div>}</div>}
          {activeStage === 'approval' && <div className="mx-auto max-w-3xl space-y-6"><div className="mt-4 mb-8 border-b border-[#1A1A1A] pb-6"><h1 className="mb-2 text-2xl font-semibold text-zinc-100">Sign-off</h1><p className="text-sm text-zinc-400">Review deployment contract before generating infrastructure code.</p></div><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-6 rounded-md border border-[#1A1A1A] bg-black p-4"><label className="flex items-start gap-3"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} className="mt-1 h-4 w-4 rounded border-[#4B5563] bg-[#111111] text-indigo-600" /><span className="text-sm leading-relaxed text-zinc-400">I approve the architectural design and estimated runtime costs. Proceed with generating Terraform configurations.</span></label></div><button disabled={!approved} onClick={() => { setAndPersistStage('terraform'); void generateTerraform().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'IaC generation failed.')); }} className="w-full rounded-md bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:bg-[#111111] disabled:text-zinc-500">Approve & Generate IaC</button></div></div>}
          {activeStage === 'terraform' && (
            <div className="mx-auto flex max-w-6xl flex-col gap-6">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Terraform Output</h1>
                  <p className="text-sm text-zinc-400">Live Terraform agent activity streams over the pipeline websocket, and generated files stay editable before deploy.</p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => void generateTerraform().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'IaC generation failed.'))}
                    disabled={terraformGenerating}
                    className="rounded-md border border-[#262626] bg-[#111111] px-5 py-2 text-sm font-semibold text-zinc-200 hover:bg-[#181818] disabled:bg-[#111111] disabled:text-zinc-500"
                  >
                    {terraformGenerating ? 'Generating...' : 'Regenerate'}
                  </button>
                  <button
                    onClick={() => void createIacPr()}
                    disabled={terraformGenerating || iacPrCreating || deployableIacFiles.length === 0 || Boolean(iacPrUrl)}
                    className="rounded-md border border-cyan-500/20 bg-cyan-500/10 px-5 py-2 text-sm font-semibold text-cyan-200 hover:bg-cyan-500/20 disabled:border-[#262626] disabled:bg-[#111111] disabled:text-zinc-500"
                  >
                    {iacPrUrl ? 'PR ready' : iacPrCreating ? 'Creating PR...' : 'Create PR'}
                  </button>
                  {iacPrUrl ? (
                    <button
                      onClick={() => window.open(iacPrUrl, '_blank', 'noopener,noreferrer')}
                      className="flex items-center gap-2 rounded-md border border-[#262626] bg-[#111111] px-5 py-2 text-sm font-semibold text-zinc-200 hover:bg-[#181818]"
                    >
                      <ExternalLink className="h-4 w-4" />
                      Open PR
                    </button>
                  ) : null}
                  <button
                    onClick={() => setAndPersistStage('aws_config')}
                    disabled={!activeSavedRun && iacFiles.length === 0}
                    className="rounded-md bg-zinc-100 px-5 py-2 text-sm font-semibold text-black hover:bg-white disabled:bg-[#111111] disabled:text-zinc-500"
                  >
                    Continue to Config
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-6">
                <div className="space-y-6">
                  <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-5">
                    <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500">Terraform Agent</div>
                    <div className="text-sm text-zinc-200">{terraformRunLabel}</div>
                    <div className="mt-3 space-y-2 text-xs text-zinc-500">
                      <div>Run ID: <span className="font-mono text-zinc-300">{shouldUseSavedRunForDeploy ? activeSavedRun?.run_id : (hasCurrentIacMeta ? 'bundle-only' : 'pending')}</span></div>
                      <div>Workspace: <span className="font-mono text-zinc-300">{(shouldUseSavedRunForDeploy ? activeSavedRun?.workspace : savedIacMeta?.workspace) || 'pending'}</span></div>
                      <div>Files: <span className="font-mono text-zinc-300">{iacFiles.length}</span></div>
                      <div>WS: <span className={`font-mono ${deploySocketState === 'connected' ? 'text-emerald-400' : deploySocketState === 'connecting' ? 'text-cyan-400' : deploySocketState === 'error' ? 'text-amber-400' : 'text-zinc-300'}`}>{deploySocketState}</span></div>
                      <div>Editor: <span className="font-mono text-zinc-300">live buffer</span></div>
                    </div>
                    {sessionIacTruncated ? (
                      <div className="mt-4 rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
                        This cached IaC preview is truncated. Regenerate before creating a PR.
                      </div>
                    ) : null}
                    {iacPrUrl ? (
                      <div className="mt-4 rounded-md border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-300">
                        IaC PR is ready for review.
                      </div>
                    ) : null}
                  </div>
                  <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-5">
                    <div className="mb-3 text-[10px] font-bold uppercase tracking-widest text-zinc-500">Workers</div>
                    <div className="space-y-2 text-xs">
                      {terraformWorkerStates.length > 0 ? terraformWorkerStates.map((worker) => (
                        <div key={worker.worker_id} className="rounded-md border border-[#1A1A1A] bg-black px-3 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="font-medium text-zinc-200">{worker.worker_role || worker.worker_id}</div>
                              <div className="font-mono text-[11px] text-zinc-500">{worker.worker_id}</div>
                            </div>
                            <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${
                              worker.worker_status === 'completed'
                                ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                                : worker.worker_status === 'failed'
                                  ? 'border-red-500/20 bg-red-500/10 text-red-300'
                                  : 'border-cyan-500/20 bg-cyan-500/10 text-cyan-300'
                            }`}>
                              {worker.worker_status || 'running'}
                            </span>
                          </div>
                        </div>
                      )) : (
                        <div className="text-zinc-500">Worker states will appear once generation starts.</div>
                      )}
                    </div>
                  </div>
                  <div className="flex h-80 flex-col overflow-hidden rounded-lg border border-[#1A1A1A] bg-[#050505]">
                    <div className="flex items-center justify-between border-b border-[#1A1A1A] bg-black px-4 py-2.5 font-mono text-xs text-zinc-500">
                      <div className="flex items-center gap-2">
                        <Terminal className="h-4 w-4 text-zinc-400" />
                        Terraform agent feed
                      </div>
                      <div>{terraformGenerationLogs.length} events</div>
                    </div>
                    <div className="custom-scrollbar flex-1 overflow-y-auto bg-black p-4 font-mono text-[12px]">
                      {terraformGenerationLogs.length > 0 ? terraformGenerationLogs.slice(-40).map((log, index) => (
                        <div key={`${log.ts}-${index}`} className="mb-2 flex gap-3">
                          <span className="shrink-0 text-zinc-600">{String(index + 1).padStart(2, '0')}</span>
                          <div className="min-w-0">
                            <div className="mb-1 flex flex-wrap items-center gap-2">
                              {log.worker_id && <span className="rounded border border-[#262626] bg-[#111111] px-2 py-0.5 text-[10px] uppercase tracking-widest text-zinc-400">{log.worker_id}</span>}
                              {log.worker_status && <span className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-widest ${
                                log.worker_status === 'completed'
                                  ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                                  : log.worker_status === 'failed'
                                    ? 'border-red-500/20 bg-red-500/10 text-red-300'
                                    : 'border-cyan-500/20 bg-cyan-500/10 text-cyan-300'
                              }`}>{log.worker_status}</span>}
                              {log.model && <span className="font-mono text-[10px] text-zinc-600">{log.model}</span>}
                            </div>
                            <div className={log.type === 'success' ? 'font-medium text-emerald-400' : log.type === 'error' ? 'text-red-400' : 'text-zinc-300'}>{log.text}</div>
                          </div>
                        </div>
                      )) : (
                        <div className="text-zinc-500">{iacFiles.length > 0 ? 'Cached Terraform files were loaded without live run metadata. Regenerating will repopulate worker events here.' : 'Start Terraform generation to watch the sub-agent phases here.'}</div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="col-span-2 flex gap-6">
                  <div className="custom-scrollbar h-130 w-64 shrink-0 overflow-y-auto rounded-lg border border-[#1A1A1A] bg-[#050505] p-3 text-sm">
                    {iacFiles.map((file) => (
                      <button
                        key={file.path}
                        onClick={() => setSelectedFile(file.path)}
                        className={`mb-2 block w-full rounded px-2 py-1 text-left ${activeIacFilePath === file.path ? 'bg-[#111111] text-zinc-200' : 'text-zinc-300 hover:bg-[#111111]'}`}
                      >
                        {file.path}
                      </button>
                    ))}
                  </div>
                  <div className="flex h-130 flex-1 flex-col rounded-lg border border-[#1A1A1A] bg-[#050505]">
                    <div className="flex items-center justify-between border-b border-[#1A1A1A] bg-black px-4 py-2.5">
                      <div className="font-mono text-[11px] text-zinc-400">{activeIacFilePath || 'Generated files'}</div>
                      <div className="text-[11px] uppercase tracking-widest text-zinc-500">Editable</div>
                    </div>
                    <textarea
                      value={(iacFiles.find((file) => file.path === activeIacFilePath) || iacFiles[0])?.content || ''}
                      onChange={(event) => {
                        if (!activeIacFilePath) return;
                        updateIacFileContent(activeIacFilePath, event.target.value);
                      }}
                      disabled={!activeIacFilePath}
                      placeholder="Generate Terraform to view and edit files."
                      spellCheck={false}
                      className="custom-scrollbar flex-1 resize-none bg-[#050505] p-5 font-mono text-[13px] leading-relaxed text-zinc-300 outline-none"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
          {activeStage === 'aws_config' && (
            <div className="mx-auto max-w-5xl space-y-6">
              <div className="mt-4 mb-6 border-b border-[#1A1A1A] pb-6">
                <h1 className="mb-2 text-2xl font-semibold text-zinc-100">AWS Configuration</h1>
                <p className="text-sm text-zinc-400">Provide deploy-time credentials and confirm the Terraform runtime inputs.</p>
              </div>
              <div className="grid grid-cols-3 gap-6">
                <div className="col-span-2 space-y-6 rounded-lg border border-[#1A1A1A] bg-[#050505] p-6">
                  <div className="space-y-4">
                    <input value={aws.aws_access_key_id} onChange={(event) => setAws((prev) => ({ ...prev, aws_access_key_id: event.target.value }))} placeholder="AWS_ACCESS_KEY_ID" className="w-full rounded-md border border-[#262626] bg-black px-4 py-2.5 font-mono text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none" />
                    <input type="password" value={aws.aws_secret_access_key} onChange={(event) => setAws((prev) => ({ ...prev, aws_secret_access_key: event.target.value }))} placeholder="AWS_SECRET_ACCESS_KEY" className="w-full rounded-md border border-[#262626] bg-black px-4 py-2.5 font-mono text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none" />
                    <input value={aws.aws_region} onChange={(event) => setAws((prev) => ({ ...prev, aws_region: event.target.value }))} placeholder="AWS_REGION" className="w-full rounded-md border border-[#262626] bg-black px-4 py-2.5 font-mono text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none" />
                  </div>
                  <button onClick={() => setAndPersistStage('deploy')} disabled={!hasAwsSecrets || (!activeSavedRun && deployableIacFiles.length === 0)} className="flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 py-3 font-semibold text-white hover:bg-indigo-500 disabled:bg-[#111111] disabled:text-zinc-500">
                    <Rocket className="h-4 w-4" /> Continue to Deploy
                  </button>
                </div>
                <div className="space-y-4 rounded-lg border border-[#1A1A1A] bg-[#050505] p-6">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Runtime Inputs</div>
                    <div className="mt-3 space-y-2 text-xs text-zinc-400">
                      <div>Terraform source: <span className="font-mono text-zinc-200">{shouldUseSavedRunForDeploy ? 'saved run' : 'session files'}</span></div>
                      <div>Workspace: <span className="font-mono text-zinc-200">{shouldUseSavedRunForDeploy ? (activeSavedRun?.workspace || 'pending') : 'local session'}</span></div>
                      <div>Estimated monthly cost: <span className="font-mono text-zinc-200">${costEstimate.total.toFixed(2)}</span></div>
                      <div>Budget cap: <span className="font-mono text-zinc-200">${costEstimate.cap.toFixed(2)}</span></div>
                    </div>
                  </div>
                  <div className={`rounded-md border px-3 py-2 text-xs ${hasAwsSecrets ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/20 bg-amber-500/10 text-amber-300'}`}>
                    {hasAwsSecrets ? 'AWS credentials ready for runtime apply.' : 'Enter AWS credentials to unlock deployment.'}
                  </div>
                  {sessionIacTruncated && !activeSavedRun && (
                    <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                      Session-cached Terraform files are truncated preview data and cannot be deployed. Regenerate Terraform to produce a fresh bundle.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          {activeStage === 'deploy' && <div className="mx-auto max-w-5xl space-y-6"><div className="mb-2 flex items-center justify-between"><div><h1 className="text-2xl font-semibold text-zinc-100">{deployStatus === 'done' ? 'Deployment Complete' : deployStatus === 'running' ? 'Deployment In Progress' : deployStatus === 'error' ? 'Deployment Failed' : 'Ready to Deploy'}</h1><p className="mt-1 text-sm text-zinc-400">Live deployment console backed by pipeline WebSocket events and backend status reconciliation.</p></div><div className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-widest ${deploySocketState === 'connected' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400' : deploySocketState === 'connecting' ? 'border-cyan-500/20 bg-cyan-500/10 text-cyan-400' : deploySocketState === 'error' ? 'border-amber-500/20 bg-amber-500/10 text-amber-400' : 'border-zinc-700 bg-[#111111] text-zinc-500'}`}>WS {deploySocketState}</div></div><div className="grid grid-cols-3 gap-6"><div className="col-span-2 flex h-125 flex-col overflow-hidden rounded-lg border border-[#1A1A1A] bg-[#050505]"><div className="flex items-center justify-between border-b border-[#1A1A1A] bg-black px-4 py-2.5 font-mono text-xs text-zinc-500"><div className="flex items-center gap-2"><Terminal className="h-4 w-4 text-zinc-400" /> STDOUT</div><div>{deployLogs.length} events</div></div><div className="custom-scrollbar flex-1 overflow-y-auto bg-black p-6 font-mono text-[13px]">{deployLogs.map((log, index) => <div key={`${log.ts}-${index}`} className="mb-1 flex gap-4"><span className="shrink-0 text-zinc-600">{String(index + 1).padStart(2, '0')}</span><span className={log.type === 'success' ? 'font-medium text-emerald-400' : log.type === 'error' ? 'text-red-400' : 'text-zinc-300'}>{log.text}</span></div>)}<div ref={logEndRef} /></div></div><div className="space-y-4 rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div><div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Execution</div><div className="mt-3 text-3xl font-semibold text-zinc-100">{deployProgress}%</div><div className="mt-2 h-2 overflow-hidden rounded-full bg-[#111111]"><div className={`h-full rounded-full ${deployStatus === 'done' ? 'bg-emerald-500' : deployStatus === 'error' ? 'bg-red-500' : 'bg-indigo-500'}`} style={{ width: `${deployProgress}%` }} /></div><div className="mt-3 text-xs text-zinc-500">Status: <span className="font-mono text-zinc-300">{deployStatus}</span></div></div>{costEstimate.total > costEstimate.cap && <div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200"><div className="font-semibold text-amber-300">Budget guardrail</div><div className="mt-1">Estimated monthly cost ${costEstimate.total.toFixed(2)} exceeds cap ${costEstimate.cap.toFixed(2)}.</div><label className="mt-3 flex items-start gap-3 text-left"><input type="checkbox" checked={budgetOverride} onChange={(event) => setBudgetOverride(event.target.checked)} disabled={deployStatus === 'running'} className="mt-0.5 h-4 w-4 rounded border-[#3f3f46] bg-black text-indigo-500 focus:ring-indigo-500/40" /><span><span className="block font-medium text-amber-100">Override budget guardrail for this deploy</span><span className="mt-1 block text-[11px] text-amber-200/80">Use only when you intentionally approve costs above the configured cap.</span></span></label></div>}<div className="space-y-3"><button onClick={() => void startDeploy()} disabled={deployStatus === 'running'} className="flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-6 py-2.5 font-semibold text-white hover:bg-indigo-500 disabled:bg-[#111111] disabled:text-zinc-500"><Rocket className="h-4 w-4" /> {deployStatus === 'done' ? 'Re-run Deploy' : 'Start Deploy'}</button><button onClick={() => void stopDeployment()} disabled={deployStatus !== 'running' || stopLoading} className="w-full rounded-md border border-red-500/20 bg-red-500/10 px-6 py-2.5 font-semibold text-red-300 hover:bg-red-500/20 disabled:border-[#262626] disabled:bg-[#111111] disabled:text-zinc-500">{stopLoading ? 'Stopping...' : 'Stop Deployment'}</button><button onClick={() => void reconcileDeploymentStatus().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Failed to reconcile deployment status.'))} className="w-full rounded-md border border-[#262626] bg-[#111111] px-6 py-2.5 font-semibold text-zinc-300 hover:bg-[#181818]">Reconcile Backend Status</button>{deployStatus !== 'running' && deployResult && <button onClick={() => setAndPersistStage('outputs')} className="flex w-full items-center justify-center gap-2 rounded-md bg-zinc-100 px-6 py-2.5 font-semibold text-black hover:bg-white">{deployStatus === 'error' ? 'View Results' : 'View Outputs'} <ArrowRight className="h-4 w-4" /></button>}</div></div></div></div>}
          {activeStage === 'outputs' && <div className="mx-auto max-w-5xl space-y-6"><div className="mt-4 mb-8 border-b border-[#1A1A1A] pb-6"><div className={`mb-4 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-bold uppercase ${outputBannerClassName}`}><CheckCircle2 className="h-3.5 w-3.5" /> {outputBanner.label}</div><h1 className="mb-2 text-2xl font-semibold text-zinc-100">{outputBanner.title}</h1><p className="text-sm text-zinc-400">{outputBanner.description}</p>{backendErrorMessage && <div className="mt-4 rounded-md border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-300">{backendErrorMessage}</div>}{!backendErrorMessage && !hasLiveRuntimeDetails && deployResult?.success && <div className="mt-4 rounded-md border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200">Live runtime details are missing for this repo. Fetch the latest runtime details to hydrate outputs before treating this deploy as successful.</div>}</div><div className="grid grid-cols-2 gap-6"><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-6 text-[10px] font-bold uppercase text-zinc-500">Security</div><div className="flex gap-2"><button onClick={() => deploySummary.generatedPem && downloadTextFile(`${deploySummary.keyName}.pem`, deploySummary.generatedPem.endsWith('\n') ? deploySummary.generatedPem : `${deploySummary.generatedPem}\n`)} disabled={!deploySummary.generatedPem} className="flex flex-1 items-center justify-center gap-2 rounded-md border border-[#262626] bg-[#111111] py-2 text-[12px] font-medium text-zinc-200 hover:bg-[#1A1A1A] disabled:cursor-not-allowed disabled:text-zinc-500"><Download className="h-4 w-4" /> Download .PEM</button><button onClick={() => void downloadPpk().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'PPK conversion failed.'))} disabled={!deploySummary.generatedPem} className="flex flex-1 items-center justify-center gap-2 rounded-md border border-[#262626] bg-[#111111] py-2 text-[12px] font-medium text-zinc-200 hover:bg-[#1A1A1A] disabled:cursor-not-allowed disabled:text-zinc-500"><Download className="h-4 w-4" /> Download .PPK</button></div>{!deploySummary.generatedPem && <div className="mt-4 rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">{keyPairDownloadMessage}</div>}</div><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-4 text-[10px] font-bold uppercase text-zinc-500">Endpoints</div><div className="space-y-3 text-sm"><div className="flex justify-between"><span className="text-zinc-400">Public IP</span><span className="font-mono text-zinc-200">{deploySummary.publicIp}</span></div><div className="flex justify-between"><span className="text-zinc-400">Instance</span><span className="font-mono text-zinc-200">{deploySummary.instanceId}</span></div><div className="flex justify-between"><span className="text-zinc-400">CloudFront</span><div className="flex items-center gap-2"><span className="font-mono text-zinc-200">{deploySummary.cloudfrontUrl}</span>{canOpenCloudfront && <button onClick={() => window.open(deploySummary.cloudfrontUrl.startsWith('http') ? deploySummary.cloudfrontUrl : `https://${deploySummary.cloudfrontUrl}`, '_blank', 'noopener,noreferrer')} className="text-zinc-500 hover:text-zinc-200"><ExternalLink className="h-4 w-4" /></button>}</div></div><div className="flex justify-between"><span className="text-zinc-400">Verification</span><span className={`font-medium ${outputBanner.tone === 'success' ? 'text-emerald-400' : outputBanner.tone === 'error' ? 'text-red-300' : 'text-amber-300'}`}>{outputBanner.label}</span></div></div></div></div><div className="flex gap-3"><button onClick={() => void fetchRuntimeDetails().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Failed to fetch runtime details.'))} disabled={!canFetchRuntimeDetails} className="flex items-center gap-2 rounded-md border border-[#262626] bg-[#111111] px-4 py-2 text-sm font-semibold text-zinc-300 hover:bg-[#181818] disabled:border-[#262626] disabled:bg-[#111111] disabled:text-zinc-500"><RefreshCw className="h-4 w-4" /> Fetch Latest Runtime Details</button><button onClick={() => void verifyLiveEndpoints()} disabled={verifyLoading || !canVerifyLiveEndpoints} className="flex items-center gap-2 rounded-md border border-cyan-500/20 bg-cyan-500/10 px-4 py-2 text-sm font-semibold text-cyan-200 hover:bg-cyan-500/20 disabled:border-[#262626] disabled:bg-[#111111] disabled:text-zinc-500"><ExternalLink className="h-4 w-4" /> {verifyLoading ? 'Verifying...' : 'Verify Live Endpoints'}</button><button onClick={() => void destroyDeployment().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Destroy failed.'))} disabled={destroyLoading || !hasAwsSecrets} className="flex items-center gap-2 rounded-md border border-red-500/20 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/20 disabled:border-[#262626] disabled:bg-[#111111] disabled:text-zinc-500"><Server className="h-4 w-4" /> {destroyLoading ? 'Destroying...' : 'Destroy Infrastructure'}</button></div><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><h3 className="mb-4 text-sm font-semibold text-zinc-200">Endpoint Verification</h3>{effectiveEndpointChecks.length > 0 ? <div className="space-y-3">{effectiveEndpointChecks.map((check) => <div key={`${check.label}-${check.url || 'empty'}`} className="rounded-md border border-[#1A1A1A] bg-black p-4"><div className="flex items-center justify-between"><div><div className="text-sm font-medium text-zinc-200">{check.label}</div><div className="mt-1 font-mono text-[11px] text-zinc-500">{check.url || 'n/a'}</div></div><span className={`rounded border px-2.5 py-1 text-[11px] font-medium ${check.ok ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400' : 'border-red-500/20 bg-red-500/10 text-red-300'}`}>{check.ok ? `HTTP ${check.status ?? 200}` : (check.status ? `HTTP ${check.status}` : 'Unreachable')}</span></div><div className="mt-3 text-xs leading-relaxed text-zinc-400">{check.detail}</div></div>)}</div> : <div className="rounded-md border border-dashed border-[#262626] bg-black px-4 py-6 text-sm text-zinc-500">{canVerifyLiveEndpoints ? 'No live verification has been recorded yet. Run `Verify Live Endpoints` to test the deployed URLs.' : 'Verification is unavailable until the current repo has a successful deploy payload and live runtime details.'}</div>}</div><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><h3 className="mb-4 text-sm font-semibold text-zinc-200">Deployment History</h3><div className="space-y-3">{deploymentHistory.map((entry) => <div key={entry.id} className="rounded-md border border-[#1A1A1A] bg-black p-4"><div className="flex items-center justify-between"><div><p className="text-sm font-medium text-zinc-200">{new Date(entry.createdAt).toLocaleString()}</p><p className="mt-1 font-mono text-[11px] text-zinc-400">EC2: {entry.instanceId}</p></div><span className={`rounded border px-2.5 py-1 text-[11px] font-medium ${entry.status === 'done' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400' : 'border-red-500/20 bg-red-500/10 text-red-400'}`}>{entry.status === 'done' ? 'Success' : 'Error'}</span></div></div>)}</div></div></div>}
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: `.custom-scrollbar::-webkit-scrollbar{width:6px}.custom-scrollbar::-webkit-scrollbar-track{background:transparent}.custom-scrollbar::-webkit-scrollbar-thumb{background-color:#262626;border-radius:10px}.custom-scrollbar::-webkit-scrollbar-thumb:hover{background-color:#3f3f46}` }} />
    </div>
  );
}

