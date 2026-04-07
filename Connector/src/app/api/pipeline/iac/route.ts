import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { validateTerraformArchitectureInput } from '@/lib/deployment-planning-contract';
import { githubService } from '@/lib/github';
import { resolveProjectMeta as resolveSharedProjectMeta, resolveProjectSourceRoot as resolveSharedProjectSourceRoot } from '@/lib/project-meta';
import fs from 'fs';
import path from 'path';

type Provider = 'aws' | 'azure' | 'gcp';
type IacMode = 'deterministic' | 'llm';
type LlmProvider = 'groq' | 'openrouter' | 'ollama' | 'opencode' | 'openai';

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
  // Required in LLM-only IaC mode: full architecture JSON
  architecture_json?: Record<string, unknown>;
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
}

interface GeneratedFile {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
}

interface ProjectMetaRow {
  project_type: 'local' | 'github';
  repo_full_name: string | null;
  installation_uuid: string | null;
}

interface RepoPersistenceResult {
  attempted: boolean;
  success: boolean;
  pr_url: string | null;
  branch?: string | null;
  reason?: string;
  error?: string;
  files_committed?: number;
}

interface LlmResolvedConfig {
  provider: LlmProvider;
  model: string;
  apiBaseUrl: string;
}

function classifyAgenticRouteError(err: unknown, action: string): { message: string; status: number } {
  const raw = err instanceof Error ? err.message : String(err || 'unknown upstream error');
  const lowered = raw.toLowerCase();
  if (
    lowered.includes('fetch failed') ||
    lowered.includes('econnrefused') ||
    lowered.includes('enotfound') ||
    lowered.includes('network')
  ) {
    return {
      message: `Agentic Layer is unavailable while trying to ${action}. Start the service at ${AGENTIC_URL} and retry.`,
      status: 502,
    };
  }
  return {
    message: raw || `${action} failed.`,
    status: 500,
  };
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
      return {
        relativePath: hit.relativePath,
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
    return {
      relativePath: best.asset.relativePath,
      html: fallbackDecoded,
      reason: 'selected highest-scoring HTML candidate',
    };
  }

  return {
    relativePath: null,
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

async function resolveProjectMeta(
  userId: string,
  projectId: string,
): Promise<ProjectMetaRow | null> {
  return resolveSharedProjectMeta(userId, projectId) as Promise<ProjectMetaRow | null>;
}

function normalizeRepoWritePath(filePath: string): string {
  const normalized = normalizeProjectPath(filePath || '');
  if (!normalized || normalized.includes('..')) return '';
  return normalized;
}

function isPersistableIacFile(file: GeneratedFile): boolean {
  const safePath = normalizeRepoWritePath(file.path);
  if (!safePath) return false;
  if (safePath.startsWith('terraform/site/')) return false;
  return safePath.startsWith('terraform/') || safePath.startsWith('ansible/') || safePath === 'README.md';
}

async function persistIacToRepoPr(
  userId: string,
  projectId: string,
  projectName: string,
  files: GeneratedFile[],
): Promise<RepoPersistenceResult> {
  const meta = await resolveProjectMeta(userId, projectId);
  if (!meta) {
    return { attempted: false, success: false, pr_url: null, reason: 'project_metadata_unavailable' };
  }
  if (meta.project_type !== 'github') {
    return { attempted: false, success: false, pr_url: null, reason: 'local_project' };
  }
  if (!meta.repo_full_name || !meta.installation_uuid) {
    return { attempted: false, success: false, pr_url: null, reason: 'missing_repo_metadata' };
  }

  const persistable = files.filter(isPersistableIacFile);
  if (persistable.length === 0) {
    return { attempted: false, success: false, pr_url: null, reason: 'no_persistable_iac_files' };
  }

  const [owner, repo] = meta.repo_full_name.split('/');
  if (!owner || !repo) {
    return { attempted: false, success: false, pr_url: null, reason: 'invalid_repo_name' };
  }

  try {
    const octokit = await githubService.getInstallationClient(meta.installation_uuid);
    const repoInfo = await octokit.repos.get({ owner, repo });
    const baseBranch = String(repoInfo.data.default_branch || 'main');

    const baseRef = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`,
    });

    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
    let branch = `deplai/iac-structure-${timestamp}`;
    let branchCreated = false;
    let attempt = 0;
    while (!branchCreated && attempt < 4) {
      const suffix = attempt === 0 ? '' : `-${attempt}`;
      const candidate = `${branch}${suffix}`;
      try {
        await octokit.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${candidate}`,
          sha: baseRef.data.object.sha,
        });
        branch = candidate;
        branchCreated = true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err || '');
        if (!/Reference already exists/i.test(msg)) throw err;
        attempt += 1;
      }
    }
    if (!branchCreated) {
      return {
        attempted: true,
        success: false,
        pr_url: null,
        reason: 'branch_creation_failed',
        error: 'Could not allocate a unique branch name for IaC PR.',
      };
    }

    let committed = 0;
    for (const file of persistable) {
      const safePath = normalizeRepoWritePath(file.path);
      if (!safePath) continue;

      let existingSha: string | undefined;
      try {
        const existing = await octokit.repos.getContent({
          owner,
          repo,
          path: safePath,
          ref: branch,
        });
        if (!Array.isArray(existing.data) && existing.data.type === 'file') {
          existingSha = existing.data.sha;
        }
      } catch {
        existingSha = undefined;
      }

      const contentBase64 = file.encoding === 'base64'
        ? file.content
        : Buffer.from(file.content, 'utf-8').toString('base64');

      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: safePath,
        message: existingSha ? `chore(iac): update ${safePath}` : `feat(iac): add ${safePath}`,
        content: contentBase64,
        branch,
        ...(existingSha ? { sha: existingSha } : {}),
      });
      committed += 1;
    }

    if (committed === 0) {
      return {
        attempted: true,
        success: false,
        pr_url: null,
        branch,
        reason: 'no_changes_to_commit',
      };
    }

    const pr = await octokit.pulls.create({
      owner,
      repo,
      base: baseBranch,
      head: branch,
      title: `feat(iac): structured Terraform bundle for ${projectName}`,
      body: [
        'This PR was generated by DeplAI pipeline IaC stage.',
        '',
        'Highlights:',
        '- Structured Terraform layout (`providers.tf`, `backend.tf`, `main.tf`, `variables.tf`, `terraform.tfvars`, `outputs.tf`)',
        '- Modularized resources (`modules/`)',
        '- Environment overlays (`environments/dev`, `environments/prod`)',
        '- Free-tier-eligible defaults with production-aware hardening baseline',
      ].join('\n'),
      maintainer_can_modify: true,
    });

    return {
      attempted: true,
      success: true,
      pr_url: pr.data.html_url || null,
      branch,
      files_committed: committed,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to persist IaC as PR.';
    return {
      attempted: true,
      success: false,
      pr_url: null,
      reason: 'persist_failed',
      error: message,
    };
  }
}

