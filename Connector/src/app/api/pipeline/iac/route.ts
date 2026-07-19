import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { validateTerraformArchitectureInput } from '@/lib/deployment-planning-contract';
import { type RepoPersistenceResult } from '@/lib/iac-pr';
import {
  resolveProjectMeta,
  resolveProjectSourceRoot as resolveSharedProjectSourceRoot,
} from '@/lib/project-meta';
import fs from 'fs';
import path from 'path';

type Provider = 'aws' | 'azure' | 'gcp';
type IacMode = 'deterministic' | 'llm';
type TerraformRenderer = 'auto' | 'deplai_deterministic' | 'deplai_ec2_app';

interface ScanResultsData {
  supply_chain?: Array<{ cve_id?: string; severity?: string; fix_version?: string }>;
  code_security?: Array<{ cwe_id?: string; severity?: string; count?: number }>;
}

interface IacGenerateBody {
  project_id: string;
  provider?: Provider;
  iac_mode?: IacMode;
  budget_cap_usd?: number;
  qa_summary?: string;
  architecture_context?: string;
  repository_context?: Record<string, unknown>;
  deployment_profile?: Record<string, unknown>;
  approval_payload?: Record<string, unknown>;
  // Required in LLM-only IaC mode: full architecture JSON
  architecture_json?: Record<string, unknown>;
  security_context?: Record<string, unknown>;
  website_asset_stats?: Record<string, unknown>;
  frontend_entrypoint_detection?: Record<string, unknown>;
  // Optional: OpenAI key forwarded to the IaC generator
  openai_api_key?: string;
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_region?: string;
  workspace?: string;
  state_bucket?: string;
  lock_table?: string;
  refresh_docs?: boolean;
  llm_provider?: string;
  llm_api_key?: string;
  llm_model?: string;
  llm_api_base_url?: string;
  terraform_renderer?: string;
  user_answers?: Record<string, unknown>;
  consultant_action?: 'start' | 'reply' | 'force_decision';
  consultant_history?: Array<{ role?: string; content?: string }>;
  consultant_turn_count?: number;
  consultant_decision?: Record<string, unknown>;
}

interface GeneratedFile {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
}

function classifyAgenticRouteError(err: unknown, action: string): { message: string; status: number } {
  const raw = err instanceof Error ? err.message : String(err || 'unknown upstream error');
  const lowered = raw.toLowerCase();
  if (
    lowered.includes('fetch failed') ||
    lowered.includes('aborted') ||
    lowered.includes('timeout') ||
    lowered.includes('econnrefused') ||
    lowered.includes('enotfound') ||
    lowered.includes('network')
  ) {
    const targets = getAgenticBaseUrls().join(', ');
    return {
      message: `Agentic Layer is unavailable while trying to ${action}. Checked: ${targets}.`,
      status: 502,
    };
  }
  return {
    message: raw || `${action} failed.`,
    status: 500,
  };
}

