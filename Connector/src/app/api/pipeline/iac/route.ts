import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { validateArchitectureJson } from '@/lib/architecture-contract';
import { query } from '@/lib/db';
import { githubService } from '@/lib/github';
import { getLegacyRootRuntimeStatus, getLegacyTerraformRagStatus } from '@/lib/legacy-assets';
import fs from 'fs';
import path from 'path';

type Provider = 'aws' | 'azure' | 'gcp';

interface ScanResultsData {
  supply_chain?: Array<{ cve_id?: string; severity?: string; fix_version?: string }>;
  code_security?: Array<{ cwe_id?: string; severity?: string; count?: number }>;
}

interface IacGenerateBody {
  project_id: string;
  provider?: Provider;
  qa_summary?: string;
  architecture_context?: string;
  // Optional: full architecture JSON for RAG-based Terraform generation
  architecture_json?: Record<string, unknown>;
  // Optional: OpenAI key forwarded to the RAG agent
  openai_api_key?: string;
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
  const meta = await resolveProjectMeta(userId, projectId);
  if (!meta) return null;

  if (meta.project_type === 'github' && meta.repo_full_name && meta.installation_uuid) {
    const [owner, repo] = meta.repo_full_name.split('/');
    if (owner && repo) {
      try {
        const repoRoot = await githubService.ensureRepoFresh(meta.installation_uuid, owner, repo);
        if (repoRoot && fs.existsSync(repoRoot) && fs.statSync(repoRoot).isDirectory()) {
          return repoRoot;
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  const localBase = path.join(process.cwd(), 'tmp', 'local-projects', userId, projectId);
  if (fs.existsSync(localBase) && fs.statSync(localBase).isDirectory()) {
    return localBase;
  }

  return null;
}

async function resolveProjectMeta(
  userId: string,
  projectId: string,
): Promise<ProjectMetaRow | null> {
  let rows = await query<ProjectMetaRow[]>(
    `SELECT
      p.project_type,
      gr.full_name AS repo_full_name,
      gi.id AS installation_uuid
    FROM projects p
    LEFT JOIN github_repositories gr ON p.repository_id = gr.id
    LEFT JOIN github_installations gi ON gr.installation_id = gi.id
    WHERE p.id = ?`,
    [projectId],
  );

  // For GitHub selections, the dashboard project id is usually github_repositories.id,
  // not projects.id. Fall back to resolving metadata directly from github_repositories.
  if (!rows[0]) {
    rows = await query<ProjectMetaRow[]>(
      `SELECT
        'github' AS project_type,
        gr.full_name AS repo_full_name,
        gi.id AS installation_uuid
      FROM github_repositories gr
      JOIN github_installations gi ON gr.installation_id = gi.id
      WHERE gr.id = ? AND gi.user_id = ?
      LIMIT 1`,
      [projectId, userId],
    );
  }
  return rows[0] || null;
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

function resolveWebsiteBlockPublicAccess(qaSummary: string, architectureContext: string): boolean {
  const qaText = String(qaSummary || '');
  const text = `${qaText}\n${architectureContext}`.toLowerCase();
  // Default secure posture with CloudFront OAC.
  if (!text.trim()) return true;

  // Prefer explicit Q/A parsing from stage-6 answers:
  // Q: ...Block Public Access...
  // A: yes/no/on/off
  const qaPairs = qaText.split(/\n\s*\n/g);
  for (const pair of qaPairs) {
    const question = (pair.match(/Q:\s*(.+)/i)?.[1] || '').toLowerCase();
    const answer = (pair.match(/A:\s*(.+)/i)?.[1] || '').toLowerCase();
    if (!question || !answer) continue;
    if (!question.includes('block public access')) continue;

    if (
      /\b(off|disable|disabled|no|false)\b/.test(answer) &&
      !/\b(on)\b/.test(answer)
    ) {
      return false;
    }
    if (
      /\b(on|enable|enabled|yes|true)\b/.test(answer) &&
      !/\b(off)\b/.test(answer)
    ) {
      return true;
    }
  }

  const explicitOff =
    text.includes('block public access off') ||
    text.includes('block public access: off') ||
    text.includes('disable block public access') ||
    text.includes('public access block off');
  if (explicitOff) return false;

  const explicitOn =
    text.includes('block public access on') ||
    text.includes('block public access: on') ||
    text.includes('enable block public access') ||
    text.includes('public access block on');
  if (explicitOn) return true;

  return true;
}

function buildAwsBundle(
  projectName: string,
  awsProjectSlug: string,
  contextBlock: string,
  sec: ReturnType<typeof summarizeSecurity>,
  siteAssets: WebsiteAsset[],
  siteIndexHtml: string,
  websiteBlockPublicAccess: boolean,
): GeneratedFile[] {
  const ec2HtmlBase64 = Buffer.from(siteIndexHtml, 'utf-8').toString('base64');
  const siteFiles = buildWebsiteSiteFiles(siteAssets, siteIndexHtml);
  const safeProjectSlug = awsProjectSlug.replace(/"/g, '');
  const tfContext = String(contextBlock || '').replace(/\r/g, '').trim() || 'No additional operator context was provided.';

  const providersTf = `terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}
`;

  const backendTf = `terraform {
  backend "local" {
    path = "deplai.tfstate"
  }
}
`;

  const mainTf = `locals {
  common_tags = {
    Project     = var.project_name
    ManagedBy   = "deplai"
    Environment = var.environment
  }
}

module "network" {
  source = "./modules/network"

  preferred_availability_zones = var.preferred_availability_zones
}

module "security" {
  source = "./modules/security"

  project_name        = var.project_name
  vpc_id              = module.network.vpc_id
  ingress_cidr_blocks = var.ingress_cidr_blocks
  tags                = local.common_tags
}

module "compute" {
  source = "./modules/compute"

  project_name                = var.project_name
  enable_ec2                  = var.enable_ec2
  instance_type               = var.instance_type
  subnet_id                   = module.network.selected_subnet_id
  vpc_security_group_ids      = [module.security.web_security_group_id]
  existing_ec2_key_pair_name  = var.existing_ec2_key_pair_name
  ec2_root_volume_size        = var.ec2_root_volume_size
  bootstrap_index_html_base64 = var.bootstrap_index_html_base64
  tags                        = local.common_tags
}

module "website" {
  source = "./modules/website"

  project_name              = var.project_name
  site_asset_root           = "\${path.root}/site"
  block_public_access       = var.website_block_public_access
  force_destroy_site_bucket = var.force_destroy_site_bucket
  tags                      = local.common_tags
}

module "observability" {
  source = "./modules/observability"

  project_name       = var.project_name
  environment        = var.environment
  log_retention_days = var.log_retention_days
  enable_ec2         = var.enable_ec2
  instance_id        = try(module.compute.instance_id, "")
  tags               = local.common_tags
}

# Security context snapshot:
# - Code findings: ${sec.totalCodeFindings}
# - Supply findings: ${sec.totalSupplyFindings}
# - Critical/high supply findings: ${sec.criticalOrHighSupply}
# - High-impact CWEs: ${sec.highCwe.join(', ') || 'none'}
`;

  const varsTf = `variable "project_name" {
  type        = string
  description = "Project identifier used for resource naming."
  default     = "${safeProjectSlug}"
}

variable "aws_region" {
  type        = string
  description = "AWS region where resources will be created."
  default     = "eu-north-1"
}

variable "environment" {
  type        = string
  description = "Environment label for tagging and overlays."
  default     = "dev"
}

variable "preferred_availability_zones" {
  type        = list(string)
  description = "Preferred AZ order for instance placement."
  default     = ["eu-north-1a", "eu-north-1b", "eu-north-1c"]
}

variable "instance_type" {
  type        = string
  description = "EC2 instance type (kept free-tier eligible by default)."
  default     = "t3.micro"
}

variable "enable_ec2" {
  type        = bool
  description = "Whether to provision EC2 compute."
  default     = true
}

variable "existing_ec2_key_pair_name" {
  type        = string
  description = "Existing EC2 key pair name to attach. Leave empty to auto-generate one."
  default     = ""
}

variable "ingress_cidr_blocks" {
  type        = list(string)
  description = "Inbound CIDR ranges for SSH/HTTP/HTTPS."
  default     = ["0.0.0.0/0"]
}

variable "website_block_public_access" {
  type        = bool
  description = "Whether to enforce S3 Block Public Access for website bucket."
  default     = ${websiteBlockPublicAccess ? 'true' : 'false'}
}

variable "force_destroy_site_bucket" {
  type        = bool
  description = "Allow destroy for non-production cleanups."
  default     = true
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch log retention."
  default     = 30
}

variable "ec2_root_volume_size" {
  type        = number
  description = "Root volume size in GiB."
  default     = 8
}

variable "bootstrap_index_html_base64" {
  type        = string
  description = "Base64-encoded HTML used for EC2 bootstrap landing page."
  default     = "${ec2HtmlBase64}"
  sensitive   = true
}

variable "context_summary" {
  type        = string
  description = "Human context captured during Q/A and architecture stages."
  default     = ""
}
`;

  const terraformTfvars = `project_name = "${safeProjectSlug}"
aws_region = "eu-north-1"
environment = "dev"
instance_type = "t3.micro"
enable_ec2 = true
preferred_availability_zones = ["eu-north-1a", "eu-north-1b", "eu-north-1c"]
ingress_cidr_blocks = ["0.0.0.0/0"]
existing_ec2_key_pair_name = ""
website_block_public_access = ${websiteBlockPublicAccess ? 'true' : 'false'}
force_destroy_site_bucket = true
log_retention_days = 30
ec2_root_volume_size = 8
bootstrap_index_html_base64 = "${ec2HtmlBase64}"

context_summary = <<-EOT
${tfContext}
EOT
`;

  const outputsTf = `output "security_logs_bucket" {
  value       = module.website.security_logs_bucket
  description = "S3 bucket for security and application logs."
}

output "app_log_group" {
  value       = module.observability.log_group_name
  description = "CloudWatch log group for runtime logs."
}

output "instance_public_ip" {
  value       = module.compute.instance_public_ip
  description = "Public IP of EC2 instance."
}

output "ec2_instance_id" {
  value       = module.compute.instance_id
  description = "EC2 instance id."
}

output "ec2_instance_type" {
  value       = module.compute.instance_type
  description = "EC2 instance type."
}

output "ec2_ami_id" {
  value       = module.compute.ami_id
  description = "AMI id used for EC2."
}

output "ec2_public_dns" {
  value       = module.compute.public_dns
  description = "EC2 public DNS."
}

output "ec2_availability_zone" {
  value       = module.compute.availability_zone
  description = "EC2 availability zone."
}

output "ec2_subnet_id" {
  value       = module.compute.subnet_id
  description = "Subnet id where EC2 is deployed."
}

output "ec2_vpc_security_group_ids" {
  value       = module.compute.vpc_security_group_ids
  description = "Security groups attached to EC2."
}

output "ec2_key_name" {
  value       = module.compute.ec2_key_name
  description = "Selected EC2 key pair name."
}

output "generated_ec2_private_key_pem" {
  value       = module.compute.generated_private_key_pem
  description = "Generated private key PEM when existing key name is not provided."
  sensitive   = true
}

output "vpc_id" {
  value       = module.network.vpc_id
  description = "Target VPC id."
}

output "subnet_ids" {
  value       = module.network.subnet_ids
  description = "Candidate subnet ids in VPC."
}

output "selected_subnet_id" {
  value       = module.network.selected_subnet_id
  description = "Subnet selected for EC2 placement."
}

output "web_security_group_id" {
  value       = module.security.web_security_group_id
  description = "Security group used for web ingress."
}

output "instance_url" {
  value       = module.compute.instance_url
  description = "HTTP endpoint of EC2 instance."
}

output "website_bucket" {
  value       = module.website.website_bucket
  description = "S3 bucket hosting static site assets."
}

output "cloudfront_domain_name" {
  value       = module.website.cloudfront_domain_name
  description = "CloudFront domain name."
}

output "cloudfront_url" {
  value       = module.website.cloudfront_url
  description = "Public CloudFront URL."
}

output "s3_website_endpoint" {
  value       = module.website.s3_website_endpoint
  description = "S3 website endpoint."
}
`;

  const moduleNetworkMainTf = `data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default_in_vpc" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_subnet" "default_details" {
  for_each = toset(data.aws_subnets.default_in_vpc.ids)
  id       = each.value
}

locals {
  preferred_subnet_ids = [
    for subnet in data.aws_subnet.default_details :
    subnet.id if contains(var.preferred_availability_zones, subnet.availability_zone)
  ]

  selected_subnet_id = length(local.preferred_subnet_ids) > 0
    ? local.preferred_subnet_ids[0]
    : (length(data.aws_subnets.default_in_vpc.ids) > 0 ? data.aws_subnets.default_in_vpc.ids[0] : "")
}
`;

  const moduleNetworkVarsTf = `variable "preferred_availability_zones" {
  type        = list(string)
  description = "Preferred AZ order for subnet selection."
}
`;

  const moduleNetworkOutputsTf = `output "vpc_id" {
  value = data.aws_vpc.default.id
}

output "subnet_ids" {
  value = data.aws_subnets.default_in_vpc.ids
}

output "selected_subnet_id" {
  value = local.selected_subnet_id
}
`;

  const moduleSecurityMainTf = `resource "aws_security_group" "web" {
  name_prefix = "\${var.project_name}-web-"
  description = "Web and SSH ingress for application access"
  vpc_id      = var.vpc_id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ingress_cidr_blocks
  }

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.ingress_cidr_blocks
  }

  ingress {
    description = "HTTPS"
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

  tags = merge(var.tags, {
    Name = "\${var.project_name}-web"
  })
}
`;

  const moduleSecurityVarsTf = `variable "project_name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "ingress_cidr_blocks" {
  type        = list(string)
  description = "Allowed ingress CIDR blocks."
}

variable "tags" {
  type    = map(string)
  default = {}
}
`;

  const moduleSecurityOutputsTf = `output "web_security_group_id" {
  value = aws_security_group.web.id
}
`;

  const moduleComputeMainTf = `data "aws_ami" "amazon_linux" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }
}

resource "random_id" "suffix" {
  byte_length = 3
}

resource "tls_private_key" "ec2_ssh" {
  count     = var.enable_ec2 && trimspace(var.existing_ec2_key_pair_name) == "" ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "generated" {
  count      = var.enable_ec2 && trimspace(var.existing_ec2_key_pair_name) == "" ? 1 : 0
  key_name   = "\${var.project_name}-ssh-\${random_id.suffix.hex}"
  public_key = tls_private_key.ec2_ssh[0].public_key_openssh

  tags = merge(var.tags, {
    Name = "\${var.project_name}-ssh"
  })
}

locals {
  selected_ec2_key_name = !var.enable_ec2
    ? null
    : (
      trimspace(var.existing_ec2_key_pair_name) != ""
      ? trimspace(var.existing_ec2_key_pair_name)
      : try(aws_key_pair.generated[0].key_name, null)
    )
}

resource "aws_instance" "app" {
  count                       = var.enable_ec2 && trimspace(var.subnet_id) != "" ? 1 : 0
  ami                         = data.aws_ami.amazon_linux.id
  instance_type               = var.instance_type
  key_name                    = local.selected_ec2_key_name
  subnet_id                   = var.subnet_id
  vpc_security_group_ids      = var.vpc_security_group_ids
  associate_public_ip_address = true

  root_block_device {
    volume_size           = var.ec2_root_volume_size
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  user_data = <<-EOT
    #!/bin/bash
    set -euxo pipefail
    dnf update -y
    dnf install -y nginx
    systemctl enable nginx
    echo '\${var.bootstrap_index_html_base64}' | base64 -d > /usr/share/nginx/html/index.html
    systemctl restart nginx
  EOT

  tags = merge(var.tags, {
    Name = "\${var.project_name}-app"
  })
}
`;

  const moduleComputeVarsTf = `variable "project_name" {
  type = string
}

variable "enable_ec2" {
  type = bool
}

variable "instance_type" {
  type = string
}

variable "subnet_id" {
  type = string
}

variable "vpc_security_group_ids" {
  type = list(string)
}

variable "existing_ec2_key_pair_name" {
  type = string
}

variable "ec2_root_volume_size" {
  type = number
}

variable "bootstrap_index_html_base64" {
  type      = string
  sensitive = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
`;

  const moduleComputeOutputsTf = `output "instance_public_ip" {
  value = try(aws_instance.app[0].public_ip, null)
}

output "instance_id" {
  value = try(aws_instance.app[0].id, null)
}

output "instance_type" {
  value = try(aws_instance.app[0].instance_type, null)
}

output "ami_id" {
  value = try(aws_instance.app[0].ami, null)
}

output "public_dns" {
  value = try(aws_instance.app[0].public_dns, null)
}

output "availability_zone" {
  value = try(aws_instance.app[0].availability_zone, null)
}

output "subnet_id" {
  value = try(aws_instance.app[0].subnet_id, null)
}

output "vpc_security_group_ids" {
  value = try(aws_instance.app[0].vpc_security_group_ids, [])
}

output "ec2_key_name" {
  value = local.selected_ec2_key_name
}

output "generated_private_key_pem" {
  value     = try(tls_private_key.ec2_ssh[0].private_key_pem, null)
  sensitive = true
}

output "instance_url" {
  value = try("http://\${aws_instance.app[0].public_ip}", null)
}
`;

  const moduleWebsiteMainTf = `resource "random_id" "suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "security_logs" {
  bucket        = "\${var.project_name}-security-logs-\${random_id.suffix.hex}"
  force_destroy = true
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "security_logs" {
  bucket                  = aws_s3_bucket.security_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket" "website" {
  bucket        = "\${var.project_name}-site-\${random_id.suffix.hex}"
  force_destroy = var.force_destroy_site_bucket
  tags          = var.tags
}

resource "aws_s3_bucket_ownership_controls" "website" {
  bucket = aws_s3_bucket.website.id

  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_website_configuration" "website" {
  bucket = aws_s3_bucket.website.id

  index_document {
    suffix = "index.html"
  }

  error_document {
    key = "index.html"
  }
}

resource "aws_s3_bucket_public_access_block" "website" {
  bucket                  = aws_s3_bucket.website.id
  block_public_acls       = var.block_public_access
  block_public_policy     = var.block_public_access
  ignore_public_acls      = var.block_public_access
  restrict_public_buckets = var.block_public_access
}

locals {
  content_type_by_ext = {
    html  = "text/html"
    htm   = "text/html"
    css   = "text/css"
    js    = "application/javascript"
    mjs   = "application/javascript"
    json  = "application/json"
    map   = "application/json"
    txt   = "text/plain"
    xml   = "application/xml"
    svg   = "image/svg+xml"
    png   = "image/png"
    jpg   = "image/jpeg"
    jpeg  = "image/jpeg"
    gif   = "image/gif"
    webp  = "image/webp"
    ico   = "image/x-icon"
    woff  = "font/woff"
    woff2 = "font/woff2"
    ttf   = "font/ttf"
    eot   = "application/vnd.ms-fontobject"
    otf   = "font/otf"
  }
}

resource "aws_s3_object" "website_assets" {
  for_each = fileset(var.site_asset_root, "**")

  bucket = aws_s3_bucket.website.id
  key    = each.value
  source = "\${var.site_asset_root}/\${each.value}"
  etag   = filemd5("\${var.site_asset_root}/\${each.value}")

  content_type = lookup(
    local.content_type_by_ext,
    lower(element(reverse(split(".", each.value)), 0)),
    "application/octet-stream",
  )
}

resource "aws_cloudfront_origin_access_control" "website" {
  name                              = "\${var.project_name}-oac-\${random_id.suffix.hex}"
  description                       = "Origin access control for static website bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "cdn" {
  enabled             = true
  wait_for_deployment = false
  default_root_object = "index.html"

  origin {
    domain_name              = aws_s3_bucket.website.bucket_regional_domain_name
    origin_id                = "s3-origin-\${aws_s3_bucket.website.id}"
    origin_access_control_id = aws_cloudfront_origin_access_control.website.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-origin-\${aws_s3_bucket.website.id}"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  depends_on = [aws_s3_object.website_assets]
}

data "aws_iam_policy_document" "website_oac" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["\${aws_s3_bucket.website.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.cdn.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "website" {
  bucket = aws_s3_bucket.website.id
  policy = data.aws_iam_policy_document.website_oac.json
}
`;

  const moduleWebsiteVarsTf = `variable "project_name" {
  type = string
}

variable "site_asset_root" {
  type = string
}

variable "block_public_access" {
  type = bool
}

variable "force_destroy_site_bucket" {
  type = bool
}

variable "tags" {
  type    = map(string)
  default = {}
}
`;

  const moduleWebsiteOutputsTf = `output "security_logs_bucket" {
  value = aws_s3_bucket.security_logs.bucket
}

output "website_bucket" {
  value = aws_s3_bucket.website.bucket
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.cdn.domain_name
}

output "cloudfront_url" {
  value = "https://\${aws_cloudfront_distribution.cdn.domain_name}"
}

output "s3_website_endpoint" {
  value = aws_s3_bucket_website_configuration.website.website_endpoint
}
`;

  const moduleObservabilityMainTf = `resource "aws_cloudwatch_log_group" "app" {
  name              = "/deplai/\${var.project_name}/\${var.environment}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_cloudwatch_metric_alarm" "ec2_cpu_high" {
  count = var.enable_ec2 && trimspace(var.instance_id) != "" ? 1 : 0

  alarm_name          = "\${var.project_name}-\${var.environment}-ec2-cpu-high"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = var.instance_id
  }

  tags = var.tags
}
`;

  const moduleObservabilityVarsTf = `variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "log_retention_days" {
  type = number
}

variable "enable_ec2" {
  type = bool
}

variable "instance_id" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
`;

  const moduleObservabilityOutputsTf = `output "log_group_name" {
  value = aws_cloudwatch_log_group.app.name
}

output "cpu_alarm_name" {
  value = try(aws_cloudwatch_metric_alarm.ec2_cpu_high[0].alarm_name, null)
}
`;

  const envDevTfvars = `environment = "dev"
instance_type = "t3.micro"
enable_ec2 = true
force_destroy_site_bucket = true
log_retention_days = 14
`;

  const envProdTfvars = `environment = "prod"
instance_type = "t3.micro"
enable_ec2 = true
force_destroy_site_bucket = false
log_retention_days = 30
`;

  const envDevBackendHcl = `path = "deplai-dev.tfstate"
`;

  const envProdBackendHcl = `path = "deplai-prod.tfstate"
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

    - name: Disable root SSH login
      lineinfile:
        path: /etc/ssh/sshd_config
        regexp: '^#?PermitRootLogin'
        line: 'PermitRootLogin no'
      notify: restart ssh

    - name: Ensure UFW is enabled
      ufw:
        state: enabled
        policy: deny

    - name: Allow SSH through UFW
      ufw:
        rule: allow
        name: OpenSSH

    - name: Allow HTTP through UFW
      ufw:
        rule: allow
        port: '80'
        proto: tcp

    - name: Allow HTTPS through UFW
      ufw:
        rule: allow
        port: '443'
        proto: tcp

  handlers:
    - name: restart ssh
      service:
        name: ssh
        state: restarted
`;

  const inventory = `[all]
# replace with your hosts
example-host ansible_host=127.0.0.1 ansible_user=ubuntu
`;

  const readme = `# IaC Bundle - ${projectName}

Generated by DeplAI pipeline Step 9.

## Terraform Structure
- \`terraform/providers.tf\` -> provider + required providers
- \`terraform/backend.tf\` -> state backend declaration
- \`terraform/main.tf\` -> root module wiring
- \`terraform/variables.tf\` -> input contract
- \`terraform/terraform.tfvars\` -> baseline values
- \`terraform/outputs.tf\` -> deployment outputs
- \`terraform/modules/*\` -> reusable building blocks
- \`terraform/environments/dev|prod\` -> environment overlays

## Modules
- \`modules/network\`: default VPC and subnet selection by preferred AZ
- \`modules/security\`: web security group for SSH/HTTP/HTTPS
- \`modules/compute\`: EC2 + key pair generation fallback
- \`modules/website\`: S3 asset hosting + CloudFront OAC
- \`modules/observability\`: CloudWatch log group + CPU alarm baseline

## Free-tier + Production-aware defaults
- Instance default: \`t3.micro\`
- Root volume: encrypted \`gp3\` with \`8 GiB\`
- CloudFront in front of S3 with OAC
- IMDSv2 required on EC2
- Environment overlays under \`environments/\`

## Context
${contextBlock}

## Commands
\`\`\`bash
cd terraform
terraform init -backend-config=environments/dev/backend.hcl
terraform plan -var-file=terraform.tfvars -var-file=environments/dev/terraform.tfvars
\`\`\`

## Key Pair Handling
If \`existing_ec2_key_pair_name\` is empty, Terraform generates a key pair and exposes \`generated_ec2_private_key_pem\`. Download the \`.pem\` or \`.ppk\` immediately from the DeplAI UI.
`;

  return [
    { path: 'terraform/providers.tf', content: providersTf },
    { path: 'terraform/backend.tf', content: backendTf },
    { path: 'terraform/main.tf', content: mainTf },
    { path: 'terraform/variables.tf', content: varsTf },
    { path: 'terraform/terraform.tfvars', content: terraformTfvars },
    { path: 'terraform/outputs.tf', content: outputsTf },

    { path: 'terraform/modules/network/main.tf', content: moduleNetworkMainTf },
    { path: 'terraform/modules/network/variables.tf', content: moduleNetworkVarsTf },
    { path: 'terraform/modules/network/outputs.tf', content: moduleNetworkOutputsTf },

    { path: 'terraform/modules/security/main.tf', content: moduleSecurityMainTf },
    { path: 'terraform/modules/security/variables.tf', content: moduleSecurityVarsTf },
    { path: 'terraform/modules/security/outputs.tf', content: moduleSecurityOutputsTf },

    { path: 'terraform/modules/compute/main.tf', content: moduleComputeMainTf },
    { path: 'terraform/modules/compute/variables.tf', content: moduleComputeVarsTf },
    { path: 'terraform/modules/compute/outputs.tf', content: moduleComputeOutputsTf },

    { path: 'terraform/modules/website/main.tf', content: moduleWebsiteMainTf },
    { path: 'terraform/modules/website/variables.tf', content: moduleWebsiteVarsTf },
    { path: 'terraform/modules/website/outputs.tf', content: moduleWebsiteOutputsTf },

    { path: 'terraform/modules/observability/main.tf', content: moduleObservabilityMainTf },
    { path: 'terraform/modules/observability/variables.tf', content: moduleObservabilityVarsTf },
    { path: 'terraform/modules/observability/outputs.tf', content: moduleObservabilityOutputsTf },

    { path: 'terraform/environments/dev/terraform.tfvars', content: envDevTfvars },
    { path: 'terraform/environments/dev/backend.hcl', content: envDevBackendHcl },
    { path: 'terraform/environments/prod/terraform.tfvars', content: envProdTfvars },
    { path: 'terraform/environments/prod/backend.hcl', content: envProdBackendHcl },

    ...siteFiles,
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
    const legacyTerraform = getLegacyTerraformRagStatus();
    const legacyRuntime = getLegacyRootRuntimeStatus();
    const projectName = String(owned.project?.name || owned.project?.full_name || projectId).split('/').pop() || projectId;
    const qa = String(body.qa_summary || '').trim();
    const arch = String(body.architecture_context || '').trim();
    const architectureValidation = body.architecture_json
      ? validateArchitectureJson(body.architecture_json)
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
    try {
      const scanRes = await fetch(`${AGENTIC_URL}/api/scan/results/${projectId}`, {
        headers: agenticHeaders(),
        signal: AbortSignal.timeout(30_000),
      });
      if (scanRes.ok) {
        const payload = await scanRes.json() as { data?: ScanResultsData };
        scanData = payload.data || {};
      }
    } catch {
      scanData = {};
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

    const awsProjectSlug = toAwsProjectSlug(projectName);
    const websiteBlockPublicAccess = resolveWebsiteBlockPublicAccess(qa, arch);

    // Keep AWS generation deterministic so runtime deploy always includes EC2+S3+CloudFront
    // and repository file mirroring behavior remains consistent.
    if (hasArchitectureJson && provider !== 'aws') {
      try {
        const ragRes = await fetch(`${AGENTIC_URL}/api/terraform/generate`, {
          method: 'POST',
          headers: { ...agenticHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            architecture_json: architectureValidation?.normalized,
            provider,
            project_name: projectName,
            qa_summary: qa || null,
            openai_api_key: body.openai_api_key || null,
          }),
          signal: AbortSignal.timeout(300_000),
        });
        const ragData = await ragRes.json() as {
          success: boolean; source?: string; files?: GeneratedFile[];
          readme?: string; error?: string;
        };

        if (ragData.success && ragData.source === 'rag_agent' && Array.isArray(ragData.files)) {
          const iacRepoPr = await persistIacToRepoPr(String(user.id), projectId, projectName, ragData.files);
          return NextResponse.json({
            success: true,
            provider,
            project_id: projectId,
            project_name: projectName,
            summary: `Generated ${ragData.files.length} IaC files via Terraform RAG agent.`,
            files: ragData.files,
            security_context: sec,
            source: 'rag_agent',
            iac_repo_pr: iacRepoPr,
            legacy_assets: {
              terraform_rag: legacyTerraform,
              runtime_reference: legacyRuntime,
            },
          });
        }
        // source === 'unavailable' or other failure -> fall through to templates
      } catch {
        // RAG agent unreachable -> fall through
      }
    }

    // Template fallback
    const files = provider === 'azure'
      ? buildAzureBundle(projectName, contextBlock, sec)
      : provider === 'gcp'
        ? buildGcpBundle(projectName, contextBlock, sec)
        : buildAwsBundle(
          projectName,
          awsProjectSlug,
          contextBlock,
          sec,
          websiteAssets,
          websiteIndexHtml,
          websiteBlockPublicAccess,
        );
    const iacRepoPr = await persistIacToRepoPr(String(user.id), projectId, projectName, files);
    if (iacRepoPr.attempted && !iacRepoPr.success) {
      const persistenceMsg = iacRepoPr.error || iacRepoPr.reason || 'IaC repo persistence failed.';
      iacWarnings.push(`IaC PR persistence: ${persistenceMsg}`);
    }

    const summary = provider === 'aws' && iacWarnings.length > 0
      ? `Generated ${files.length} IaC files for ${provider.toUpperCase()} with ${iacWarnings.length} packaging warning(s).`
      : `Generated ${files.length} IaC files for ${provider.toUpperCase()}.`;

    return NextResponse.json({
      success: true,
      provider,
      project_id: projectId,
      project_name: projectName,
      summary,
      files,
      security_context: sec,
      source: 'template',
      iac_repo_pr: iacRepoPr,
      warnings: iacWarnings,
      website_asset_stats: provider === 'aws'
        ? {
          selected_root: websiteCollection?.selectedRoot || '',
          asset_count: websiteAssets.length,
          total_bytes: websiteCollection?.totalBytes || 0,
          truncated: Boolean(websiteCollection?.truncated),
          skipped_large_files: websiteCollection?.skippedLargeFiles || 0,
          entrypoint: websiteEntrypoint.relativePath,
        }
        : null,
      frontend_entrypoint_detection: provider === 'aws' ? frontendDetection : null,
      legacy_assets: {
        terraform_rag: legacyTerraform,
        runtime_reference: legacyRuntime,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to generate IaC bundle';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