function clampProvider(value: string | undefined): Provider {
  const v = (value || '').trim().toLowerCase();
  if (v === 'azure' || v === 'gcp') return v;
  return 'aws';
}

function clampIacMode(value: string | undefined): IacMode {
  return String(value || '').trim().toLowerCase() === 'llm' ? 'llm' : 'deterministic';
}

function clampLlmProvider(value: string | undefined): LlmProvider {
  const provider = String(value || '').trim().toLowerCase();
  if (provider === 'groq' || provider === 'openrouter' || provider === 'ollama' || provider === 'opencode' || provider === 'openai') {
    return provider;
  }
  return 'groq';
}

function normalizeApiBaseUrl(value: string | undefined): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

function extractTextContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const text = (item as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function parseJsonDocument(rawText: string): unknown | null {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return null;

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const candidates: string[] = [unfenced];
  const firstObjectStart = unfenced.indexOf('{');
  const lastObjectEnd = unfenced.lastIndexOf('}');
  if (firstObjectStart >= 0 && lastObjectEnd > firstObjectStart) {
    candidates.push(unfenced.slice(firstObjectStart, lastObjectEnd + 1));
  }

  const firstArrayStart = unfenced.indexOf('[');
  const lastArrayEnd = unfenced.lastIndexOf(']');
  if (firstArrayStart >= 0 && lastArrayEnd > firstArrayStart) {
    candidates.push(unfenced.slice(firstArrayStart, lastArrayEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function dedupeGeneratedFiles(files: GeneratedFile[]): GeneratedFile[] {
  const byPath = new Map<string, GeneratedFile>();
  for (const file of files) {
    const safePath = normalizeRepoWritePath(file.path);
    if (!safePath) continue;
    if (!safePath.startsWith('terraform/') && !safePath.startsWith('ansible/') && safePath !== 'README.md') continue;
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

function parseLlmGeneratedFiles(payload: unknown): GeneratedFile[] {
  let rawFiles: unknown[] = [];

  if (Array.isArray(payload)) {
    rawFiles = payload;
  } else if (payload && typeof payload === 'object') {
    const fromFiles = (payload as { files?: unknown }).files;
    if (Array.isArray(fromFiles)) {
      rawFiles = fromFiles;
    } else if (fromFiles && typeof fromFiles === 'object') {
      rawFiles = Object.entries(fromFiles as Record<string, unknown>).map(([path, content]) => ({ path, content }));
    }
  }

  const normalized = dedupeGeneratedFiles(
    rawFiles
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => {
        const row = entry as { path?: unknown; content?: unknown; encoding?: unknown };
        return {
          path: String(row.path || '').trim(),
          content: String(row.content || ''),
          encoding: row.encoding === 'base64' ? 'base64' : 'utf-8',
        } as GeneratedFile;
      }),
  );

  return normalized;
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

function resolveLlmConfig(provider: LlmProvider, modelOverride: string, apiBaseOverride: string): LlmResolvedConfig {
  const defaults: Record<LlmProvider, { model: string; base: string }> = {
    groq: {
      model: 'llama-3.3-70b-versatile',
      base: 'https://api.groq.com/openai/v1',
    },
    openrouter: {
      model: 'meta-llama/llama-3.3-70b-instruct:free',
      base: 'https://openrouter.ai/api/v1',
    },
    ollama: {
      model: 'llama3.1:8b',
      base: 'https://api.ollama.com/v1',
    },
    opencode: {
      model: 'openai/gpt-oss-20b',
      base: process.env.OPENCODE_API_BASE_URL || 'https://api.opencode.ai/v1',
    },
    openai: {
      model: 'gpt-4o-mini',
      base: 'https://api.openai.com/v1',
    },
  };

  return {
    provider,
    model: String(modelOverride || '').trim() || defaults[provider].model,
    apiBaseUrl: normalizeApiBaseUrl(apiBaseOverride || defaults[provider].base),
  };
}

async function generateIacBundleWithLlm(params: {
  provider: Provider;
  projectName: string;
  qaSummary: string;
  architectureContext: string;
  architectureJson: Record<string, unknown> | null;
  contextBlock: string;
  websiteIndexHtml: string;
  llmProvider: LlmProvider;
  llmModel: string;
  llmApiKey: string;
  llmApiBaseUrl: string;
}): Promise<{ files: GeneratedFile[]; provider: LlmProvider; model: string; summary: string }> {
  const resolved = resolveLlmConfig(params.llmProvider, params.llmModel, params.llmApiBaseUrl);
  const endpoint = `${resolved.apiBaseUrl}/chat/completions`;
  const architectureSnippet = params.architectureJson
    ? JSON.stringify(params.architectureJson, null, 2).slice(0, 24_000)
    : '{}';

  const requiredFiles = params.provider === 'aws'
    ? [
      'terraform/providers.tf',
      'terraform/backend.tf',
      'terraform/main.tf',
      'terraform/variables.tf',
      'terraform/terraform.tfvars',
      'terraform/outputs.tf',
    ]
    : [
      'terraform/main.tf',
      'terraform/variables.tf',
      'terraform/outputs.tf',
    ];

  const systemPrompt = [
    'You generate production-ready Terraform IaC bundles.',
    'Respond with strict JSON only. No markdown fences.',
    'JSON schema:',
    '{"summary":"string","files":[{"path":"terraform/main.tf","content":"..."}]}',
    'Every file object must have path and content as strings.',
    `Include required files: ${requiredFiles.join(', ')}`,
    'You may include ansible files and README.md.',
    'Keep output deterministic and valid Terraform syntax.',
  ].join('\n');

  const userPrompt = [
    `Cloud provider: ${params.provider}`,
    `Project: ${params.projectName}`,
    '',
    'Operator Q/A summary:',
    params.qaSummary || 'n/a',
    '',
    'Architecture context:',
    params.architectureContext || 'n/a',
    '',
    'Architecture JSON (trimmed):',
    architectureSnippet,
    '',
    'Security and repository context:',
    params.contextBlock || 'n/a',
    '',
    'Static website index html to host/use where relevant:',
    params.websiteIndexHtml || '<html><body>deplai</body></html>',
    '',
    'Return only JSON. No prose outside the JSON object.',
  ].join('\n');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (params.llmApiKey) {
    headers.Authorization = `Bearer ${params.llmApiKey}`;
  }
  if (resolved.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://deplai.local';
    headers['X-Title'] = 'DeplAI IaC Generator';
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: resolved.model,
      temperature: 0.15,
      max_tokens: 3200,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  const raw = await response.text();
  let parsedResponse: unknown;
  try {
    parsedResponse = JSON.parse(raw);
  } catch {
    parsedResponse = null;
  }

  if (!response.ok) {
    const message = parsedResponse && typeof parsedResponse === 'object'
      ? String((parsedResponse as { error?: { message?: unknown } }).error?.message || '').trim()
      : '';
    const fallbackMessage = String(raw || '').slice(0, 280).trim();
    throw new Error(message || fallbackMessage || `LLM provider returned HTTP ${response.status}.`);
  }

  const content = extractTextContent(
    parsedResponse && typeof parsedResponse === 'object'
      ? (parsedResponse as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
      : '',
  );

  const parsedPayload = parseJsonDocument(content);
  if (!parsedPayload) {
    throw new Error('LLM output was not valid JSON.');
  }

  const files = parseLlmGeneratedFiles(parsedPayload);
  if (files.length === 0) {
    throw new Error('LLM response did not include usable files.');
  }

  const summary = parsedPayload && typeof parsedPayload === 'object'
    ? String((parsedPayload as { summary?: unknown }).summary || '').trim()
    : '';

  return {
    files,
    provider: resolved.provider,
    model: resolved.model,
    summary,
  };
}

function toAwsProjectSlug(value: string): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  // Keep room for suffixes like "-security-logs-<8hex>" under S3's 63-char limit.
  const capped = normalized.slice(0, 40).replace(/-+$/, '');
  return capped || 'deplai-project';
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

function buildAwsSixFileBundle(
  projectName: string,
  safeProjectSlug: string,
  contextBlock: string,
  sec: ReturnType<typeof summarizeSecurity>,
  websiteIndexHtml: string,
  lowCostMode: boolean,
): GeneratedFile[] {
  const safeContext = contextBlock.replace(/\r/g, '');
  const ec2HtmlBase64 = Buffer.from(String(websiteIndexHtml || ''), 'utf-8').toString('base64');

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
  default = "${safeProjectSlug}"
}

variable "aws_region" {
  type    = string
  default = "eu-north-1"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "instance_type" {
  type    = string
  default = "t3.micro"
}

variable "enable_ec2" {
  type    = bool
  default = ${lowCostMode ? 'false' : 'true'}
}

variable "existing_ec2_key_pair_name" {
  type    = string
  default = ""
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
  default = ["eu-north-1a", "eu-north-1b", "eu-north-1c"]
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

variable "force_destroy_site_bucket" {
  type    = bool
  default = false
}

variable "ec2_root_volume_size" {
  type    = number
  default = 8
}

variable "bootstrap_index_html_base64" {
  type      = string
  default   = "${ec2HtmlBase64}"
  sensitive = true
}

variable "context_summary" {
  type    = string
  default = ""
}
`;

  const tfvars = `project_name = "${safeProjectSlug}"
aws_region = "eu-north-1"
environment = "dev"
instance_type = "t3.micro"
enable_ec2 = ${lowCostMode ? 'false' : 'true'}
existing_ec2_key_pair_name = ""
ingress_cidr_blocks = ["0.0.0.0/0"]
ssh_ingress_cidr_blocks = []
preferred_availability_zones = ["eu-north-1a", "eu-north-1b", "eu-north-1c"]
use_default_vpc = true
vpc_cidr_block = "10.42.0.0/16"
public_subnet_cidr = "10.42.1.0/24"
force_destroy_site_bucket = false
ec2_root_volume_size = 8
bootstrap_index_html_base64 = "${ec2HtmlBase64}"
context_summary = <<-EOT
${safeContext}
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
  preferred_azs = length(var.preferred_availability_zones) > 0 ? [for az in var.preferred_availability_zones : az if contains(data.aws_availability_zones.available.names, az)] : data.aws_availability_zones.available.names
  selected_az   = length(local.preferred_azs) > 0 ? local.preferred_azs[0] : data.aws_availability_zones.available.names[0]
  default_subnet_ids = try(data.aws_subnets.default[0].ids, [])
}

data "aws_subnet" "default_details" {
  for_each = var.use_default_vpc ? toset(local.default_subnet_ids) : toset([])
  id       = each.value
}

locals {
  preferred_default_subnet_ids = [for s in values(data.aws_subnet.default_details) : s.id if contains(local.preferred_azs, s.availability_zone)]
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
  selected_vpc_id        = var.use_default_vpc ? data.aws_vpc.default[0].id : aws_vpc.main[0].id
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
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "tls_private_key" "generated" {
  count     = var.enable_ec2 && trimspace(var.existing_ec2_key_pair_name) == "" ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "generated" {
  count      = var.enable_ec2 && trimspace(var.existing_ec2_key_pair_name) == "" ? 1 : 0
  key_name   = "\${var.project_name}-key"
  public_key = tls_private_key.generated[0].public_key_openssh
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

  user_data = join("\n", [
    "#!/bin/bash",
    "set -euxo pipefail",
    "dnf install -y nginx",
    "mkdir -p /usr/share/nginx/html",
    "printf '%s' \"\${var.bootstrap_index_html_base64}\" | base64 --decode > /usr/share/nginx/html/index.html",
    "systemctl enable nginx",
    "systemctl restart nginx",
  ])
}

resource "random_id" "bucket_suffix" {
  byte_length = 4
  keepers = {
    project_name = var.project_name
  }
}

resource "aws_s3_bucket" "website" {
  bucket        = "\${var.project_name}-site-\${random_id.bucket_suffix.hex}"
  force_destroy = var.force_destroy_site_bucket
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "website" {
  bucket                  = aws_s3_bucket.website.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "website" {
  bucket = aws_s3_bucket.website.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_object" "index" {
  bucket       = aws_s3_bucket.website.id
  key          = "index.html"
  content      = base64decode(var.bootstrap_index_html_base64)
  content_type = "text/html"
}

resource "aws_cloudfront_origin_access_control" "oac" {
  name                              = "\${var.project_name}-oac-\${random_id.bucket_suffix.hex}"
  description                       = "OAC for website bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "website" {
  enabled             = true
  default_root_object = "index.html"
  tags                = local.tags

  origin {
    domain_name              = aws_s3_bucket.website.bucket_regional_domain_name
    origin_id                = "s3-website-origin"
    origin_access_control_id = aws_cloudfront_origin_access_control.oac.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-website-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }
  }

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

resource "aws_s3_bucket_policy" "website" {
  bucket = aws_s3_bucket.website.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action = ["s3:GetObject"]
      Resource = ["\${aws_s3_bucket.website.arn}/*"]
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.website.arn
        }
      }
    }]
  })
}
`;

  const outputsTf = `output "cloudfront_url" { value = "https://\${aws_cloudfront_distribution.website.domain_name}" }
output "cloudfront_domain" { value = aws_cloudfront_distribution.website.domain_name }
output "website_bucket_name" { value = aws_s3_bucket.website.id }
output "ec2_instance_id" { value = try(aws_instance.app[0].id, null) }
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
output "availability_warning" {
  value = var.environment == "production" && var.enable_ec2 ? "Single-AZ EC2 deployment detected. Consider multi-AZ architecture for HA." : ""
}
output "generated_ec2_private_key_pem" {
  value     = try(tls_private_key.generated[0].private_key_pem, null)
  sensitive = true
}
output "security_summary" {
  value = {
    code_findings = ${sec.totalCodeFindings}
    supply_findings = ${sec.totalSupplyFindings}
    critical_or_high_supply = ${sec.criticalOrHighSupply}
    high_cwe = "${sec.highCwe.join(', ') || 'none'}"
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
# replace with your hosts
example-host ansible_host=127.0.0.1 ansible_user=ubuntu
`;

  const readme = `# IaC Bundle - ${projectName}

Standard 6-file Terraform fallback bundle generated by DeplAI.

Budget mode: ${lowCostMode ? 'strict <= $1 target (EC2 disabled by default)' : 'standard'}

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
    const llmProvider = clampLlmProvider(body.llm_provider);
    const llmApiKey = String(body.llm_api_key || body.openai_api_key || '').trim();
    const llmModel = String(body.llm_model || '').trim();
    const llmApiBaseUrl = normalizeApiBaseUrl(body.llm_api_base_url);
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
      const scanStatusRes = await fetch(`${AGENTIC_URL}/api/scan/status/${projectId}`, {
        headers: agenticHeaders(),
        signal: AbortSignal.timeout(30_000),
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
        const scanRes = await fetch(`${AGENTIC_URL}/api/scan/results/${projectId}`, {
          headers: agenticHeaders(),
          signal: AbortSignal.timeout(30_000),
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
        iacWarnings.push('Strict low-cost mode enabled (<= $1). EC2 defaults are disabled and bulk website asset mirroring is skipped.');
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
        iacWarnings.push(`Primary website entrypoint resolved to '${websiteEntrypoint.relativePath}' (${websiteEntrypoint.reason}).`);
      } else {
        iacWarnings.push(`No HTML entrypoint was detected (${websiteEntrypoint.reason}); using a generated index.html.`);
      }
    }

    if (provider === 'aws') {
      if (!hasArchitectureJson) {
        return NextResponse.json(
          { error: 'AWS Terraform generation requires architecture_json.' },
          { status: 400 },
        );
      }

      const safeProjectSlug = toAwsProjectSlug(projectName);
      const deterministicFiles = [
        ...buildAwsSixFileBundle(projectName, safeProjectSlug, contextBlock, sec, websiteIndexHtml, lowCostMode),
        ...buildWebsiteSiteFiles(effectiveWebsiteAssets, websiteIndexHtml),
      ];

      let files = deterministicFiles;
      let source = 'connector_aws_bundle';
      let llmSummary = '';
      if (iacMode === 'llm') {
        if (!llmApiKey && llmProvider !== 'ollama') {
          return NextResponse.json(
            { error: `LLM mode requires llm_api_key for provider '${llmProvider}'.` },
            { status: 400 },
          );
        }
        try {
          const llmResult = await generateIacBundleWithLlm({
            provider,
            projectName,
            qaSummary: qa,
            architectureContext: arch,
            architectureJson: architectureValidation?.normalized || null,
            contextBlock,
            websiteIndexHtml,
            llmProvider,
            llmModel,
            llmApiKey,
            llmApiBaseUrl,
          });
          const llmFiles = mergeGeneratedFiles(llmResult.files, buildWebsiteSiteFiles(effectiveWebsiteAssets, websiteIndexHtml));
          if (!hasRequiredAwsCoreFiles(llmFiles)) {
            throw new Error('LLM output missed required AWS Terraform core files.');
          }
          files = llmFiles;
          source = `llm_${llmResult.provider}`;
          llmSummary = llmResult.summary;
          iacWarnings.push(`IaC generated via ${llmResult.provider} using model '${llmResult.model}'.`);
        } catch (llmErr) {
          source = 'connector_aws_bundle_fallback';
          iacWarnings.push(`LLM IaC generation failed; falling back to deterministic bundle. Reason: ${llmErr instanceof Error ? llmErr.message : 'unknown error'}`);
        }
      }

      const allWarnings = [
        ...scanContextWarnings,
        ...iacWarnings,
        `IaC generation mode: ${iacMode}.`,
        source.startsWith('llm_')
          ? 'Generated Terraform bundle from selected LLM provider and repository context.'
          : 'Generated Terraform bundle locally from repository analysis, interactive Q&A context, and the selected AWS region.',
        'Terraform files use a local backend by default. AWS credentials are only needed later for apply/deploy.',
      ];
      const iacRepoPr = await persistIacToRepoPr(String(user.id), projectId, projectName, files);
      if (iacRepoPr.attempted && !iacRepoPr.success) {
        const persistenceMsg = iacRepoPr.error || iacRepoPr.reason || 'IaC repo persistence failed.';
        allWarnings.push(`IaC PR persistence: ${persistenceMsg}`);
      }

      return NextResponse.json({
        success: true,
        provider,
        project_id: projectId,
        project_name: projectName,
        summary: llmSummary || `Generated ${files.length} Terraform files from repository analysis and operator context.`,
        files,
        security_context: sec,
        source,
        run_id: null,
        workspace: null,
        provider_version: null,
        state_bucket: null,
        lock_table: null,
        manifest: [],
        dag_order: [],
        iac_repo_pr: iacRepoPr,
        warnings: allWarnings,
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
    let files = deterministicFiles;
    let source = 'template';
    let llmSummary = '';

    if (iacMode === 'llm') {
      if (!llmApiKey && llmProvider !== 'ollama') {
        return NextResponse.json(
          { error: `LLM mode requires llm_api_key for provider '${llmProvider}'.` },
          { status: 400 },
        );
      }
      try {
        const llmResult = await generateIacBundleWithLlm({
          provider,
          projectName,
          qaSummary: qa,
          architectureContext: arch,
          architectureJson: architectureValidation?.normalized || null,
          contextBlock,
          websiteIndexHtml,
          llmProvider,
          llmModel,
          llmApiKey,
          llmApiBaseUrl,
        });
        files = llmResult.files;
        source = `llm_${llmResult.provider}`;
        llmSummary = llmResult.summary;
        iacWarnings.push(`IaC generated via ${llmResult.provider} using model '${llmResult.model}'.`);
      } catch (llmErr) {
        source = 'template_fallback';
        iacWarnings.push(`LLM IaC generation failed; using deterministic provider template. Reason: ${llmErr instanceof Error ? llmErr.message : 'unknown error'}`);
      }
    }

    const iacRepoPr = await persistIacToRepoPr(String(user.id), projectId, projectName, files);
    if (iacRepoPr.attempted && !iacRepoPr.success) {
      const persistenceMsg = iacRepoPr.error || iacRepoPr.reason || 'IaC repo persistence failed.';
      iacWarnings.push(`IaC PR persistence: ${persistenceMsg}`);
    }

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
      website_asset_stats: null,
      frontend_entrypoint_detection: null,
    });
  } catch (err) {
    const classified = classifyAgenticRouteError(err, 'generate Terraform and Ansible files');
    return NextResponse.json({ error: classified.message }, { status: classified.status });
  }
}


