import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { validateTerraformArchitectureInput } from '@/lib/deployment-planning-contract';
import { type RepoPersistenceResult } from '@/lib/iac-pr';
import { resolveProjectSourceRoot as resolveSharedProjectSourceRoot } from '@/lib/project-meta';
import fs from 'fs';
import path from 'path';

type Provider = 'aws' | 'azure' | 'gcp';
type IacMode = 'deterministic' | 'llm';
type TerraformRenderer = 'auto' | 'cloudposse_atmos' | 'deplai_deterministic';

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

  const framework =
    readText(params.frontendDetection?.framework)
    || readText(frameworks[0]?.name)
    || readText(repoFrontend.framework)
    || readText(metadata.framework)
    || 'unknown';

  const dataTypes = dataLayer
    .map(item => readText(item.type).toLowerCase())
    .filter(Boolean);
  const nodeHas = (re: RegExp) => re.test(nodeCorpus);

  const hasRedis = dataTypes.includes('redis') || nodeHas(/redis|elasticache/);
  const databaseType = dataTypes.find((t) => ['postgres', 'postgresql', 'mysql', 'mariadb', 'mongodb', 'dynamodb'].includes(t))
    || (nodeHas(/postgres|rds/) ? 'postgres'
      : nodeHas(/mysql|mariadb/) ? 'mysql'
        : nodeHas(/mongodb|documentdb/) ? 'mongodb'
          : nodeHas(/dynamodb/) ? 'dynamodb'
            : 'unknown');
  const hasDatabase = databaseType !== 'unknown';

  const hasWebServer =
    services.some((service) => readText(service.process_type).toLowerCase() === 'web')
    || nodeHas(/alb|load[_ -]?balancer|api[_ -]?gateway|web|nginx|ecs|ec2|fargate|service/);

  const hasWorkers =
    services.some((service) => readText(service.process_type).toLowerCase() === 'worker')
    || nodeHas(/worker|celery|sidekiq|consumer|batch|cron|job/);

  const hasStaticAssets =
    Boolean(params.frontendDetection?.has_build_output)
    || nodeHas(/cloudfront|static|cdn|s3/)
    || readText(repoBuild.output_dir).length > 0;

  const hasDockerfile =
    readBoolLike(repoBuild.has_dockerfile) === true
    || readBoolLike(metadata.has_dockerfile) === true
    || readText(repoBuild.dockerfile_path).length > 0;

  const hasQueue = nodeHas(/queue|sqs|rabbitmq|kafka|pubsub/);

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

function normalizeConsultantHistory(value: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const entry = asRecord(item);
      const role = String(entry.role || '').trim().toLowerCase();
      const content = String(entry.content || '').trim();
      if ((role !== 'user' && role !== 'assistant') || !content) return null;
      return { role: role as 'user' | 'assistant', content };
    })
    .filter((item): item is { role: 'user' | 'assistant'; content: string } => item !== null);
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

  if (components.includes('s3_cloudfront')) {
    lines.push(detected.has_static_assets ? 'CDN/static hosting is included.' : 'CloudFront/static hosting is included.');
  }

  if (notes.length > 0) {
    lines.push(`Notes: ${notes.join(' | ')}`);
  }

  return lines.join('\n');
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

async function resolveProjectSourceRoot(
  userId: string,
  projectId: string,
): Promise<string | null> {
  return resolveSharedProjectSourceRoot(userId, projectId);
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
  if (renderer === 'deplai_deterministic') return 'deplai_deterministic';
  if (renderer === 'cloudposse_atmos') return 'cloudposse_atmos';
  return 'deplai_deterministic';
}