function normalizeAgenticBaseUrl(raw: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return 'http://127.0.0.1:8000';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

function getAgenticBaseUrls(): string[] {
  const primary = normalizeAgenticBaseUrl(AGENTIC_URL);
  const urls: string[] = [primary];
  try {
    const parsed = new URL(primary);
    if (parsed.hostname === 'localhost') {
      const alt = new URL(primary);
      alt.hostname = '127.0.0.1';
      urls.push(alt.toString().replace(/\/+$/, ''));
    } else if (parsed.hostname === '127.0.0.1') {
      const alt = new URL(primary);
      alt.hostname = 'localhost';
      urls.push(alt.toString().replace(/\/+$/, ''));
    }
  } catch {
    // Keep primary URL only when parsing fails.
  }
  return Array.from(new Set(urls));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchAgentic(
  path: string,
  init: RequestInit,
  options?: {
    timeoutMs?: number;
    retriesPerUrl?: number;
    retryDelayMs?: number;
  },
): Promise<Response> {
  const timeoutMs = Number(options?.timeoutMs || 30_000);
  const retriesPerUrl = Math.max(1, Number(options?.retriesPerUrl || 2));
  const retryDelayMs = Math.max(100, Number(options?.retryDelayMs || 900));
  const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
  const errors: string[] = [];

  for (const baseUrl of getAgenticBaseUrls()) {
    const requestUrl = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    for (let attempt = 1; attempt <= retriesPerUrl; attempt += 1) {
      try {
        const response = await fetch(requestUrl, {
          ...init,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!retryableStatuses.has(response.status) || attempt >= retriesPerUrl) {
          return response;
        }

        errors.push(`${requestUrl} -> HTTP ${response.status}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err || 'unknown fetch error');
        errors.push(`${requestUrl} -> ${reason}`);
      }

      if (attempt < retriesPerUrl) {
        await sleep(retryDelayMs * attempt);
      }
    }
  }

  const compact = errors.filter(Boolean).slice(0, 6).join(' | ');
  throw new Error(`fetch failed${compact ? ` (${compact})` : ''}`);
}

const INDEX_HTML_CANDIDATES = [
  'index.html',
  'public/index.html',
  'src/index.html',
  'dist/index.html',
  'build/index.html',
];

const WEBSITE_ROOT_CANDIDATES = [
  'dist',
  'build',
  'out',
  'public',
  'site',
  'website',
  'frontend/dist',
  'frontend/build',
  'frontend/public',
  'web/dist',
  'web/build',
  'web/public',
  'client/dist',
  'client/build',
  'client/public',
  'app/dist',
  'app/build',
  'app/public',
];

interface WebsiteAsset {
  relativePath: string;
  contentBase64: string;
}

interface WebsiteAssetCollection {
  assets: WebsiteAsset[];
  selectedRoot: string;
  totalBytes: number;
  truncated: boolean;
  skippedLargeFiles: number;
}

interface WebsiteEntrypointSelection {
  relativePath: string | null;
  sourceRelativePath: string | null;
  html: string | null;
  reason: string;
}

interface FrontendEntrypointDetection {
  runtime: 'node' | 'python' | 'unknown';
  framework: 'nextjs' | 'vite' | 'react' | 'vue' | 'svelte' | 'unknown';
  entry_candidates: string[];
  build_command: string | null;
  has_build_output: boolean;
  detected: boolean;
}

interface RepoDetectionSummary {
  [key: string]: unknown;
  language: string;
  framework: string;
  has_database: boolean;
  database_type: string;
  has_web_server: boolean;
  has_workers: boolean;
  has_static_assets: boolean;
  has_dockerfile: boolean;
  has_redis: boolean;
  has_queue: boolean;
}

const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  '.next',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  '.terraform',
  '.cache',
  'coverage',
  'tmp',
]);

const SKIP_FILE_NAMES = new Set([
  '.ds_store',
  'thumbs.db',
]);

const MAX_SITE_FILES = 2500;
const MAX_SITE_FILE_BYTES = 8_000_000;
const MAX_SITE_TOTAL_BYTES = 20_000_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => asRecord(item))
    .filter(item => Object.keys(item).length > 0);
}

function readText(value: unknown): string {
  return String(value || '').trim();
}

const EC2_INSTANCE_TYPES = ['t3.micro', 't3.small', 't3.medium', 't3.large'] as const;
const DEFAULT_EC2_CONFIG = {
  instance_type: 't3.micro',
  root_volume_size_gb: 35,
  app_port: 3000,
  ssh_ingress_cidr_blocks: [] as string[],
};

function clampInteger(value: unknown, defaultValue: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeCidrList(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  return Array.from(new Set(
    rawItems
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .filter((item) => /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(item)),
  ));
}

function normalizeEc2ResourceConfig(value: unknown): typeof DEFAULT_EC2_CONFIG {
  const record = asRecord(value);
  const requestedInstanceType = String(record.instance_type || '').trim().toLowerCase();
  return {
    instance_type: EC2_INSTANCE_TYPES.includes(requestedInstanceType as typeof EC2_INSTANCE_TYPES[number])
      ? requestedInstanceType
      : DEFAULT_EC2_CONFIG.instance_type,
    root_volume_size_gb: clampInteger(record.root_volume_size_gb, DEFAULT_EC2_CONFIG.root_volume_size_gb, 20, 200),
    app_port: clampInteger(record.app_port, DEFAULT_EC2_CONFIG.app_port, 1, 65535),
    ssh_ingress_cidr_blocks: normalizeCidrList(record.ssh_ingress_cidr_blocks),
  };
}

function ec2ConfigFromUserAnswers(userAnswers: Record<string, unknown>): typeof DEFAULT_EC2_CONFIG {
  return normalizeEc2ResourceConfig({
    ...DEFAULT_EC2_CONFIG,
    ...asRecord(userAnswers.ec2_resource_config),
    ...asRecord(userAnswers.ec2),
    instance_type: userAnswers.instance_type || userAnswers.ec2_instance_type || userAnswers.compute_instance_type,
    root_volume_size_gb: userAnswers.root_volume_size_gb || userAnswers.ec2_root_volume_size_gb,
    app_port: userAnswers.app_port,
    ssh_ingress_cidr_blocks: userAnswers.ssh_ingress_cidr_blocks,
  });
}

function patchEc2ConfigFromText(config: typeof DEFAULT_EC2_CONFIG, text: string): typeof DEFAULT_EC2_CONFIG {
  const lower = String(text || '').toLowerCase();
  const patch: Record<string, unknown> = {};
  const instanceMatch = lower.match(/\bt3\.(micro|small|medium|large)\b/);
  if (instanceMatch) patch.instance_type = `t3.${instanceMatch[1]}`;

  const diskMatch = lower.match(/\b(?:disk|volume|root(?:\s+volume)?)\D{0,16}(\d{1,3})\s*(?:gb|gib)?\b/);
  if (diskMatch) patch.root_volume_size_gb = Number(diskMatch[1]);

  const portMatch = lower.match(/\b(?:port|app\s+port)\D{0,10}(\d{1,5})\b/);
  if (portMatch) patch.app_port = Number(portMatch[1]);

  const cidrs = normalizeCidrList(lower.match(/\b(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}\b/g) || []);
  if (cidrs.length > 0 && /\bssh\b/.test(lower)) patch.ssh_ingress_cidr_blocks = cidrs;

  return normalizeEc2ResourceConfig({ ...config, ...patch });
}

function normalizeConsultantDecisionEc2(
  decisionInput: Record<string, unknown>,
  userAnswers: Record<string, unknown> = {},
  latestUserText = '',
): Record<string, unknown> {
  const decision = asRecord(decisionInput);
  const stackConfig = asRecord(decision.stack_config);
  const components = Array.isArray(decision.components)
    ? decision.components.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const deploySequence = Array.isArray(decision.deploy_sequence)
    ? decision.deploy_sequence.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const normalizedComponents = components.map((item) => String(item).trim().toLowerCase() === 'ec2-instance' ? 'ec2' : item);
  const normalizedSequence = deploySequence.map((item) => String(item).trim().toLowerCase() === 'ec2-instance' ? 'ec2' : item);
  const hasEc2Stack = Object.prototype.hasOwnProperty.call(stackConfig, 'ec2') || Object.prototype.hasOwnProperty.call(stackConfig, 'ec2-instance');
  const hasEc2Intent = hasEc2Stack
    || normalizedComponents.includes('ec2')
    || normalizedSequence.includes('ec2')
    || String(userAnswers.service_type || '').trim().toLowerCase() === 'ec2'
    || String(userAnswers.deployment_plan || '').trim().toLowerCase() === 'ec2'
    || (normalizedComponents.length === 0 && normalizedSequence.length === 0);
  const normalizedStackConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stackConfig)) {
    if (String(key).trim().toLowerCase() === 'ec2-instance') continue;
    normalizedStackConfig[key] = value;
  }

  if (hasEc2Intent) {
    const mergedEc2 = {
      ...DEFAULT_EC2_CONFIG,
      ...ec2ConfigFromUserAnswers(userAnswers),
      ...asRecord(stackConfig['ec2-instance']),
      ...asRecord(stackConfig.ec2),
    };
    const ec2 = patchEc2ConfigFromText(normalizeEc2ResourceConfig(mergedEc2), latestUserText);
    normalizedStackConfig.ec2 = {
      ...asRecord(normalizedStackConfig.ec2),
      ...ec2,
    };
  }

  const finalComponents = Array.from(new Set(normalizedComponents.length ? normalizedComponents : (hasEc2Intent ? ['ec2'] : [])));
  const finalSequence = Array.from(new Set(normalizedSequence.length ? normalizedSequence : finalComponents));

  return {
    ...decision,
    components: finalComponents,
    deploy_sequence: finalSequence,
    stack_config: normalizedStackConfig,
  };
}

function latestUserMessage(history: Array<{ role?: string; content?: string }> | undefined): string {
  if (!Array.isArray(history)) return '';
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (String(item?.role || '').trim().toLowerCase() === 'user') {
      return String(item?.content || '').trim();
    }
  }
  return '';
}

function readBoolLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'true' || normalized === 'yes' || normalized === 'y') return true;
  if (normalized === 'false' || normalized === 'no' || normalized === 'n') return false;
  return null;
}

function inferRepositoryDetection(params: {
  architectureJson: Record<string, unknown>;
  frontendDetection: FrontendEntrypointDetection | null;
  repositoryContext: Record<string, unknown> | null;
}): RepoDetectionSummary {
  const architecture = asRecord(params.architectureJson);
  const metadata = asRecord(architecture.metadata);
  const repositoryContext = asRecord(params.repositoryContext);
  const repoLanguage = asRecord(repositoryContext.language);
  const frameworks = asRecords(repositoryContext.frameworks);
  const repoBuild = asRecord(repositoryContext.build);
  const repoFrontend = asRecord(repositoryContext.frontend);
  const nodes = asRecords(architecture.nodes);

  const nodeCorpus = nodes
    .map((node) => {
      const type = readText(node.type).toLowerCase();
      const label = readText(node.label).toLowerCase();
      const attrs = JSON.stringify(asRecord(node.attributes)).toLowerCase();
      return `${type} ${label} ${attrs}`;
    })
    .join('\n');

  const compute = asRecord(architecture.compute);
  const services = asRecords(compute.services);
  const dataLayer = asRecords(architecture.data_layer);

  const language =
    readText(repoLanguage.primary)
    || readText(repoLanguage.detected)
    || readText(metadata.language)
    || (params.frontendDetection?.runtime === 'node' ? 'javascript' : params.frontendDetection?.runtime === 'python' ? 'python' : '')
    || 'unknown';

  // Treat 'unknown' from frontendDetection as absent so repo scanner frameworks take priority
  const frontendFramework = readText(params.frontendDetection?.framework);
  const framework =
    (frontendFramework && frontendFramework !== 'unknown' ? frontendFramework : '')
    || readText(frameworks[0]?.name)
    || readText(repoFrontend.framework)
    || readText(metadata.framework)
    || 'unknown';

  // Combine data_layer (architecture diagram) + data_stores (Python scanner) for broad coverage
  const repoDataStores = asRecords(repositoryContext.data_stores);
  const dataTypes = [
    ...dataLayer.map(item => readText(item.type).toLowerCase()),
    ...repoDataStores.map(ds => readText(ds.type).toLowerCase()),
  ].filter(Boolean);

  // nodeHas searches architecture node corpus only (not the full repo context to avoid false positives)
  const nodeHas = (re: RegExp) => re.test(nodeCorpus);

  // repoContextHas scans the Python scanner output for additional signals
  const repoContextStr = JSON.stringify(repositoryContext).toLowerCase();
  const repoHas = (re: RegExp) => re.test(repoContextStr);

  const hasRedis =
    dataTypes.includes('redis')
    || nodeHas(/redis|elasticache/)
    || repoHas(/redis|elasticache/);

  const databaseType =
    dataTypes.find((t) => ['postgres', 'postgresql', 'mysql', 'mariadb', 'mongodb', 'dynamodb'].includes(t))
    || (nodeHas(/postgres|rds/) || repoHas(/psycopg2|sqlalchemy|postgresql|database_url/) ? 'postgres'
      : nodeHas(/mysql|mariadb/) || repoHas(/mysql|mariadb/) ? 'mysql'
        : nodeHas(/mongodb|documentdb/) || repoHas(/mongodb|mongoose/) ? 'mongodb'
          : nodeHas(/dynamodb/) || repoHas(/dynamodb/) ? 'dynamodb'
            : 'unknown');
  const hasDatabase = databaseType !== 'unknown';

  const hasWebServer =
    services.some((service) => readText(service.process_type).toLowerCase() === 'web')
    || asRecords(repositoryContext.processes).some(p => readText(p.type).toLowerCase() === 'web')
    || nodeHas(/alb|load[_ -]?balancer|api[_ -]?gateway|web|nginx|ecs|ec2|fargate|service/);

  const hasWorkers =
    services.some((service) => readText(service.process_type).toLowerCase() === 'worker')
    || asRecords(repositoryContext.processes).some(p => readText(p.type).toLowerCase() === 'worker')
    || nodeHas(/worker|celery|sidekiq|consumer|batch|cron|job/)
    || repoHas(/"celery"|"sidekiq"|"rq"/);

  const hasStaticAssets =
    Boolean(params.frontendDetection?.has_build_output)
    || nodeHas(/cloudfront|static|cdn|s3/)
    || readText(repoBuild.output_dir).length > 0
    || readText(asRecord(repositoryContext.build).output_dir).length > 0;

  const hasDockerfile =
    readBoolLike(repoBuild.has_dockerfile) === true
    || readBoolLike(asRecord(repositoryContext.build).has_dockerfile) === true
    || readBoolLike(metadata.has_dockerfile) === true
    || readText(repoBuild.dockerfile_path).length > 0
    || readText(asRecord(repositoryContext.build).dockerfile_path).length > 0
    || readBoolLike(asRecord(repositoryContext.infrastructure_hints).existing_compose) === true;

  const hasQueue =
    nodeHas(/queue|sqs|rabbitmq|kafka|pubsub/)
    || dataTypes.some(t => ['rabbitmq', 'kafka'].includes(t))
    || repoHas(/"rabbitmq"|"kafka"|"sqs"|"pubsub"/);


  return {
    language: language.toLowerCase(),
    framework: framework.toLowerCase(),
    has_database: hasDatabase,
    database_type: databaseType.toLowerCase(),
    has_web_server: hasWebServer,
    has_workers: hasWorkers,
    has_static_assets: hasStaticAssets,
    has_dockerfile: hasDockerfile,
    has_redis: hasRedis,
    has_queue: hasQueue,
  };
}

function summarizeConsultantDecision(
  decisionInput: Record<string, unknown>,
  detected: RepoDetectionSummary,
  awsRegion: string,
): string {
  const decision = asRecord(decisionInput);
  const components = Array.isArray(decision.components)
    ? decision.components.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const deploySequence = Array.isArray(decision.deploy_sequence)
    ? decision.deploy_sequence.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const stackConfig = asRecord(decision.stack_config);
  const notes = Array.isArray(decision.consultant_notes)
    ? decision.consultant_notes.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  const lines: string[] = [];
  lines.push(`AWS region: ${awsRegion || 'unknown'}`);
  lines.push(`Components: ${components.join(', ') || 'none'}`);
  lines.push(`Deploy order: ${deploySequence.join(' -> ') || 'none'}`);

  const ecs = asRecord(stackConfig.ecs);
  if (Object.keys(ecs).length > 0) {
    lines.push(
      `ECS: desired=${String(ecs.desired_count || '?')}, min=${String(ecs.min_count || '?')}, max=${String(ecs.max_count || '?')}, cpu=${String(ecs.cpu || '?')}, memory=${String(ecs.memory || '?')}`,
    );
  }

  const rds = asRecord(stackConfig.rds);
  if (Object.keys(rds).length > 0) {
    lines.push(
      `RDS: ${String(rds.engine || 'db')} ${String(rds.instance_class || '').trim() || ''}`.trim()
      + `, multi-AZ=${String(Boolean(rds.multi_az))}, backups=${String(rds.backup_retention_period || 0)} day(s)`,
    );
  } else if (detected.has_database) {
    lines.push('Database: repo indicates a datastore, but no DB component was selected.');
  }

  const elasticache = asRecord(stackConfig.elasticache);
  if (Object.keys(elasticache).length > 0) {
    lines.push(`Cache: ${String(elasticache.engine || 'redis')} ${String(elasticache.node_type || '').trim() || ''}`.trim());
  } else if (detected.has_redis) {
    lines.push('Cache: repo indicates Redis, but no cache component was selected.');
  }

  const ec2 = asRecord(stackConfig.ec2 || stackConfig['ec2-instance']);
  if (Object.keys(ec2).length > 0) {
    const ec2Config = normalizeEc2ResourceConfig(ec2);
    lines.push(`EC2: ${ec2Config.instance_type}, root=${ec2Config.root_volume_size_gb}GB, app_port=${ec2Config.app_port}`);
  }

  if (components.includes('s3_cloudfront')) {
    lines.push(detected.has_static_assets ? 'CDN/static hosting is included.' : 'CloudFront/static hosting is included.');
  }

  if (notes.length > 0) {
    lines.push(`Notes: ${notes.join(' | ')}`);
  }

  return lines.join('\n');
}

function buildRepoDetectionSummaryText(detected: RepoDetectionSummary): string {
  const database = detected.has_database
    ? `${detected.database_type || 'database'} required`
    : 'not detected';
  const computeStrategy = detected.has_static_assets && !detected.has_web_server
    ? 's3-cloudfront'
    : detected.has_dockerfile
      ? 'ecs-fargate'
      : 'ec2-instance';
  return [
    `Language: ${detected.language || 'unknown'}`,
    `Framework: ${detected.framework || 'unknown'}`,
    `Compute strategy: ${computeStrategy}`,
    `Database: ${database}`,
    `Redis/cache: ${detected.has_redis ? 'required' : 'not detected'}`,
    `Workers: ${detected.has_workers ? 'detected' : 'not detected'}`,
    `Static assets: ${detected.has_static_assets ? 'detected' : 'not detected'}`,
    `Dockerfile: ${detected.has_dockerfile ? 'detected' : 'not detected'}`,
    `Queue: ${detected.has_queue ? 'detected' : 'not detected'}`,
  ].join('\n');
}

function buildDeterministicConsultantDecision(params: {
  detected: RepoDetectionSummary;
  deploymentProfile: Record<string, unknown> | null;
  userAnswers: Record<string, unknown>;
  awsRegion: string;
}): Record<string, unknown> {
  const deployment = asRecord(params.deploymentProfile);
  const compute = asRecord(deployment.compute);
  const services = asRecords(compute.services);
  const primaryService = services[0] || {};
  const dataLayer = asRecords(deployment.data_layer);
  const userAnswers = asRecord(params.userAnswers);
  const ec2Config = normalizeEc2ResourceConfig({
    ...ec2ConfigFromUserAnswers(userAnswers),
    app_port: userAnswers.app_port || primaryService.port || DEFAULT_EC2_CONFIG.app_port,
  });
  const hasRds = params.detected.has_database || dataLayer.some((item) => {
    const type = String(item.type || '').trim().toLowerCase();
    return ['postgresql', 'postgres', 'mysql', 'mariadb'].includes(type);
  });
  const hasRedis = params.detected.has_redis || dataLayer.some((item) => String(item.type || '').trim().toLowerCase() === 'redis');
  const databaseType = String(params.detected.database_type || '').trim().toLowerCase();
  const databaseEngine = ['mysql', 'mariadb'].includes(databaseType) ? databaseType : 'postgres';
  const components = ['ec2'];
  if (hasRds) components.push('rds');
  if (hasRedis) components.push('elasticache');

  const stackConfig: Record<string, unknown> = {
    ec2: {
      ...ec2Config,
      aws_region: params.awsRegion || 'eu-north-1',
      public_http: true,
      ssh_access: ec2Config.ssh_ingress_cidr_blocks.length > 0,
      security_group_rules: [
        { type: 'ingress', from_port: 80, to_port: 80, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'] },
        { type: 'ingress', from_port: 443, to_port: 443, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'] },
        ...(ec2Config.ssh_ingress_cidr_blocks.length > 0
          ? [{ type: 'ingress', from_port: 22, to_port: 22, protocol: 'tcp', cidr_blocks: ec2Config.ssh_ingress_cidr_blocks }]
          : []),
        { type: 'egress', from_port: 0, to_port: 0, protocol: '-1', cidr_blocks: ['0.0.0.0/0'] },
      ],
    },
  };

  if (hasRds) {
    stackConfig.rds = {
      engine: databaseEngine,
      engine_version: databaseEngine === 'mysql' ? '8.0' : databaseEngine === 'mariadb' ? '10.11' : '15.10',
      instance_class: 'db.t3.micro',
      multi_az: false,
      backup_retention_period: 7,
      deletion_protection: false,
      publicly_accessible: false,
    };
  }

  if (hasRedis) {
    stackConfig.elasticache = {
      engine: 'redis',
      node_type: 'cache.t4g.micro',
    };
  }

  return {
    components,
    deploy_sequence: [...components],
    stack_config: stackConfig,
    outputs_to_capture: [
      'ec2_instance_id',
      'ec2_public_ip',
      'ec2_public_dns',
      'ec2_key_name',
      'generated_ec2_private_key_pem',
      ...(hasRds ? ['rds_endpoint'] : []),
      ...(hasRedis ? ['redis_endpoint'] : []),
    ],
    consultant_notes: [
      'Deterministic consultant fallback selected an EC2-first runtime deploy plan.',
      params.detected.has_static_assets
        ? 'Static assets were detected, but the first-success deploy path serves them from EC2/nginx.'
        : 'No static asset bundle was required for the infrastructure decision.',
      params.detected.has_workers
        ? 'Worker processes were detected; run them on the EC2 host until a dedicated queue/worker tier is explicitly added.'
        : 'No dedicated worker tier was detected.',
    ],
  };
}

function buildDeterministicConsultantMessage(params: {
  decision: Record<string, unknown>;
  detected: RepoDetectionSummary;
  awsRegion: string;
  fallbackReason?: string;
}): string {
  const reason = String(params.fallbackReason || '').trim();
  return [
    reason ? `I could not use the live consultant response (${reason}), so I generated a deterministic deployment decision from the repository analysis.` : 'I generated a deterministic deployment decision from the repository analysis.',
    '',
    summarizeConsultantDecision(params.decision, params.detected, params.awsRegion),
    '',
    'Review this plan. Choose Build this to continue, or ask for a change if you want a different component set.',
  ].join('\n');
}

function defaultWebsiteHtml(projectName: string, hintMessage?: string): string {
  const safeHint = String(hintMessage || '').trim();
  const hintBlock = safeHint
    ? `<p style="margin-top: 1rem; color: #555;">${safeHint}</p>`
    : '';
  return `<html>
  <head><title>DeplAI Deployment</title></head>
  <body style="font-family: Arial, sans-serif; padding: 2rem;">
    <h1>DeplAI deployment is live</h1>
    <p>Project: ${projectName}</p>
    ${hintBlock}
  </body>
</html>`;
}

function normalizeProjectPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function normalizeRepoWritePath(filePath: string): string {
  const normalized = normalizeProjectPath(filePath || '');
  if (!normalized || normalized.includes('..')) return '';
  return normalized;
}

function normalizeWebsiteObjectKey(relPath: string): string {
  const normalized = normalizeProjectPath(relPath);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return normalized;
  const leaf = String(parts[parts.length - 1] || '').toLowerCase();
  // Common typo in uploaded repos: index.html.html -> index.html
  if (leaf === 'index.html.html') {
    parts[parts.length - 1] = 'index.html';
    return parts.join('/');
  }
  return normalized;
}

function shouldSkipSourceEntry(relativePath: string, isDirectory: boolean): boolean {
  const normalized = normalizeProjectPath(relativePath);
  if (!normalized) return false;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.some(part => part === '.git')) return true;
  if (parts.some(part => SKIP_DIR_NAMES.has(part))) return true;

  const leaf = String(parts[parts.length - 1] || '').toLowerCase();
  if (!isDirectory && SKIP_FILE_NAMES.has(leaf)) return true;

  // Never mirror local secret files into public website assets.
  if (!isDirectory && (leaf === '.env' || leaf.startsWith('.env.'))) return true;
  return false;
}

function pathExistsAsDirectory(rootPath: string, relPath: string): boolean {
  const normalized = normalizeProjectPath(relPath);
  const absolute = path.join(rootPath, ...normalized.split('/').filter(Boolean));
  try {
    return fs.statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}

function pathExistsAsFile(rootPath: string, relPath: string): boolean {
  const normalized = normalizeProjectPath(relPath);
  const absolute = path.join(rootPath, ...normalized.split('/').filter(Boolean));
  try {
    return fs.statSync(absolute).isFile();
  } catch {
    return false;
  }
}

function hasHtmlAsset(assets: WebsiteAsset[]): boolean {
  return assets.some((asset) => /\.(html?|xhtml)$/i.test(asset.relativePath));
}

function hasPreferredIndexAsset(assets: WebsiteAsset[]): boolean {
  if (!assets.length) return false;
  const byKey = new Set(
    assets.map((asset) => normalizeWebsiteObjectKey(asset.relativePath).toLowerCase()),
  );
  return INDEX_HTML_CANDIDATES.some((candidate) => byKey.has(normalizeProjectPath(candidate).toLowerCase()));
}

function listWebsiteRootCandidates(rootPath: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();

  const add = (root: string) => {
    const normalized = normalizeProjectPath(root);
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    if (normalized && !pathExistsAsDirectory(rootPath, normalized)) return;
    roots.push(normalized);
    seen.add(key);
  };

  for (const root of WEBSITE_ROOT_CANDIDATES) {
    add(root);
  }

  for (const htmlCandidate of INDEX_HTML_CANDIDATES) {
    if (!pathExistsAsFile(rootPath, htmlCandidate)) continue;
    const dir = normalizeProjectPath(path.posix.dirname(htmlCandidate));
    add(dir === '.' ? '' : dir);
  }

  add('');
  return roots;
}

function collectWebsiteAssetsForRoot(rootPath: string, sourceRoot: string): WebsiteAssetCollection {
  const normalizedSource = normalizeProjectPath(sourceRoot);
  const assets: WebsiteAsset[] = [];
  const pending: string[] = [normalizedSource];
  let totalBytes = 0;
  let truncated = false;
  let skippedLargeFiles = 0;

  if (normalizedSource && !pathExistsAsDirectory(rootPath, normalizedSource)) {
    return {
      assets,
      selectedRoot: normalizedSource,
      totalBytes,
      truncated,
      skippedLargeFiles,
    };
  }

  let stop = false;

  while (pending.length > 0 && !stop) {
    const relativeDir = pending.pop() || '';
    const absoluteDir = path.join(rootPath, ...relativeDir.split('/').filter(Boolean));

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const relativePath = normalizeProjectPath(relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
      if (!relativePath) continue;
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (shouldSkipSourceEntry(relativePath, true)) continue;
        pending.push(relativePath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (shouldSkipSourceEntry(relativePath, false)) continue;

      const filePath = path.join(rootPath, ...relativePath.split('/'));
      const buffer = fs.readFileSync(filePath);

      if (buffer.length > MAX_SITE_FILE_BYTES) {
        skippedLargeFiles += 1;
        continue;
      }

      if (assets.length >= MAX_SITE_FILES) {
        truncated = true;
        stop = true;
        break;
      }

      if (totalBytes + buffer.length > MAX_SITE_TOTAL_BYTES) {
        truncated = true;
        stop = true;
        break;
      }

      totalBytes += buffer.length;

      assets.push({
        relativePath,
        contentBase64: buffer.toString('base64'),
      });
    }
  }

  assets.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return {
    assets,
    selectedRoot: normalizedSource,
    totalBytes,
    truncated,
    skippedLargeFiles,
  };
}

function collectWebsiteAssets(rootPath: string): WebsiteAssetCollection {
  const empty: WebsiteAssetCollection = {
    assets: [],
    selectedRoot: '',
    totalBytes: 0,
    truncated: false,
    skippedLargeFiles: 0,
  };

  const rootCandidates = listWebsiteRootCandidates(rootPath);
  if (!rootCandidates.length) return empty;

  const collected = rootCandidates.map((candidate) => collectWebsiteAssetsForRoot(rootPath, candidate));
  const withPreferredIndex = collected.find((item) => hasPreferredIndexAsset(item.assets));
  if (withPreferredIndex) return withPreferredIndex;

  const withHtml = collected.find((item) => hasHtmlAsset(item.assets));
  if (withHtml) return withHtml;

  const withAssets = collected.find((item) => item.selectedRoot !== '' && item.assets.length > 0);
  return withAssets || empty;
}

function parsePackageJson(rootPath: string): Record<string, unknown> | null {
  const packageJsonPath = path.join(rootPath, 'package.json');
  try {
    if (!fs.existsSync(packageJsonPath)) return null;
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function detectFrontendEntrypoint(rootPath: string): FrontendEntrypointDetection {
  const packageJson = parsePackageJson(rootPath);
  const deps = packageJson && typeof packageJson === 'object'
    ? {
      ...((packageJson.dependencies as Record<string, unknown>) || {}),
      ...((packageJson.devDependencies as Record<string, unknown>) || {}),
    }
    : {};
  const depKeys = new Set(Object.keys(deps).map((k) => String(k || '').toLowerCase()));
  const scripts = packageJson && typeof packageJson === 'object'
    ? ((packageJson.scripts as Record<string, unknown>) || {})
    : {};
  const buildCommand = typeof scripts.build === 'string'
    ? String(scripts.build).trim()
    : null;

  let framework: FrontendEntrypointDetection['framework'] = 'unknown';
  if (depKeys.has('next')) framework = 'nextjs';
  else if (depKeys.has('vite')) framework = 'vite';
  else if (depKeys.has('react')) framework = 'react';
  else if (depKeys.has('vue')) framework = 'vue';
  else if (depKeys.has('svelte')) framework = 'svelte';

  const runtime: FrontendEntrypointDetection['runtime'] =
    depKeys.size > 0 || packageJson ? 'node' : 'unknown';

  const candidatePool: string[] = [];
  if (framework === 'nextjs') {
    candidatePool.push(
      'src/app/page.tsx',
      'src/app/page.jsx',
      'app/page.tsx',
      'app/page.jsx',
      'pages/index.tsx',
      'pages/index.jsx',
      'pages/index.js',
    );
  } else if (framework === 'vite' || framework === 'react' || framework === 'vue' || framework === 'svelte') {
    candidatePool.push(
      'index.html',
      'public/index.html',
      'src/main.tsx',
      'src/main.jsx',
      'src/main.ts',
      'src/main.js',
      'src/index.tsx',
      'src/index.jsx',
      'src/index.ts',
      'src/index.js',
      'index.tsx',
      'index.jsx',
      'index.ts',
      'index.js',
    );
  } else {
    candidatePool.push(
      'index.html',
      'public/index.html',
      'src/index.html',
      'src/index.jsx',
      'src/index.tsx',
      'index.jsx',
      'index.tsx',
      'index.js',
      'index.ts',
    );
  }

  const foundCandidates = candidatePool
    .filter((candidate) => pathExistsAsFile(rootPath, candidate))
    .map((candidate) => normalizeProjectPath(candidate));

  const hasBuildOutput = ['dist', 'build', 'out', '.next']
    .some((dir) => pathExistsAsDirectory(rootPath, dir));

  return {
    runtime,
    framework,
    entry_candidates: foundCandidates,
    build_command: buildCommand,
    has_build_output: hasBuildOutput,
    detected: foundCandidates.length > 0 || framework !== 'unknown',
  };
}

function buildFrontendFallbackHint(projectName: string, detection: FrontendEntrypointDetection | null): string {
  if (!detection || !detection.detected) return '';
  const topCandidate = detection.entry_candidates[0] || '';
  const buildHint = detection.build_command
    ? `Run build command '${detection.build_command}' and upload the built assets (for example dist/build/out).`
    : 'Build the frontend and upload compiled static assets (for example dist/build/out).';
  if (topCandidate) {
    return `Detected source entrypoint '${topCandidate}' for ${projectName}. ${buildHint}`;
  }
  return `Detected ${detection.framework} frontend source for ${projectName}. ${buildHint}`;
}

function decodeAssetContent(asset: WebsiteAsset | null | undefined): string {
  if (!asset) return '';
  return Buffer.from(asset.contentBase64, 'base64').toString('utf-8');
}

function resolvePrimaryWebsiteHtmlFromAssets(assets: WebsiteAsset[]): WebsiteEntrypointSelection {
  if (!assets.length) {
    return {
      relativePath: null,
      sourceRelativePath: null,
      html: null,
      reason: 'no assets were available',
    };
  }

  const lookup = new Map<string, WebsiteAsset>();
  for (const asset of assets) {
    lookup.set(normalizeWebsiteObjectKey(asset.relativePath), asset);
  }

  for (const candidate of INDEX_HTML_CANDIDATES) {
    const hit = lookup.get(normalizeProjectPath(candidate));
    if (!hit) continue;
    const decoded = decodeAssetContent(hit);
    if (decoded.trim()) {
      const normalizedPath = normalizeWebsiteObjectKey(hit.relativePath);
      return {
        relativePath: normalizedPath,
        sourceRelativePath: hit.relativePath,
        html: decoded,
        reason: `matched preferred candidate (${candidate})`,
      };
    }
  }

  let best: { asset: WebsiteAsset; score: number } | null = null;
  for (const asset of assets) {
    const normalized = normalizeWebsiteObjectKey(asset.relativePath).toLowerCase();
    if (!/\.(html?|xhtml)$/.test(normalized)) continue;

    const parts = normalized.split('/').filter(Boolean);
    const leaf = String(parts[parts.length - 1] || '');
    let score = 0.55;

    if (leaf === 'index.html') score += 0.2;
    if (parts.length === 1) score += 0.12;
    if (normalized.includes('/dist/') || normalized.startsWith('dist/')) score += 0.08;
    if (normalized.includes('/build/') || normalized.startsWith('build/')) score += 0.08;
    if (/(home|main|app|default)\.html?$/.test(leaf)) score += 0.12;
    if (normalized.includes('/templates/') || normalized.startsWith('templates/')) score -= 0.08;
    if (normalized.includes('/views/') || normalized.startsWith('views/')) score -= 0.05;

    if (!best || score > best.score) {
      best = { asset, score };
    }
  }

  const fallbackDecoded = decodeAssetContent(best?.asset);
  if (best && fallbackDecoded.trim()) {
    const normalizedPath = normalizeWebsiteObjectKey(best.asset.relativePath);
    return {
      relativePath: normalizedPath,
      sourceRelativePath: best.asset.relativePath,
      html: fallbackDecoded,
      reason: 'selected highest-scoring HTML candidate',
    };
  }

  return {
    relativePath: null,
    sourceRelativePath: null,
    html: null,
    reason: 'no non-empty HTML file detected in collected assets',
  };
}

interface ProjectSourceRoots {
  connectorRoot: string;
  agenticRoot: string;
  repositoryUrl: string | null;
}

async function resolveProjectSourceRoots(
  userId: string,
  projectId: string,
): Promise<ProjectSourceRoots | null> {
  const connectorRoot = await resolveSharedProjectSourceRoot(userId, projectId);
  if (!connectorRoot) return null;

  const meta = await resolveProjectMeta(userId, projectId);
  if (meta?.project_type === 'github' && meta.repo_full_name) {
    const [owner, repo] = meta.repo_full_name.split('/');
    if (owner && repo) {
      return {
        connectorRoot,
        agenticRoot: `/repos/${owner}/${repo}`,
        repositoryUrl: `https://github.com/${owner}/${repo}.git`,
      };
    }
  }

  if (meta?.project_type === 'local') {
    return {
      connectorRoot,
      agenticRoot: `/local-projects/${userId}/${projectId}`,
      repositoryUrl: null,
    };
  }

  return {
    connectorRoot,
    agenticRoot: connectorRoot,
    repositoryUrl: null,
  };
}

function clampProvider(value: string | undefined): Provider {
  const v = (value || '').trim().toLowerCase();
  if (v === 'azure' || v === 'gcp') return v;
  return 'aws';
}

function clampIacMode(value: string | undefined): IacMode {
  return String(value || '').trim().toLowerCase() === 'llm' ? 'llm' : 'deterministic';
}

function clampTerraformRenderer(value: string | undefined): TerraformRenderer {
  const renderer = String(value || '').trim().toLowerCase();
  if (renderer === 'deplai_ec2_app') return 'deplai_ec2_app';
  if (renderer === 'deplai_deterministic') return 'deplai_deterministic';
  if (renderer === 'auto') return 'auto';
  return 'auto';
}

function isAllowedGeneratedIacPath(safePath: string): boolean {
  return (
    safePath.startsWith('terraform/')
    || safePath.startsWith('ansible/')
    || safePath === 'README.md'
  );
}

function dedupeGeneratedFiles(files: GeneratedFile[]): GeneratedFile[] {
  const byPath = new Map<string, GeneratedFile>();
  for (const file of files) {
    const safePath = normalizeRepoWritePath(file.path);
    if (!safePath) continue;
    if (!isAllowedGeneratedIacPath(safePath)) continue;
    const content = String(file.content || '');
    if (!content) continue;
    if (content.length > 12_000_000) continue;
    byPath.set(safePath, {
      path: safePath,
      content,
      encoding: file.encoding === 'base64' ? 'base64' : 'utf-8',
    });
    if (byPath.size >= 300) break;
  }
  return Array.from(byPath.values());
}

function hasRequiredAwsCoreFiles(files: GeneratedFile[]): boolean {
  const required = new Set([
    'terraform/providers.tf',
    'terraform/backend.tf',
    'terraform/main.tf',
    'terraform/variables.tf',
    'terraform/terraform.tfvars',
    'terraform/outputs.tf',
  ]);

  for (const file of files) {
    required.delete(normalizeRepoWritePath(file.path));
    if (required.size === 0) return true;
  }
  return required.size === 0;
}

function validateAwsTerraformBundle(files: GeneratedFile[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!hasRequiredAwsCoreFiles(files)) {
    errors.push('bundle is missing one or more required Terraform root files');
  }

  const tfFiles = files.filter((file) => normalizeRepoWritePath(file.path).endsWith('.tf'));
  const byPath = new Map<string, string>();
  for (const file of tfFiles) {
    byPath.set(normalizeRepoWritePath(file.path), String(file.content || ''));
  }

  const versionsTf = byPath.get('terraform/versions.tf') || '';
  const providersTf = byPath.get('terraform/providers.tf') || '';
  if (/provider\s+"aws"/.test(versionsTf) && /provider\s+"aws"/.test(providersTf)) {
    errors.push('terraform/versions.tf duplicates the default aws provider configuration');
  }

  const singleLineVariableBlock = /variable\s+"[^"]+"\s*\{\s*type\s*=\s*[^{}\n]+,\s*default\s*=\s*[^{}\n]+\s*\}/;
  const conditionalDependsOn = /depends_on\s*=\s*[^\n]*\?/;
  const bundleHasAwsRegionVar = tfFiles.some((file) => /variable\s+"aws_region"\s*\{/.test(String(file.content || '')));
  const bundleHasRegionVar = tfFiles.some((file) => /variable\s+"region"\s*\{/.test(String(file.content || '')));
  for (const file of tfFiles) {
    const relPath = normalizeRepoWritePath(file.path);
    const content = String(file.content || '');
    if (/variable\s+"(?:desired_log_group_name|log_group_override)"\s*\{\{/.test(content)) {
      errors.push(`${relPath} contains malformed double-brace variable block syntax`);
    }
    if (singleLineVariableBlock.test(content)) {
      errors.push(`${relPath} contains invalid single-line variable block syntax`);
    }
    if (conditionalDependsOn.test(content)) {
      errors.push(`${relPath} contains conditional depends_on syntax Terraform does not accept`);
    }
    if (bundleHasAwsRegionVar && !bundleHasRegionVar && /var\.region\b/.test(content)) {
      errors.push(`${relPath} references var.region even though only aws_region is declared`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function mergeGeneratedFiles(primary: GeneratedFile[], secondary: GeneratedFile[]): GeneratedFile[] {
  const merged = new Map<string, GeneratedFile>();
  for (const file of dedupeGeneratedFiles(primary)) {
    merged.set(file.path, file);
  }
  for (const file of dedupeGeneratedFiles(secondary)) {
    merged.set(file.path, file);
  }
  return Array.from(merged.values());
}

async function generateIacBundleWithTerraformAgent(params: {
  projectId: string;
  projectName: string;
  workspace: string;
  provider: Provider;
  iacMode: IacMode;
  architectureJson: Record<string, unknown>;
  deploymentProfile?: Record<string, unknown> | null;
  approvalPayload?: Record<string, unknown> | null;
  repositoryContext?: Record<string, unknown> | null;
  awsRegion: string;
  stateBucket?: string;
  lockTable?: string;
  qaSummary: string;
  websiteIndexHtml: string;
  securityContext?: Record<string, unknown> | null;
  websiteAssetStats?: Record<string, unknown> | null;
  frontendEntrypointDetection?: Record<string, unknown> | null;
  detected?: Record<string, unknown> | null;
  userAnswers?: Record<string, unknown> | null;
  consultantDecision?: Record<string, unknown> | null;
  terraformRenderer?: TerraformRenderer;
  sourceRoot?: string | null;
  sourceRootCandidates?: string[];
  repositoryUrl?: string | null;
  llmProvider?: string | null;
  llmApiKey?: string | null;
  llmModel?: string | null;
  llmApiBaseUrl?: string | null;
}): Promise<{
  files: GeneratedFile[];
  source: string;
  summary: string;
  warnings: string[];
  runId: string | null;
  workspace: string | null;
  providerVersion: string | null;
  stateBucket: string | null;
  lockTable: string | null;
  manifest: unknown[];
  dagOrder: string[];
  details: Record<string, unknown> | null;
  requestedRenderer: string | null;
  actualRenderer: string | null;
  unsupportedReason: string | null;
  componentCatalogVersion: string | null;
  executionKind: string | null;
  llmIacCalls: number;
  llmIacDisabled: boolean;
  deploymentPackageId: string | null;
  decisionApplied: boolean;
  decisionDrift: Array<{
    component: string;
    key: string;
    expected: unknown;
    got: unknown;
  }>;
}> {
  const response = await fetchAgentic('/api/terraform/generate', {
    method: 'POST',
    headers: {
      ...agenticHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      project_id: params.projectId,
      provider: params.provider,
      project_name: params.projectName,
      workspace: params.workspace,
      iac_mode: params.iacMode,
      architecture_json: params.architectureJson,
      deployment_profile: params.deploymentProfile || undefined,
      approval_payload: params.approvalPayload || undefined,
      repository_context: params.repositoryContext || undefined,
      aws_region: params.awsRegion,
      state_bucket: params.stateBucket || '',
      lock_table: params.lockTable || '',
      qa_summary: params.qaSummary,
      security_context: params.securityContext || undefined,
      website_asset_stats: params.websiteAssetStats || undefined,
      frontend_entrypoint_detection: params.frontendEntrypointDetection || undefined,
      detected: params.detected || undefined,
      user_answers: params.userAnswers || undefined,
      consultant_decision: params.consultantDecision || undefined,
      terraform_renderer: params.terraformRenderer || 'auto',
      llm_provider: params.llmProvider || undefined,
      llm_api_key: params.llmApiKey || undefined,
      llm_model: params.llmModel || undefined,
      llm_api_base_url: params.llmApiBaseUrl || undefined,
      website_index_html: params.websiteIndexHtml,
      source_root: params.sourceRoot || undefined,
      source_root_candidates: params.sourceRootCandidates || undefined,
      repository_url: params.repositoryUrl || undefined,
    }),
  }, {
    timeoutMs: 600_000,
    retriesPerUrl: 2,
    retryDelayMs: 1_200,
  });
  const rawBody = await response.clone().text().catch(() => '');

  const data = await response.json().catch(() => ({})) as {
    success?: boolean;
    files?: GeneratedFile[];
    warnings?: string[];
    source?: string;
    error?: string;
    detail?: string;
    details?: unknown;
    run_id?: string | null;
    workspace?: string | null;
    provider_version?: string | null;
    state_bucket?: string | null;
    lock_table?: string | null;
    manifest?: unknown[];
    dag_order?: string[];
    requested_renderer?: string | null;
    actual_renderer?: string | null;
    unsupported_reason?: string | null;
    component_catalog_version?: string | null;
    execution_kind?: string | null;
    llm_iac_calls?: number;
    llm_iac_disabled?: boolean;
    deployment_package_id?: string | null;
    decision_applied?: boolean;
    decision_drift?: Array<{
      component?: unknown;
      key?: unknown;
      expected?: unknown;
      got?: unknown;
    }>;
  };

  if (!response.ok || !data.success) {
    const detailText = typeof data.details === 'string'
      ? data.details
      : data.details && typeof data.details === 'object'
        ? JSON.stringify(data.details)
        : '';
    const compactRaw = String(rawBody || '').replace(/\s+/g, ' ').trim();
    const nonHtmlRaw = compactRaw && !compactRaw.startsWith('<!DOCTYPE') ? compactRaw.slice(0, 320) : '';
    const resolvedError = String(data.error || data.detail || detailText || nonHtmlRaw || '').trim();
    throw new Error(resolvedError || `Terraform agent generation failed (HTTP ${response.status}).`);
  }

  const files = dedupeGeneratedFiles(Array.isArray(data.files) ? data.files : []);
  return {
    files,
    source: String(data.source || 'terraform_agent'),
    summary: `Generated ${files.length} files through the Terraform Agent.`,
    warnings: Array.isArray(data.warnings) ? data.warnings.map((item) => String(item)) : [],
    runId: typeof data.run_id === 'string' ? data.run_id : null,
    workspace: typeof data.workspace === 'string' ? data.workspace : null,
    providerVersion: typeof data.provider_version === 'string' ? data.provider_version : null,
    stateBucket: typeof data.state_bucket === 'string' ? data.state_bucket : null,
    lockTable: typeof data.lock_table === 'string' ? data.lock_table : null,
    manifest: Array.isArray(data.manifest) ? data.manifest : [],
    dagOrder: Array.isArray(data.dag_order) ? data.dag_order.map((item) => String(item)) : [],
    details: data.details && typeof data.details === 'object' ? data.details as Record<string, unknown> : null,
    requestedRenderer: typeof data.requested_renderer === 'string' ? data.requested_renderer : null,
    actualRenderer: typeof data.actual_renderer === 'string' ? data.actual_renderer : null,
    unsupportedReason: typeof data.unsupported_reason === 'string' ? data.unsupported_reason : null,
    componentCatalogVersion: typeof data.component_catalog_version === 'string' ? data.component_catalog_version : null,
    executionKind: typeof data.execution_kind === 'string' ? data.execution_kind : null,
    llmIacCalls: Number.isFinite(Number(data.llm_iac_calls)) ? Number(data.llm_iac_calls) : 0,
    llmIacDisabled: data.llm_iac_disabled !== false,
    deploymentPackageId: typeof data.deployment_package_id === 'string' ? data.deployment_package_id : null,
    decisionApplied: data.decision_applied === true,
    decisionDrift: Array.isArray(data.decision_drift)
      ? data.decision_drift
        .map((item) => ({
          component: String(item?.component || '').trim(),
          key: String(item?.key || '').trim(),
          expected: item?.expected,
          got: item?.got,
        }))
        .filter((item) => item.component.length > 0 && item.key.length > 0)
      : [],
  };
}

function summarizeSecurity(data: ScanResultsData): {
  totalCodeFindings: number;
  totalSupplyFindings: number;
  criticalOrHighSupply: number;
  highCwe: string[];
} {
  const supply = Array.isArray(data.supply_chain) ? data.supply_chain : [];
  const code = Array.isArray(data.code_security) ? data.code_security : [];

  const totalCodeFindings = code.reduce((n, item) => n + Number(item.count || 0), 0);
  const totalSupplyFindings = supply.length;
  const criticalOrHighSupply = supply.filter(item => {
    const sev = String(item.severity || '').toLowerCase();
    return sev === 'critical' || sev === 'high';
  }).length;

  const highCwe = code
    .filter(item => {
      const sev = String(item.severity || '').toLowerCase();
      return sev === 'critical' || sev === 'high';
    })
    .map(item => String(item.cwe_id || '').trim())
    .filter(Boolean)
    .slice(0, 10);

  return { totalCodeFindings, totalSupplyFindings, criticalOrHighSupply, highCwe };
}

function buildWebsiteSiteFiles(siteAssets: WebsiteAsset[], siteIndexHtml: string): GeneratedFile[] {
  const byKey = new Map<string, WebsiteAsset>();
  for (const asset of siteAssets) {
    const key = normalizeWebsiteObjectKey(asset.relativePath);
    if (!key) continue;
    if (!byKey.has(key)) {
      byKey.set(key, { ...asset, relativePath: key });
    }
  }

  if (!byKey.has('index.html')) {
    byKey.set('index.html', {
      relativePath: 'index.html',
      contentBase64: Buffer.from(siteIndexHtml, 'utf-8').toString('base64'),
    });
  }

  return Array.from(byKey.values()).map(asset => ({
    path: `terraform/site/${normalizeProjectPath(asset.relativePath)}`,
    content: asset.contentBase64,
    encoding: 'base64',
  }));
}

// Keep rarely used helper references explicit for strict builds.
void mergeGeneratedFiles;
void buildWebsiteSiteFiles;

function terraformSafeProjectSlug(value: string): string {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'deplai-project';
}

function buildAzureBundle(projectName: string, contextBlock: string, sec: ReturnType<typeof summarizeSecurity>): GeneratedFile[] {
  const mainTf = `terraform {
  required_version = ">= 1.5.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "azurerm" {
  features {}
}

resource "random_id" "suffix" {
  byte_length = 4
}

resource "azurerm_resource_group" "main" {
  name     = "\${var.project_name}-rg-\${random_id.suffix.hex}"
  location = var.location
}

resource "azurerm_storage_account" "logs" {
  name                     = substr(replace("\${var.project_name}log\${random_id.suffix.hex}", "-", ""), 0, 24)
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

# Security context summary:
# - Code findings: ${sec.totalCodeFindings}
# - Supply findings: ${sec.totalSupplyFindings} (critical/high: ${sec.criticalOrHighSupply})
# - High-impact CWEs: ${sec.highCwe.join(', ') || 'none'}
`;

  const varsTf = `variable "project_name" {
  type        = string
  default     = "${projectName.replace(/"/g, '')}"
  description = "Project identifier for resource naming."
}

variable "location" {
  type        = string
  default     = "centralindia"
  description = "Azure region."
}
`;

  const outputsTf = `output "resource_group_name" {
  value = azurerm_resource_group.main.name
}

output "storage_account_name" {
  value = azurerm_storage_account.logs.name
}
`;

  const ansiblePlaybook = `---
- name: Baseline security hardening
  hosts: all
  become: true
  tasks:
    - name: Ensure fail2ban is installed
      apt:
        name: fail2ban
        state: present
      when: ansible_os_family == "Debian"
`;

  const readme = `# IaC Bundle - ${projectName}

Generated by DeplAI pipeline Step 9.

## Included
- Terraform baseline for provider: Azure
- Ansible hardening playbook

## Context
${contextBlock}
`;

  return [
    { path: 'terraform/main.tf', content: mainTf },
    { path: 'terraform/variables.tf', content: varsTf },
    { path: 'terraform/outputs.tf', content: outputsTf },
    { path: 'ansible/playbooks/security-hardening.yml', content: ansiblePlaybook },
    { path: 'README.md', content: readme },
  ];
}

function buildGcpBundle(projectName: string, contextBlock: string, sec: ReturnType<typeof summarizeSecurity>): GeneratedFile[] {
  const mainTf = `terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}

resource "random_id" "suffix" {
  byte_length = 4
}

resource "google_storage_bucket" "logs" {
  name     = "\${var.project_name}-logs-\${random_id.suffix.hex}"
  location = "ASIA-SOUTH1"
}

# Security context summary:
# - Code findings: ${sec.totalCodeFindings}
# - Supply findings: ${sec.totalSupplyFindings} (critical/high: ${sec.criticalOrHighSupply})
# - High-impact CWEs: ${sec.highCwe.join(', ') || 'none'}
`;

  const varsTf = `variable "project_name" {
  type    = string
  default = "${projectName.replace(/"/g, '')}"
}

variable "gcp_project_id" {
  type        = string
  description = "GCP project id"
}

variable "gcp_region" {
  type    = string
  default = "asia-south1"
}
`;

  const outputsTf = `output "logs_bucket_name" {
  value = google_storage_bucket.logs.name
}
`;

  const ansiblePlaybook = `---
- name: Baseline security hardening
  hosts: all
  become: true
  tasks:
    - name: Ensure auditd is installed
      package:
        name: auditd
        state: present
`;

  const readme = `# IaC Bundle - ${projectName}

Generated by DeplAI pipeline Step 9.

## Included
- Terraform baseline for provider: GCP
- Ansible hardening playbook

## Context
${contextBlock}
`;

  return [
    { path: 'terraform/main.tf', content: mainTf },
    { path: 'terraform/variables.tf', content: varsTf },
    { path: 'terraform/outputs.tf', content: outputsTf },
    { path: 'ansible/playbooks/security-hardening.yml', content: ansiblePlaybook },
    { path: 'README.md', content: readme },
  ];
}

export async function POST(req: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await req.json() as IacGenerateBody;
    const projectId = String(body.project_id || '').trim();
    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    const owned = await verifyProjectOwnership(user.id, projectId);
    if ('error' in owned) return owned.error;

    const provider = clampProvider(body.provider);
    const iacMode = clampIacMode(body.iac_mode);
    const llmApiKey = String(body.llm_api_key || body.openai_api_key || '').trim();
    const llmModel = String(body.llm_model || '').trim();
    const llmApiBaseUrl = String(body.llm_api_base_url || '').trim().replace(/\/+$/, '');
    const terraformRenderer = clampTerraformRenderer(body.terraform_renderer);
    const requestedBudgetCap = Number(body.budget_cap_usd);
    const budgetCapUsd = Number.isFinite(requestedBudgetCap) && requestedBudgetCap > 0
      ? requestedBudgetCap
      : 100;
    const lowCostMode = budgetCapUsd <= 1;
    const projectName = String(owned.project?.name || owned.project?.full_name || projectId).split('/').pop() || projectId;
    const qa = String(body.qa_summary || '').trim();
    const arch = String(body.architecture_context || '').trim();
    const architectureValidation = body.architecture_json
      ? validateTerraformArchitectureInput(body.architecture_json)
      : null;
    if (architectureValidation && !architectureValidation.valid) {
      return NextResponse.json(
        { error: `architecture_json contract validation failed: ${architectureValidation.errors.join('; ')}` },
        { status: 400 },
      );
    }
    const hasArchitectureJson = Boolean(
      architectureValidation?.valid && architectureValidation.normalized
        && Object.keys(architectureValidation.normalized).length > 0,
    );

    // Hard gate: do not generate Terraform without any operator context.
    if (!qa && !arch && !hasArchitectureJson) {
      return NextResponse.json(
        {
          error: 'IaC generation requires Q/A context, architecture context, or architecture_json.',
          requires_context: true,
        },
        { status: 400 },
      );
    }

    let scanData: ScanResultsData = {};
    let scanStatus = 'not_initiated';
    const scanContextWarnings: string[] = [];
    try {
      const scanStatusRes = await fetchAgentic(`/api/scan/status/${projectId}`, {
        headers: agenticHeaders(),
      }, {
        timeoutMs: 30_000,
        retriesPerUrl: 2,
      });
      if (scanStatusRes.ok) {
        const payload = await scanStatusRes.json() as { status?: string };
        scanStatus = String(payload.status || 'not_initiated');
      }
    } catch {
      // Do not hard-fail IaC if status probe fails due to transient connectivity.
      scanStatus = 'unknown';
    }

    if (scanStatus === 'running') {
      scanContextWarnings.push('Security scan is still running; generating Terraform without attached security context.');
    } else if (scanStatus === 'not_initiated') {
      scanContextWarnings.push('No security scan found for this project; generating Terraform without attached security context.');
    } else if (scanStatus === 'error') {
      scanContextWarnings.push('Latest security scan ended with an error; proceeding without attached security context.');
    } else if (scanStatus === 'unknown') {
      scanContextWarnings.push('Security scan status could not be determined; proceeding without attached security context.');
    } else {
      try {
        const scanRes = await fetchAgentic(`/api/scan/results/${projectId}`, {
          headers: agenticHeaders(),
        }, {
          timeoutMs: 30_000,
          retriesPerUrl: 2,
        });
        if (scanRes.ok) {
          const payload = await scanRes.json() as { data?: ScanResultsData };
          scanData = payload.data || {};
        } else {
          scanContextWarnings.push('Security scan exists but its results could not be loaded; proceeding without attached security context.');
        }
      } catch {
        scanData = {};
        scanContextWarnings.push('Security scan results fetch failed; proceeding without attached security context.');
      }
    }

    const sec = summarizeSecurity(scanData);
    const contextBlock = [
      qa ? `Q/A Summary: ${qa}` : '',
      arch ? `Architecture Context: ${arch}` : '',
      `Code Findings: ${sec.totalCodeFindings}`,
      `Supply Findings: ${sec.totalSupplyFindings}`,
      `Critical/High Supply: ${sec.criticalOrHighSupply}`,
      `High-impact CWE IDs: ${sec.highCwe.join(', ') || 'none'}`,
    ].filter(Boolean).join('\n');

    const iacWarnings: string[] = [];
    const sourceRoots = provider === 'aws'
      ? await resolveProjectSourceRoots(String(user.id), projectId)
      : null;
    if (provider === 'aws' && !sourceRoots) {
      return NextResponse.json(
        {
          error: 'Could not resolve repository source files for AWS website packaging. Re-sync the project repository and retry.',
          requires_repo_sync: true,
        },
        { status: 400 },
      );
    }
    const connectorSourceRoot = sourceRoots?.connectorRoot || null;
    const agenticSourceRoot = sourceRoots?.agenticRoot || connectorSourceRoot;
    const repositoryUrl = sourceRoots?.repositoryUrl || null;

    const websiteCollection = provider === 'aws' && connectorSourceRoot
      ? collectWebsiteAssets(connectorSourceRoot)
      : null;
    const frontendDetection = provider === 'aws' && connectorSourceRoot
      ? detectFrontendEntrypoint(connectorSourceRoot)
      : null;
    const websiteAssets = websiteCollection?.assets || [];
    const websiteEntrypoint = provider === 'aws'
      ? resolvePrimaryWebsiteHtmlFromAssets(websiteAssets)
      : { relativePath: null, html: null, reason: 'provider is not aws' };
    const fallbackHint = provider === 'aws'
      ? buildFrontendFallbackHint(projectName, frontendDetection)
      : '';
    const websiteIndexHtml = provider === 'aws'
      ? (String(websiteEntrypoint.html || '').trim() || defaultWebsiteHtml(projectName, fallbackHint))
      : defaultWebsiteHtml(projectName);

    if (provider === 'aws') {
      if (websiteCollection?.selectedRoot) {
        iacWarnings.push(`Website assets were collected from '${websiteCollection.selectedRoot}'.`);
      }
      if (lowCostMode) {
        iacWarnings.push('Strict low-cost mode requested (<= $1); the strategy router will prefer the lowest supported AWS component set, but runtime resources may still be billable.');
      }
      if ((websiteCollection?.assets.length || 0) === 0) {
        iacWarnings.push('No deployable web asset directory was found; using a generated index.html fallback.');
      }
      if (frontendDetection?.detected) {
        const firstCandidate = frontendDetection.entry_candidates[0];
        if (firstCandidate) {
          iacWarnings.push(`Detected frontend source entrypoint '${firstCandidate}' (${frontendDetection.framework}).`);
        } else {
          iacWarnings.push(`Detected frontend framework '${frontendDetection.framework}' without static HTML entrypoint.`);
        }
        if (!frontendDetection.has_build_output) {
          const buildHint = frontendDetection.build_command
            ? `Run '${frontendDetection.build_command}' before IaC generation so deployable static assets exist.`
            : 'Run a frontend build before IaC generation so deployable static assets exist.';
          iacWarnings.push(`Frontend build output was not found (dist/build/out). ${buildHint}`);
        }
      }
      if (websiteCollection?.truncated) {
        iacWarnings.push(
          `Repository asset mirroring hit limits (${MAX_SITE_TOTAL_BYTES} bytes / ${MAX_SITE_FILES} files); deploying a trimmed website bundle.`,
        );
      }
      if ((websiteCollection?.skippedLargeFiles || 0) > 0) {
        iacWarnings.push(`Skipped ${websiteCollection?.skippedLargeFiles} file(s) larger than ${MAX_SITE_FILE_BYTES} bytes.`);
      }
      if (websiteEntrypoint.relativePath) {
        const sourceHint = websiteEntrypoint.sourceRelativePath && websiteEntrypoint.sourceRelativePath !== websiteEntrypoint.relativePath
          ? ` from source '${websiteEntrypoint.sourceRelativePath}'`
          : '';
        iacWarnings.push(`Primary website entrypoint resolved to '${websiteEntrypoint.relativePath}'${sourceHint} (${websiteEntrypoint.reason}).`);
      } else {
        iacWarnings.push(`No HTML entrypoint was detected (${websiteEntrypoint.reason}); using a generated index.html.`);
      }
    }

    if (provider === 'aws') {
      const normalizedArchitecture = (architectureValidation?.normalized || {}) as Record<string, unknown>;
      const normalizedDeploymentProfile = (body.deployment_profile || architectureValidation?.normalized || null) as Record<string, unknown> | null;
      const repositoryContext = (body.repository_context || null) as Record<string, unknown> | null;
      const detectedSummary = inferRepositoryDetection({
        architectureJson: normalizedArchitecture,
        frontendDetection,
        repositoryContext,
      });
      const consultantAction = String(body.consultant_action || '').trim().toLowerCase();
      const consultantTurnCount = Number(body.consultant_turn_count || 0);
      if (consultantAction === 'start' || consultantAction === 'reply' || consultantAction === 'force_decision') {
        const awsRegion = body.aws_region?.trim() || 'eu-north-1';
        const baseDecision = Object.keys(asRecord(body.consultant_decision)).length > 0
          ? asRecord(body.consultant_decision)
          : buildDeterministicConsultantDecision({
            detected: detectedSummary,
            deploymentProfile: normalizedDeploymentProfile,
            userAnswers: asRecord(body.user_answers),
            awsRegion,
          });
        const consultantDecision = normalizeConsultantDecisionEc2(
          baseDecision,
          asRecord(body.user_answers),
          latestUserMessage(body.consultant_history),
        );
        const consultantSummary = summarizeConsultantDecision(
          consultantDecision,
          detectedSummary,
          awsRegion,
        );
        return NextResponse.json({
          success: true,
          detected: detectedSummary,
          consultant_response: buildDeterministicConsultantMessage({
            decision: consultantDecision,
            detected: detectedSummary,
            awsRegion,
            fallbackReason: 'Using the DeplAI standard Terraform architecture.',
          }),
          consultant_ready: true,
          consultant_turn_count: Number.isFinite(consultantTurnCount) ? consultantTurnCount + 1 : 1,
          repo_detection_summary: buildRepoDetectionSummaryText(detectedSummary),
          consultant_decision: consultantDecision,
          consultant_summary: consultantSummary,
          consultant_fallback_reason: 'standard_terraform_architecture',
          actual_renderer: 'deplai_deterministic',
          llm_iac_disabled: true,
        });
      }

      const rawConsultantDecision = asRecord(body.consultant_decision);
      const consultantDecision = Object.keys(rawConsultantDecision).length > 0
        ? normalizeConsultantDecisionEc2(
          rawConsultantDecision,
          asRecord(body.user_answers),
        )
        : rawConsultantDecision;
      const awsRegion = body.aws_region?.trim() || 'eu-north-1';
      const effectiveTerraformRenderer: TerraformRenderer = terraformRenderer;
      const effectiveIacMode: IacMode = terraformRenderer === 'auto' || iacMode === 'llm' ? 'llm' : iacMode;

      let agentBundle: Awaited<ReturnType<typeof generateIacBundleWithTerraformAgent>>;
      try {
        agentBundle = await generateIacBundleWithTerraformAgent({
          projectId,
          projectName,
          workspace: terraformSafeProjectSlug(projectName),
          provider,
          iacMode: effectiveIacMode,
          architectureJson: normalizedArchitecture,
          deploymentProfile: {
            ...(normalizedDeploymentProfile || {}),
            detected: detectedSummary,
            user_answers: asRecord(body.user_answers),
            consultant_decision: consultantDecision,
          },
          approvalPayload: asRecord(body.approval_payload),
          repositoryContext,
          securityContext: sec,
          websiteAssetStats: {
            selected_root: websiteCollection?.selectedRoot || '',
            asset_count: websiteAssets.length,
            total_bytes: websiteCollection?.totalBytes || 0,
            truncated: Boolean(websiteCollection?.truncated),
            skipped_large_files: websiteCollection?.skippedLargeFiles || 0,
            entrypoint: websiteEntrypoint.relativePath,
          },
          frontendEntrypointDetection: frontendDetection ? { ...frontendDetection } : null,
          detected: detectedSummary,
          userAnswers: asRecord(body.user_answers),
          consultantDecision,
          awsRegion,
          stateBucket: String(body.state_bucket || '').trim(),
          lockTable: String(body.lock_table || '').trim(),
          qaSummary: contextBlock,
          websiteIndexHtml,
          terraformRenderer: effectiveTerraformRenderer,
          llmProvider: body.llm_provider || null,
          llmApiKey: body.llm_api_key || null,
          llmModel: body.llm_model || null,
          llmApiBaseUrl: body.llm_api_base_url || null,
          sourceRoot: agenticSourceRoot,
          sourceRootCandidates: [
            ...(agenticSourceRoot ? [agenticSourceRoot] : []),
            ...(connectorSourceRoot && connectorSourceRoot !== agenticSourceRoot ? [connectorSourceRoot] : []),
          ],
          repositoryUrl,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err || 'Terraform agent generation failed.');
        const status = message.includes('unsupported_deployment_shape') ? 400 : 502;
        return NextResponse.json(
          {
            error: message,
            unsupported_reason: message.includes('unsupported_deployment_shape') ? message : null,
            actual_renderer: effectiveTerraformRenderer,
            llm_iac_disabled: effectiveIacMode !== 'llm',
          },
          { status },
        );
      }

      const files = agentBundle.files;
      const source = agentBundle.source || agentBundle.actualRenderer || 'terraform_agent';
      const displayRenderer = source.startsWith('terraform_agent')
        ? source
        : (agentBundle.actualRenderer || source);
      const runId = agentBundle.runId;
      const workspace = agentBundle.workspace;
      const providerVersion = agentBundle.providerVersion;
      const stateBucket = agentBundle.stateBucket;
      const lockTable = agentBundle.lockTable;
      const manifest = agentBundle.manifest;
      const dagOrder = agentBundle.dagOrder;
      const agentDetails: Record<string, unknown> = {
        ...(agentBundle.details || {}),
        execution_kind: agentBundle.executionKind || 'terraform',
        renderer: displayRenderer,
        source,
        terraform_agent_renderer: agentBundle.actualRenderer || null,
        requested_renderer: effectiveTerraformRenderer,
        terraform_root: 'terraform',
        strategy_router_enabled: true,
      };
      const rendererMetadata: Record<string, unknown> = {
        requested_renderer: effectiveTerraformRenderer,
        actual_renderer: displayRenderer,
        unsupported_reason: agentBundle.unsupportedReason || null,
        component_catalog_version: agentBundle.componentCatalogVersion,
        execution_kind: agentBundle.executionKind || 'terraform',
        llm_iac_calls: agentBundle.llmIacCalls,
        llm_iac_disabled: agentBundle.llmIacDisabled,
        deployment_package_id: agentBundle.deploymentPackageId,
        decision_applied: Object.keys(consultantDecision).length > 0 || agentBundle.decisionApplied,
        decision_drift: agentBundle.decisionDrift,
      };

      const finalBundleValidation = validateAwsTerraformBundle(files);
      if (!finalBundleValidation.valid) {
        return NextResponse.json(
          {
            error: `Generated Terraform bundle failed validation and was not persisted: ${finalBundleValidation.errors.join('; ')}`,
          },
          { status: 500 },
        );
      }

      const allWarnings = [
        ...scanContextWarnings,
        ...iacWarnings,
        ...agentBundle.warnings,
        `AWS Terraform strategy router selected '${rendererMetadata.actual_renderer || 'terraform_agent'}'.`,
        'Generated Terraform bundle using repository analysis, approved consultant decision, and deployment Q/A context.',
        'Deploy will apply this exact generated Terraform run or file bundle through the runtime Terraform engine.',
        'Terraform files use a local backend unless state_bucket and lock_table are provided.',
        ...(effectiveIacMode === 'llm' && agentBundle.llmIacDisabled
          ? ['Terraform worker LLM was unavailable or not used; deterministic rescue/template rendering produced the bundle.']
          : []),
      ];
      const iacRepoPr: RepoPersistenceResult = {
        attempted: false,
        success: false,
        pr_url: null,
        reason: 'manual_trigger_required',
      };

      return NextResponse.json({
        success: true,
        provider,
        project_id: projectId,
        project_name: projectName,
        summary: agentBundle.summary || `Generated ${files.length} Terraform files through the AWS strategy router.`,
        files,
        security_context: sec,
        source,
        run_id: runId,
        workspace,
        provider_version: providerVersion,
        state_bucket: stateBucket,
        lock_table: lockTable,
        manifest,
        dag_order: dagOrder,
        details: agentDetails,
        ...rendererMetadata,
        iac_repo_pr: iacRepoPr,
        warnings: allWarnings,
        detected: detectedSummary,
        user_answers: asRecord(body.user_answers),
        consultant_decision: consultantDecision,
        website_asset_stats: {
          selected_root: websiteCollection?.selectedRoot || '',
          asset_count: websiteAssets.length,
          mirrored_asset_count: 0,
          total_bytes: websiteCollection?.totalBytes || 0,
          truncated: Boolean(websiteCollection?.truncated),
          skipped_large_files: websiteCollection?.skippedLargeFiles || 0,
          entrypoint: websiteEntrypoint.relativePath,
        },
        frontend_entrypoint_detection: frontendDetection,
      });

    }

    const deterministicFiles = provider === 'azure'
      ? buildAzureBundle(projectName, contextBlock, sec)
      : buildGcpBundle(projectName, contextBlock, sec);
    const files = deterministicFiles;
    let source = 'template';
    const llmSummary = '';

    if (iacMode === 'llm' || llmApiKey || llmModel || llmApiBaseUrl || body.llm_provider) {
      source = iacMode === 'llm' ? 'template_fallback' : source;
      iacWarnings.push('LLM IaC generation is disabled; using deterministic provider template and ignoring LLM provider fields.');
    }

    const iacRepoPr: RepoPersistenceResult = {
      attempted: false,
      success: false,
      pr_url: null,
      reason: 'manual_trigger_required',
    };

    const combinedWarnings = [...scanContextWarnings, ...iacWarnings, `IaC generation mode: ${iacMode}.`];
    const summary = llmSummary || (
      combinedWarnings.length > 0
        ? `Generated ${files.length} IaC files for ${provider.toUpperCase()} with ${combinedWarnings.length} warning(s).`
        : `Generated ${files.length} IaC files for ${provider.toUpperCase()}.`
    );

    return NextResponse.json({
      success: true,
      provider,
      project_id: projectId,
      project_name: projectName,
      summary,
      files,
      security_context: sec,
      source,
      iac_repo_pr: iacRepoPr,
      warnings: combinedWarnings,
      requested_renderer: terraformRenderer,
      actual_renderer: source,
      unsupported_reason: null,
      component_catalog_version: null,
      execution_kind: 'terraform',
      llm_iac_calls: 0,
      llm_iac_disabled: true,
      decision_applied: false,
      decision_drift: [],
      website_asset_stats: null,
      frontend_entrypoint_detection: null,
    });
  } catch (err) {
    const classified = classifyAgenticRouteError(err, 'generate Terraform and Ansible files');
    return NextResponse.json({ error: classified.message }, { status: classified.status });
  }
}