function isAllowedGeneratedIacPath(safePath: string): boolean {
  return (
    safePath.startsWith('terraform/')
    || safePath.startsWith('ansible/')
    || safePath.startsWith('stacks/')
    || safePath.startsWith('components/terraform/')
    || safePath === 'atmos.yaml'
    || safePath === 'vendor.yaml'
    || safePath === '.deplai/cloudposse-component-lock.json'
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
    if (content.length > 900_000) continue;
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

function isCloudPosseAtmosBundle(files: GeneratedFile[]): boolean {
  const paths = new Set(files.map((file) => normalizeRepoWritePath(file.path)));
  return paths.has('atmos.yaml') && paths.has('vendor.yaml') && paths.has('.deplai/cloudposse-component-lock.json');
}

function validateAwsTerraformBundle(files: GeneratedFile[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (isCloudPosseAtmosBundle(files)) {
    const lock = files.find((file) => normalizeRepoWritePath(file.path) === '.deplai/cloudposse-component-lock.json');
    try {
      const parsed = JSON.parse(String(lock?.content || '{}')) as { deploy_sequence?: unknown; stack?: unknown };
      if (!Array.isArray(parsed.deploy_sequence) || parsed.deploy_sequence.length === 0) {
        errors.push('Cloud Posse component lock is missing deploy_sequence');
      }
      if (typeof parsed.stack !== 'string' || !parsed.stack.trim()) {
        errors.push('Cloud Posse component lock is missing stack');
      }
    } catch {
      errors.push('Cloud Posse component lock is not valid JSON');
    }
    return { valid: errors.length === 0, errors };
  }

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
      website_index_html: params.websiteIndexHtml,
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

// Keep the Atmos helper path available while the default AWS renderer uses the EC2 root bundle.
void mergeGeneratedFiles;
void generateIacBundleWithTerraformAgent;
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

function hclString(value: string): string {
  return JSON.stringify(String(value || ''));
}

function hclStringList(values: string[]): string {
  return `[${values.map(hclString).join(', ')}]`;
}

function numericAnswer(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  const match = String(value || '').match(/\d+/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function findAnswerValue(answers: Record<string, unknown>, patterns: RegExp[]): unknown {
  for (const [key, value] of Object.entries(answers)) {
    if (patterns.some((pattern) => pattern.test(key))) return value;
  }
  for (const value of Object.values(answers)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = findAnswerValue(value as Record<string, unknown>, patterns);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function inferAwsEc2BundleInputs(params: {
  projectName: string;
  awsRegion: string;
  contextBlock: string;
  websiteIndexHtml: string;
  userAnswers: Record<string, unknown>;
  deploymentProfile: Record<string, unknown> | null;
  architectureJson: Record<string, unknown> | null;
  detected: RepoDetectionSummary;
}): {
  projectSlug: string;
  awsRegion: string;
  environment: string;
  instanceType: string;
  appPort: number;
  preferredAzs: string[];
  contextSummary: string;
  websiteIndexHtml: string;
} {
  const answers = asRecord(params.userAnswers);
  const deployment = asRecord(params.deploymentProfile);
  const architecture = asRecord(params.architectureJson);
  const compute = asRecord(deployment.compute || architecture.compute);
  const services = asRecords(compute.services);
  const firstService = services[0] || {};
  const appPort =
    numericAnswer(findAnswerValue(answers, [/app.*port/i, /service.*port/i, /port/i]))
    || numericAnswer(firstService.port)
    || (params.detected.framework === 'nextjs' || params.detected.language === 'javascript' || params.detected.language === 'typescript' ? 3000 : 80);
  const concurrentUsers =
    numericAnswer(findAnswerValue(answers, [/concurrent/i, /peak.*users?/i, /max.*users?/i, /traffic/i]))
    || 200;
  const explicitInstance = String(
    findAnswerValue(answers, [/instance.*type/i, /ec2.*type/i])
    || firstService.instance_type
    || '',
  ).trim();
  const instanceType = explicitInstance || (concurrentUsers > 1000 ? 't3.medium' : concurrentUsers > 250 ? 't3.small' : 't3.micro');
  const environment = String(
    findAnswerValue(answers, [/environment/i, /stage/i])
    || deployment.environment
    || architecture.environment
    || 'production',
  ).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'production';
  const awsRegion = String(params.awsRegion || 'eu-north-1').trim() || 'eu-north-1';
  const preferredAzs = ['a', 'b', 'c'].map((suffix) => `${awsRegion}${suffix}`);
  return {
    projectSlug: terraformSafeProjectSlug(params.projectName),
    awsRegion,
    environment,
    instanceType,
    appPort: Math.max(1, Math.min(65535, appPort)),
    preferredAzs,
    contextSummary: params.contextBlock,
    websiteIndexHtml: params.websiteIndexHtml,
  };
}

function buildAwsEc2RootBundle(params: {
  projectName: string;
  awsRegion: string;
  contextBlock: string;
  sec: ReturnType<typeof summarizeSecurity>;
  websiteIndexHtml: string;
  userAnswers: Record<string, unknown>;
  deploymentProfile: Record<string, unknown> | null;
  architectureJson: Record<string, unknown> | null;
  detected: RepoDetectionSummary;
}): GeneratedFile[] {
  const inputs = inferAwsEc2BundleInputs({
    projectName: params.projectName,
    awsRegion: params.awsRegion,
    contextBlock: params.contextBlock,
    websiteIndexHtml: params.websiteIndexHtml,
    userAnswers: params.userAnswers,
    deploymentProfile: params.deploymentProfile,
    architectureJson: params.architectureJson,
    detected: params.detected,
  });
  const ec2HtmlBase64 = Buffer.from(String(inputs.websiteIndexHtml || ''), 'utf-8').toString('base64');
  const contextSummary = inputs.contextSummary.replace(/\r/g, '');
  const preferredAzsHcl = hclStringList(inputs.preferredAzs);

  const providersTf = `terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.54"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
`;

  const backendTf = `terraform {
  backend "local" {}
}
`;

  const variablesTf = `variable "project_name" {
  type    = string
  default = ${hclString(inputs.projectSlug)}
}

variable "aws_region" {
  type    = string
  default = ${hclString(inputs.awsRegion)}
}

variable "environment" {
  type    = string
  default = ${hclString(inputs.environment)}
}

variable "instance_type" {
  type    = string
  default = ${hclString(inputs.instanceType)}
}

variable "enable_ec2" {
  type    = bool
  default = true
}

variable "existing_ec2_key_pair_name" {
  type    = string
  default = ""
}

variable "app_port" {
  type    = number
  default = ${inputs.appPort}
}

variable "ingress_cidr_blocks" {
  type    = list(string)
  default = ["0.0.0.0/0"]
}

variable "ssh_ingress_cidr_blocks" {
  type    = list(string)
  default = []
}

variable "preferred_availability_zones" {
  type    = list(string)
  default = ${preferredAzsHcl}
}

variable "use_default_vpc" {
  type    = bool
  default = true
}

variable "vpc_cidr_block" {
  type    = string
  default = "10.42.0.0/16"
}

variable "public_subnet_cidr" {
  type    = string
  default = "10.42.1.0/24"
}

variable "ec2_root_volume_size" {
  type    = number
  default = 12
}

variable "bootstrap_index_html_base64" {
  type      = string
  default   = ${hclString(ec2HtmlBase64)}
  sensitive = true
}

variable "context_summary" {
  type    = string
  default = ""
}
`;

  const tfvars = `project_name = ${hclString(inputs.projectSlug)}
aws_region = ${hclString(inputs.awsRegion)}
environment = ${hclString(inputs.environment)}
instance_type = ${hclString(inputs.instanceType)}
enable_ec2 = true
existing_ec2_key_pair_name = ""
app_port = ${inputs.appPort}
ingress_cidr_blocks = ["0.0.0.0/0"]
ssh_ingress_cidr_blocks = []
preferred_availability_zones = ${preferredAzsHcl}
use_default_vpc = true
vpc_cidr_block = "10.42.0.0/16"
public_subnet_cidr = "10.42.1.0/24"
ec2_root_volume_size = 12
bootstrap_index_html_base64 = ${hclString(ec2HtmlBase64)}
context_summary = <<-EOT
${contextSummary}
EOT
`;

  const mainTf = `locals {
  tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "deplai"
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_vpc" "default" {
  count   = var.use_default_vpc ? 1 : 0
  default = true
}

data "aws_subnets" "default" {
  count = var.use_default_vpc ? 1 : 0
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default[0].id]
  }
}

locals {
  preferred_azs     = length(var.preferred_availability_zones) > 0 ? [for az in var.preferred_availability_zones : az if contains(data.aws_availability_zones.available.names, az)] : data.aws_availability_zones.available.names
  selected_az       = length(local.preferred_azs) > 0 ? local.preferred_azs[0] : data.aws_availability_zones.available.names[0]
  default_subnet_ids = try(data.aws_subnets.default[0].ids, [])
}

data "aws_subnet" "default_details" {
  for_each = var.use_default_vpc ? toset(local.default_subnet_ids) : toset([])
  id       = each.value
}

locals {
  preferred_default_subnet_ids = [for subnet in values(data.aws_subnet.default_details) : subnet.id if contains(local.preferred_azs, subnet.availability_zone)]
  selected_default_subnet_id   = length(local.preferred_default_subnet_ids) > 0 ? local.preferred_default_subnet_ids[0] : (length(local.default_subnet_ids) > 0 ? local.default_subnet_ids[0] : null)
}

resource "aws_vpc" "main" {
  count                = var.use_default_vpc ? 0 : 1
  cidr_block           = var.vpc_cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "\${var.project_name}-vpc" })
}

resource "aws_internet_gateway" "main" {
  count  = var.use_default_vpc ? 0 : 1
  vpc_id = aws_vpc.main[0].id
  tags   = merge(local.tags, { Name = "\${var.project_name}-igw" })
}

resource "aws_subnet" "public" {
  count                   = var.use_default_vpc ? 0 : 1
  vpc_id                  = aws_vpc.main[0].id
  cidr_block              = var.public_subnet_cidr
  availability_zone       = local.selected_az
  map_public_ip_on_launch = true
  tags                    = merge(local.tags, { Name = "\${var.project_name}-public-subnet" })
}

resource "aws_route_table" "public" {
  count  = var.use_default_vpc ? 0 : 1
  vpc_id = aws_vpc.main[0].id
  tags   = merge(local.tags, { Name = "\${var.project_name}-public-rt" })
}

resource "aws_route" "internet_access" {
  count                  = var.use_default_vpc ? 0 : 1
  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main[0].id
}

resource "aws_route_table_association" "public" {
  count          = var.use_default_vpc ? 0 : 1
  subnet_id      = aws_subnet.public[0].id
  route_table_id = aws_route_table.public[0].id
}

locals {
  selected_vpc_id             = var.use_default_vpc ? data.aws_vpc.default[0].id : aws_vpc.main[0].id
  selected_instance_subnet_id = var.use_default_vpc ? local.selected_default_subnet_id : aws_subnet.public[0].id
}

resource "aws_security_group" "web" {
  name_prefix = "\${var.project_name}-web-"
  description = "Web access for DeplAI deployment"
  vpc_id      = local.selected_vpc_id
  tags        = local.tags

  lifecycle {
    create_before_destroy = true
  }

  dynamic "ingress" {
    for_each = var.ssh_ingress_cidr_blocks
    content {
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.ingress_cidr_blocks
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.ingress_cidr_blocks
  }

  dynamic "ingress" {
    for_each = contains([80, 443], var.app_port) ? [] : [var.app_port]
    content {
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = var.ingress_cidr_blocks
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "random_id" "key_suffix" {
  byte_length = 4
  keepers = {
    project_name = var.project_name
  }
}

resource "tls_private_key" "generated" {
  count     = var.enable_ec2 && trimspace(var.existing_ec2_key_pair_name) == "" ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "generated" {
  count      = var.enable_ec2 && trimspace(var.existing_ec2_key_pair_name) == "" ? 1 : 0
  key_name   = "\${var.project_name}-\${random_id.key_suffix.hex}"
  public_key = tls_private_key.generated[0].public_key_openssh
  tags       = local.tags
}

locals {
  selected_ec2_key_name = !var.enable_ec2 ? null : (
    trimspace(var.existing_ec2_key_pair_name) != ""
    ? trimspace(var.existing_ec2_key_pair_name)
    : try(aws_key_pair.generated[0].key_name, null)
  )
}

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-2023*-x86_64"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_instance" "app" {
  count                       = var.enable_ec2 ? 1 : 0
  ami                         = data.aws_ami.al2023.id
  instance_type               = var.instance_type
  subnet_id                   = local.selected_instance_subnet_id
  vpc_security_group_ids      = [aws_security_group.web.id]
  key_name                    = local.selected_ec2_key_name
  associate_public_ip_address = true
  tags                        = merge(local.tags, { Name = "\${var.project_name}-app" })

  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.ec2_root_volume_size
    encrypted   = true
  }

  user_data_replace_on_change = true
  user_data = join("\\n", [
    "#!/bin/bash",
    "set -euxo pipefail",
    "dnf install -y nginx",
    "mkdir -p /usr/share/nginx/html",
    "cat <<'HTML' > /usr/share/nginx/html/index.html",
    "\${base64decode(var.bootstrap_index_html_base64)}",
    "HTML",
    "systemctl enable nginx",
    "systemctl restart nginx",
  ])
}
`;

  const outputsTf = `output "ec2_instance_id" { value = try(aws_instance.app[0].id, null) }
output "ec2_instance_arn" { value = try(aws_instance.app[0].arn, null) }
output "ec2_instance_state" { value = try(aws_instance.app[0].instance_state, null) }
output "ec2_instance_type" { value = var.instance_type }
output "ec2_public_ip" { value = try(aws_instance.app[0].public_ip, null) }
output "ec2_private_ip" { value = try(aws_instance.app[0].private_ip, null) }
output "ec2_public_dns" { value = try(aws_instance.app[0].public_dns, null) }
output "ec2_private_dns" { value = try(aws_instance.app[0].private_dns, null) }
output "ec2_vpc_id" { value = local.selected_vpc_id }
output "ec2_subnet_id" { value = local.selected_instance_subnet_id }
output "ec2_key_name" { value = local.selected_ec2_key_name }
output "app_url" { value = try("http://\${aws_instance.app[0].public_dns}", null) }
output "availability_warning" {
  value = var.environment == "production" && var.enable_ec2 ? "Single-AZ EC2 deployment detected. Add a load balancer and autoscaling group before high-availability production traffic." : ""
}
output "generated_ec2_private_key_pem" {
  value     = try(tls_private_key.generated[0].private_key_pem, null)
  sensitive = true
}
output "security_summary" {
  value = {
    code_findings = ${params.sec.totalCodeFindings}
    supply_findings = ${params.sec.totalSupplyFindings}
    critical_or_high_supply = ${params.sec.criticalOrHighSupply}
    high_cwe = ${hclString(params.sec.highCwe.join(', ') || 'none')}
  }
}
`;

  const ansiblePlaybook = `---
- name: Baseline security hardening
  hosts: all
  become: true
  tasks:
    - name: Ensure unattended upgrades package is present (Debian/Ubuntu)
      apt:
        name: unattended-upgrades
        state: present
      when: ansible_os_family == "Debian"
`;

  const inventory = `[all]
# replace with the EC2 public DNS or IP from Terraform outputs
example-host ansible_host=127.0.0.1 ansible_user=ec2-user
`;

  const readme = `# IaC Bundle - ${params.projectName}

Deterministic AWS EC2 Terraform bundle generated by DeplAI.

This bundle is the primary runtime deploy path for AWS. Terraform manages resource dependencies inside one root module so deploys do not depend on Atmos component sequencing.

Terraform files:
- terraform/providers.tf
- terraform/backend.tf
- terraform/main.tf
- terraform/variables.tf
- terraform/terraform.tfvars
- terraform/outputs.tf
`;

  return [
    { path: 'terraform/providers.tf', content: providersTf },
    { path: 'terraform/backend.tf', content: backendTf },
    { path: 'terraform/main.tf', content: mainTf },
    { path: 'terraform/variables.tf', content: variablesTf },
    { path: 'terraform/terraform.tfvars', content: tfvars },
    { path: 'terraform/outputs.tf', content: outputsTf },
    { path: 'ansible/inventory.ini', content: inventory },
    { path: 'ansible/playbooks/security-hardening.yml', content: ansiblePlaybook },
    { path: 'README.md', content: readme },
  ];
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
    const sourceRoot = provider === 'aws'
      ? await resolveProjectSourceRoot(String(user.id), projectId)
      : null;
    if (provider === 'aws' && !sourceRoot) {
      return NextResponse.json(
        {
          error: 'Could not resolve repository source files for AWS website packaging. Re-sync the project repository and retry.',
          requires_repo_sync: true,
        },
        { status: 400 },
      );
    }

    const websiteCollection = provider === 'aws' && sourceRoot
      ? collectWebsiteAssets(sourceRoot)
      : null;
    const frontendDetection = provider === 'aws' && sourceRoot
      ? detectFrontendEntrypoint(sourceRoot)
      : null;
    const websiteAssets = websiteCollection?.assets || [];
    const effectiveWebsiteAssets = lowCostMode ? [] : websiteAssets;
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
        iacWarnings.push('Strict low-cost mode requested (<= $1), but EC2 remains enabled because AWS runtime deploy requires a running instance.');
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
      const consultantHistory = normalizeConsultantHistory(body.consultant_history);
      const consultantTurnCount = Number(body.consultant_turn_count || 0);
      if (consultantAction === 'start' || consultantAction === 'reply' || consultantAction === 'force_decision') {
        try {
          const consultRes = await fetchAgentic('/api/terraform/cloudposse/consult', {
            method: 'POST',
            headers: {
              ...agenticHeaders(),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              architecture_json: normalizedArchitecture,
              repository_context: repositoryContext || undefined,
              deployment_profile: normalizedDeploymentProfile || undefined,
              detected: detectedSummary,
              aws_region: body.aws_region?.trim() || 'eu-north-1',
              conversation_history: consultantHistory,
              turn_count: Number.isFinite(consultantTurnCount) ? consultantTurnCount : 0,
              force_decision: consultantAction === 'force_decision' || consultantTurnCount >= 20,
            }),
          }, {
            timeoutMs: 180_000,
            retriesPerUrl: 2,
            retryDelayMs: 1_000,
          });
          const consultData = await consultRes.json().catch(() => ({})) as {
            success?: boolean;
            assistant_message?: string;
            ready?: boolean;
            decision?: Record<string, unknown>;
            repo_detection_summary?: string;
            turn_count?: number;
            error?: string;
          };
          if (!consultRes.ok || consultData.success !== true) {
            throw new Error(String(consultData.error || 'Infra consultant conversation failed.'));
          }
          const consultantDecision = asRecord(consultData.decision);
          return NextResponse.json({
            success: true,
            detected: detectedSummary,
            consultant_response: String(consultData.assistant_message || ''),
            consultant_ready: Boolean(consultData.ready && Object.keys(consultantDecision).length > 0),
            consultant_turn_count: Number(consultData.turn_count || (consultantTurnCount + 1)),
            repo_detection_summary: String(consultData.repo_detection_summary || ''),
            consultant_decision: Object.keys(consultantDecision).length > 0 ? consultantDecision : null,
            consultant_summary: Object.keys(consultantDecision).length > 0
              ? summarizeConsultantDecision(consultantDecision, detectedSummary, body.aws_region?.trim() || 'eu-north-1')
              : null,
          });
        } catch (consultErr) {
          const classified = classifyAgenticRouteError(consultErr, 'run the infra consultant');
          return NextResponse.json(
            { error: classified.message },
            { status: classified.status },
          );
        }
      }

      const consultantDecision = asRecord(body.consultant_decision);
      const awsRegion = body.aws_region?.trim() || 'eu-north-1';
      const files = buildAwsEc2RootBundle({
        projectName,
        awsRegion,
        contextBlock,
        sec,
        websiteIndexHtml,
        userAnswers: asRecord(body.user_answers),
        deploymentProfile: {
          ...(normalizedDeploymentProfile || {}),
          detected: detectedSummary,
          user_answers: asRecord(body.user_answers),
          consultant_decision: consultantDecision,
        },
        architectureJson: normalizedArchitecture,
        detected: detectedSummary,
      });
      const source = 'deplai_deterministic_ec2';
      const llmSummary = 'Generated deterministic AWS EC2 Terraform root bundle. Terraform will manage VPC/subnet/security-group/key/instance dependencies inside one root module.';
      const runId: string | null = null;
      const workspace: string | null = null;
      const providerVersion = '~> 5.54';
      const stateBucket: string | null = null;
      const lockTable: string | null = null;
      const manifest: unknown[] = [];
      const dagOrder = ['terraform'];
      const agentDetails: Record<string, unknown> = {
        execution_kind: 'terraform',
        renderer: source,
        terraform_root: 'terraform',
        default_runtime_target: 'ec2',
        atmos_bypassed: true,
      };
      const rendererMetadata: Record<string, unknown> = {
        requested_renderer: terraformRenderer,
        actual_renderer: source,
        unsupported_reason: null,
        component_catalog_version: null,
        execution_kind: 'terraform',
        llm_iac_calls: 0,
        llm_iac_disabled: true,
        decision_applied: Object.keys(consultantDecision).length > 0,
        decision_drift: [],
      };
      iacWarnings.push('AWS generation is using the deterministic EC2 root bundle path; Cloud Posse/Atmos is bypassed for first-success runtime deploys.');
      if (effectiveWebsiteAssets.length > 0) {
        iacWarnings.push('Website context is embedded into EC2 nginx bootstrap HTML; bulk static asset mirroring is not used in the default EC2 deploy path.');
      }

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
        `AWS Terraform worker backend: ${rendererMetadata.actual_renderer || 'deplai_deterministic_ec2'}.`,
        'Generated Terraform bundle through the deterministic EC2 root pipeline using repository analysis, approved architecture, and deployment Q&A context.',
        'Terraform files use a local backend by default. AWS credentials are only needed later for apply/deploy.',
        ...(iacMode === 'llm' || llmApiKey || llmModel || llmApiBaseUrl || body.llm_provider
          ? ['LLM IaC generation is disabled; LLM provider fields were ignored for Terraform generation.']
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
        summary: llmSummary || `Generated ${files.length} Terraform files from repository analysis and operator context.`,
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
          mirrored_asset_count: effectiveWebsiteAssets.length,
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


