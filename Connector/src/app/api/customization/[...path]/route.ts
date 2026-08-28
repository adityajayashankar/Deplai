import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { query } from '@/lib/db';
import { githubService } from '@/lib/github';
import fs from 'fs';
import path from 'path';
import {
  findLatestSession,
  mapUiuxRunStatus,
  resolveOrCreateSession,
  tryAppendSessionLogs,
} from '@/lib/sessions/store';
import { resolveWorkflowLlmConfig } from '@/lib/ai-platform/workflow-llm';
import { mapConnectorSourceToCustomization } from '@/lib/customization-snapshot';

const DEFAULT_CUSTOMIZATION_BACKEND = 'http://127.0.0.1:8010';
const DEFAULT_UIUX_AGENT_BACKEND = 'http://127.0.0.1:7777';
const DEFAULT_UIUX_WORKFLOW_ID = 'uiux-refactor-agent';
const PREVIEW_ENTRY_CANDIDATES = [
  'sandbox-index.html',
  'index.html',
  'index.htm',
  'index.html.html',
  'public/index.html',
  'dist/index.html',
  'build/index.html',
  'frontend/index.html',
];

const LOCAL_PROJECTS_ROOT = path.resolve(process.cwd(), 'tmp', 'local-projects');

type ProjectPathRow = {
  id: string;
  project_type: 'local' | 'github';
  local_path: string | null;
  user_id: string;
  repo_full_name: string | null;
  installation_uuid: string | null;
  installation_user_id: string | null;
};

type GitHubRepoPathRow = {
  id: string;
  full_name: string | null;
  installation_uuid: string | null;
  installation_user_id: string | null;
  linked_user_id: string | null;
};

type BackendPreviewStatus = {
  kind?: 'live_server' | 'static_file';
  status?: 'ready' | 'unavailable' | 'failed' | 'stopped' | 'starting';
  url?: string;
  detail?: string;
};

type PreviewContext = {
  normalizedProjectId: string;
  requestedTenantId: string;
};

class ProxyResolutionError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isWithinPath(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root).toLowerCase();
  const normalizedCandidate = path.resolve(candidate).toLowerCase();
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function parseRepoFullName(fullName: string | null): { owner: string; repo: string } | null {
  if (!fullName) return null;
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

function getContentTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.woff') return 'font/woff';
  if (ext === '.woff2') return 'font/woff2';
  if (ext === '.ttf') return 'font/ttf';
  if (ext === '.otf') return 'font/otf';
  if (ext === '.map') return 'application/json; charset=utf-8';

  return 'application/octet-stream';
}

function detectPreviewEntry(repoPath: string, baseRepoPath?: string): string | null {
  for (const candidate of PREVIEW_ENTRY_CANDIDATES) {
    const absoluteCandidate = path.resolve(repoPath, candidate);
    if (isWithinPath(repoPath, absoluteCandidate) && fs.existsSync(absoluteCandidate) && fs.statSync(absoluteCandidate).isFile()) {
      return candidate;
    }
    if (baseRepoPath) {
      const baseCandidate = path.resolve(baseRepoPath, candidate);
      if (isWithinPath(baseRepoPath, baseCandidate) && fs.existsSync(baseCandidate) && fs.statSync(baseCandidate).isFile()) {
        return candidate;
      }
    }
  }
  return null;
}

function buildPreviewRouteBase(context: PreviewContext, directoryPrefix = ''): string {
  const tenantPathPrefix = context.requestedTenantId
    ? `_tenant/${encodeURIComponent(context.requestedTenantId)}/`
    : '';
  const normalizedDirectoryPrefix = directoryPrefix.replace(/^\/+|\/+$/g, '');
  return `/api/customization/preview/${encodeURIComponent(context.normalizedProjectId)}/${tenantPathPrefix}${normalizedDirectoryPrefix ? `${normalizedDirectoryPrefix}/` : ''}`;
}

function setPreviewFrameHeaders(headers: Headers): void {
  headers.set('x-frame-options', 'SAMEORIGIN');
  headers.set('content-security-policy', "frame-ancestors 'self'");
}

function rewritePreviewHtmlBase(html: string, baseHref: string): string {
  if (/<base\s+/i.test(html)) {
    return html.replace(/<base\s+href=["'][^"']*["']\s*\/?\s*>/i, `<base href="${baseHref}">`);
  }
  return html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`);
}

function rewriteLivePreviewHtml(html: string, context: PreviewContext, servedRelativePath: string): string {
  const relativeDirectory = path.posix.dirname(servedRelativePath.replace(/\\/g, '/'));
  const directoryPrefix = relativeDirectory === '.' ? '' : relativeDirectory;
  const baseHref = buildPreviewRouteBase(context, directoryPrefix);
  const rootPreviewHref = buildPreviewRouteBase(context);

  let rewritten = rewritePreviewHtmlBase(html, baseHref)
    .replace(/(["'])\/(_next\/)/g, `$1${rootPreviewHref}$2`)
    .replace(/(["'])\/(@vite\/)/g, `$1${rootPreviewHref}$2`)
    .replace(/(["'])\/(src\/)/g, `$1${rootPreviewHref}$2`)
    .replace(/url\(\s*\/([^)'"]+)/g, `url(${rootPreviewHref}$1`);

  const basePathStr = rootPreviewHref.replace(/\/$/, '');
  if (rewritten.includes('<script id="__NEXT_DATA__"')) {
    if (/"basePath"\s*:\s*""/.test(rewritten)) {
      rewritten = rewritten.replace(/"basePath"\s*:\s*""/g, `"basePath":"${basePathStr}"`);
    } else {
      rewritten = rewritten.replace(/"page"\s*:/, `"basePath":"${basePathStr}","page":`);
    }
  }

  // Also inject a patch script for window.history as a fail-safe
  const routerPatch = `<script>
    if (typeof window !== 'undefined') {
      const originalPush = window.history.pushState;
      const originalReplace = window.history.replaceState;
      window.history.pushState = function(state, title, url) {
        if (url && url.toString().includes('_next/webpack-hmr')) return;
        return originalPush.apply(this, arguments);
      };
      window.history.replaceState = function(state, title, url) {
        if (url && url.toString().includes('_next/webpack-hmr')) return;
        return originalReplace.apply(this, arguments);
      };
    }
  </script>`;
  return rewritten.replace('<head>', '<head>' + routerPatch);
}

async function proxyLivePreviewRequest(
  request: NextRequest,
  relativeFilePath: string,
  context: PreviewContext,
  baseRepoPath: string,
) {
  const encodedAssetPath = relativeFilePath
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const contentSuffix = encodedAssetPath ? `/content/${encodedAssetPath}` : '/content';
  const liveUrl = new URL(`${getBackendBaseUrl()}/api/tenant/preview${contentSuffix}`);
  liveUrl.searchParams.set('tenant_id', context.requestedTenantId);
  liveUrl.searchParams.set('base_repo_path', toCustomizationRepoPath(baseRepoPath));
  request.nextUrl.searchParams.forEach((value, key) => {
    if (!['meta', 'v', 'tenant_id', 'tenantId', 'base_repo_path', 'project_id', 'projectId'].includes(key)) {
      liveUrl.searchParams.append(key, value);
    }
  });

  let upstream: Response;
  try {
    upstream = await fetch(liveUrl, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'manual',
      headers: {
        accept: request.headers.get('accept') || '*/*',
        'user-agent': request.headers.get('user-agent') || 'DeplAI Preview Proxy',
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown proxy error.';
    return NextResponse.json({ error: `Live preview proxy failed: ${detail}` }, { status: 502 });
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get('location');
    if (location) {
      const redirected = new URL(location, 'http://127.0.0.1/');
      const proxiedPath = redirected.pathname.replace(/^\/+/, '');
      return NextResponse.redirect(`${buildPreviewRouteBase(context)}${proxiedPath}${redirected.search}`, upstream.status);
    }
  }

  const responseHeaders = new Headers();
  const upstreamContentType = upstream.headers.get('content-type') || '';
  if (upstreamContentType) responseHeaders.set('content-type', upstreamContentType);
  responseHeaders.set('cache-control', 'no-store, max-age=0');
  setPreviewFrameHeaders(responseHeaders);

  const upstreamBody = await upstream.arrayBuffer();
  if (upstreamContentType.startsWith('text/html')) {
    const html = Buffer.from(upstreamBody).toString('utf-8');
    return new NextResponse(
      Buffer.from(rewriteLivePreviewHtml(html, context, relativeFilePath || 'index.html'), 'utf-8'),
      { status: upstream.status, headers: responseHeaders },
    );
  }

  return new NextResponse(upstreamBody, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

async function getBackendPreviewStatus(tenantId: string, baseRepoPath: string): Promise<BackendPreviewStatus | null> {
  if (!tenantId) return null;
  const params = new URLSearchParams({
    tenant_id: tenantId,
    base_repo_path: toCustomizationRepoPath(baseRepoPath),
  });
  try {
    const response = await fetch(`${getBackendBaseUrl()}/api/tenant/preview/status?${params.toString()}`, {
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload && typeof payload === 'object' ? payload as BackendPreviewStatus : null;
  } catch {
    return null;
  }
}

function normalizeRelativeFilePath(rawPath: string): string {
  return String(rawPath || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

function sanitizeTenantId(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}

async function handlePreviewRequest(request: NextRequest, userId: string, pathSegments: string[]) {
  const metaOnly = ['1', 'true', 'yes'].includes((request.nextUrl.searchParams.get('meta') || '').toLowerCase());
  const projectIdFromPath = pathSegments[1] || '';
  const projectIdFromQuery = request.nextUrl.searchParams.get('project_id') || request.nextUrl.searchParams.get('projectId') || '';
  const normalizedProjectId = String(projectIdFromPath || projectIdFromQuery).trim();
  const tenantIdFromPath = pathSegments[2] === '_tenant' ? pathSegments[3] || '' : '';
  const filePathStartIndex = pathSegments[2] === '_tenant' ? 4 : 2;

  if (!normalizedProjectId) {
    return NextResponse.json({ error: 'project_id is required for preview.' }, { status: 400 });
  }

  let baseRepoPath: string;
  try {
    baseRepoPath = await resolveProjectRepoPath(userId, normalizedProjectId);
  } catch (error) {
    if (error instanceof ProxyResolutionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : 'Failed to resolve project repository path.';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Implement runs against tenant working copy: sibling folder named SubSpace-<tenant_id>.
  // If it exists, preview that copy so the UI reflects applied changes.
  const requestedTenantId = sanitizeTenantId(
    tenantIdFromPath
    || request.nextUrl.searchParams.get('tenant_id')
    || request.nextUrl.searchParams.get('tenantId')
    || '',
  );
  let previewRootPath = baseRepoPath;
  let tenantRepoCandidatePath: string | null = null;
  let tenantRepoExists = false;
  if (requestedTenantId) {
    const tenantRepoCandidate = path.resolve(path.dirname(baseRepoPath), `SubSpace-${requestedTenantId}`);
    tenantRepoCandidatePath = tenantRepoCandidate;
    if (isWithinPath(path.dirname(baseRepoPath), tenantRepoCandidate) && fs.existsSync(tenantRepoCandidate)) {
      const candidateStat = fs.statSync(tenantRepoCandidate);
      if (candidateStat.isDirectory()) {
        tenantRepoExists = true;
        previewRootPath = tenantRepoCandidate;
      }
    }
  }

  const backendPreviewStatus = requestedTenantId
    ? await getBackendPreviewStatus(requestedTenantId, baseRepoPath)
    : null;

  if (metaOnly) {
    const livePreviewKnown = backendPreviewStatus?.kind === 'live_server';
    const liveReady = livePreviewKnown && backendPreviewStatus.status === 'ready';
    // "starting" means the dev server is installing deps / compiling — surface it
    // as progress, not an error, so the UI can poll instead of showing a failure.
    const liveStarting = livePreviewKnown && backendPreviewStatus.status === 'starting';
    const liveStopped = livePreviewKnown && backendPreviewStatus.status === 'stopped';
    const previewEntry = detectPreviewEntry(previewRootPath, baseRepoPath);
    const staticReady = Boolean(previewEntry);
    const previewKind = livePreviewKnown ? 'live_server' : 'static_file';
    const previewStatus = livePreviewKnown
      ? (backendPreviewStatus?.status || 'unavailable')
      : (staticReady ? 'ready' : 'unavailable');
    return NextResponse.json({
      project_id: normalizedProjectId,
      requested_tenant_id: requestedTenantId || null,
      source: previewRootPath === baseRepoPath ? 'base' : 'subspace',
      base_repo_path: baseRepoPath,
      tenant_repo_path: tenantRepoCandidatePath,
      tenant_repo_exists: tenantRepoExists,
      preview_root_path: previewRootPath,
      preview_entry: previewEntry,
      preview_kind: previewKind,
      preview_url: liveReady || staticReady
        ? buildPreviewRouteBase({ normalizedProjectId, requestedTenantId })
        : null,
      preview_status: previewStatus,
      preview_error: (liveReady || liveStarting || liveStopped || staticReady) ? null : (backendPreviewStatus?.detail || null),
      preview_detail: backendPreviewStatus?.detail
        || (staticReady ? 'Static preview served through localhost sandbox proxy.' : null),
    }, { status: 200 });
  }

  let relativeFilePath = normalizeRelativeFilePath(pathSegments.slice(filePathStartIndex).join('/'));
  if (!relativeFilePath) {
    relativeFilePath = normalizeRelativeFilePath(request.nextUrl.searchParams.get('file') || '');
  }
  if (!relativeFilePath) {
    if (
      backendPreviewStatus?.kind === 'live_server'
      && backendPreviewStatus.status === 'ready'
    ) {
      relativeFilePath = '';
    } else {
      const entry = detectPreviewEntry(previewRootPath, baseRepoPath);
      if (!entry) {
        return NextResponse.json({
          error: 'No preview entry file found. Expected index.html (or similar) in the selected repository.',
        }, { status: 404 });
      }
      relativeFilePath = entry;
    }
  }

  if (relativeFilePath.includes('..') || relativeFilePath.includes('\0')) {
    return NextResponse.json({ error: 'Invalid preview file path.' }, { status: 400 });
  }

  if (
    backendPreviewStatus?.kind === 'live_server'
    && backendPreviewStatus.status === 'ready'
  ) {
    return proxyLivePreviewRequest(
      request,
      relativeFilePath,
      { normalizedProjectId, requestedTenantId },
      baseRepoPath,
    );
  }

  if (backendPreviewStatus?.kind === 'live_server' && backendPreviewStatus.status !== 'ready') {
    return NextResponse.json({
      error: 'Live preview is not ready.',
      detail: backendPreviewStatus.detail || 'Preview process is unavailable or failed healthcheck.',
      status: backendPreviewStatus.status || 'unavailable',
    }, { status: 503 });
  }

  let absoluteFilePath = path.resolve(previewRootPath, relativeFilePath);
  
  if (relativeFilePath === 'sandbox-index.html' && !fs.existsSync(absoluteFilePath)) {
    absoluteFilePath = path.resolve(baseRepoPath, relativeFilePath);
  }

  if (!isWithinPath(previewRootPath, absoluteFilePath) && !isWithinPath(baseRepoPath, absoluteFilePath)) {
    return NextResponse.json({ error: 'Preview file path is outside repository root.' }, { status: 400 });
  }

  if (!fs.existsSync(absoluteFilePath)) {
    return NextResponse.json({ error: `Preview file not found: ${relativeFilePath}` }, { status: 404 });
  }

  let resolvedFilePath = absoluteFilePath;
  let servedRelativePath = relativeFilePath;
  if (fs.statSync(resolvedFilePath).isDirectory()) {
    const directoryIndex = path.resolve(resolvedFilePath, 'index.html');
    if (!isWithinPath(previewRootPath, directoryIndex) && !isWithinPath(baseRepoPath, directoryIndex) || !fs.existsSync(directoryIndex)) {
      return NextResponse.json({ error: `Directory preview missing index.html: ${relativeFilePath}` }, { status: 404 });
    }
    resolvedFilePath = directoryIndex;
    servedRelativePath = normalizeRelativeFilePath(path.relative(previewRootPath, directoryIndex));
  }

  const responseHeaders = new Headers({
    'content-type': getContentTypeForFile(resolvedFilePath),
    'cache-control': 'no-store, max-age=0',
  });
  setPreviewFrameHeaders(responseHeaders);

  let responseBody = fs.readFileSync(resolvedFilePath);

  const contentType = responseHeaders.get('content-type') || '';
  if (contentType.startsWith('text/html')) {
    const relativeDirectory = path.posix.dirname(servedRelativePath.replace(/\\/g, '/'));
    const directoryPrefix = relativeDirectory === '.' ? '' : relativeDirectory;
    const baseHref = buildPreviewRouteBase({ normalizedProjectId, requestedTenantId }, directoryPrefix);
    let html = responseBody.toString('utf-8');
    html = rewritePreviewHtmlBase(html, baseHref);

    if (servedRelativePath === 'sandbox-index.html' && requestedTenantId) {
      try {
        const themeCssPath = path.resolve(previewRootPath, 'frontend/styles/tenant-theme.css');
        if (fs.existsSync(themeCssPath)) {
          const themeCss = fs.readFileSync(themeCssPath, 'utf-8');
          html = html.replace('</head>', `<style>\n${themeCss}\n</style></head>`);
        }
      } catch (e) {
        console.error('Failed to inject tenant theme CSS:', e);
      }
    }

    responseBody = Buffer.from(html, 'utf-8');
  }

  return new NextResponse(responseBody, {
    status: 200,
    headers: responseHeaders,
  });
}

async function resolveProjectRepoPath(userId: string, projectId: string): Promise<string> {
  const normalizedProjectId = String(projectId || '').trim();
  if (!normalizedProjectId) {
    throw new ProxyResolutionError(400, 'project_id is required to resolve repository path.');
  }

  const projectRows = await query<ProjectPathRow[]>(
    `SELECT
      p.id,
      p.project_type,
      p.local_path,
      p.user_id,
      gr.full_name AS repo_full_name,
      gi.id AS installation_uuid,
      gi.user_id AS installation_user_id
     FROM projects p
     LEFT JOIN github_repositories gr ON p.repository_id = gr.id
     LEFT JOIN github_installations gi ON gr.installation_id = gi.id
     WHERE p.id = ?`,
    [normalizedProjectId],
  );

  const project = projectRows[0];
  if (project) {
    if (project.user_id !== userId) {
      throw new ProxyResolutionError(403, 'Forbidden: You do not own this project.');
    }

    if (project.project_type === 'local') {
      if (!project.local_path) {
        throw new ProxyResolutionError(400, 'Local project path is missing for this project.');
      }

      const resolvedLocalPath = path.isAbsolute(project.local_path)
        ? path.resolve(project.local_path)
        : path.resolve(LOCAL_PROJECTS_ROOT, project.local_path);

      if (!isWithinPath(LOCAL_PROJECTS_ROOT, resolvedLocalPath)) {
        throw new ProxyResolutionError(400, 'Resolved local project path is outside allowed workspace storage.');
      }

      if (!fs.existsSync(resolvedLocalPath) || !fs.statSync(resolvedLocalPath).isDirectory()) {
        throw new ProxyResolutionError(404, `Local project directory does not exist: ${resolvedLocalPath}`);
      }

      return resolvedLocalPath;
    }

    const resolvedRepo = parseRepoFullName(project.repo_full_name);
    if (!resolvedRepo || !project.installation_uuid) {
      throw new ProxyResolutionError(400, 'GitHub repository metadata is incomplete for this project.');
    }

    if (project.installation_user_id && project.installation_user_id !== userId) {
      throw new ProxyResolutionError(403, 'Forbidden: Installation is not linked to this user.');
    }

    try {
      return await githubService.ensureRepoFresh(project.installation_uuid, resolvedRepo.owner, resolvedRepo.repo);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to clone/sync GitHub repository.';
      throw new ProxyResolutionError(502, message);
    }
  }

  const repoRows = await query<GitHubRepoPathRow[]>(
    `SELECT
      r.id,
      r.full_name,
      gi.id AS installation_uuid,
      gi.user_id AS installation_user_id,
      p.user_id AS linked_user_id
     FROM github_repositories r
     LEFT JOIN github_installations gi ON gi.id = r.installation_id
     LEFT JOIN projects p ON p.repository_id = r.id
     WHERE r.id = ?`,
    [normalizedProjectId],
  );

  const authorizedRepo = repoRows.find(
    (row) => row.installation_user_id === userId || row.linked_user_id === userId,
  );

  if (!authorizedRepo) {
    throw new ProxyResolutionError(403, 'Repository not found or access denied.');
  }

  const resolvedRepo = parseRepoFullName(authorizedRepo.full_name);
  if (!resolvedRepo || !authorizedRepo.installation_uuid) {
    throw new ProxyResolutionError(400, 'GitHub repository metadata is incomplete for this repository.');
  }

  try {
    return await githubService.ensureRepoFresh(
      authorizedRepo.installation_uuid,
      resolvedRepo.owner,
      resolvedRepo.repo,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to clone/sync GitHub repository.';
    throw new ProxyResolutionError(502, message);
  }
}

function getBackendBaseUrl(): string {
  const configured = process.env.CUSTOMIZATION_AGENT_BASE_URL || process.env.CUSTOMIZATION_BACKEND_URL;
  return (configured || DEFAULT_CUSTOMIZATION_BACKEND).replace(/\/+$/, '');
}

function toCustomizationRepoPath(hostPath: string): string {
  return mapConnectorSourceToCustomization(hostPath);
}

function getUiuxAgentBaseUrl(): string {
  return (process.env.UIUX_AGENT_BASE_URL || DEFAULT_UIUX_AGENT_BACKEND).replace(/\/+$/, '');
}

function getUiuxWorkflowId(): string {
  return (process.env.UIUX_AGENT_WORKFLOW_ID || DEFAULT_UIUX_WORKFLOW_ID).trim() || DEFAULT_UIUX_WORKFLOW_ID;
}

async function bindTrustedLlmConfig(
  userId: string,
  body: Record<string, unknown>,
): Promise<NextResponse | null> {
  const incoming = body.llm_config && typeof body.llm_config === 'object' && !Array.isArray(body.llm_config)
    ? { ...(body.llm_config as Record<string, unknown>) }
    : {};
  delete incoming.api_key;
  delete incoming.apiKey;
  const resolved = await resolveWorkflowLlmConfig(userId, incoming);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  body.llm_config = resolved.config;
  return null;
}

function buildTargetUrl(pathSegments: string[] = [], search: string): string {
  const normalizedPath = pathSegments
    .filter((segment) => Boolean(segment))
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  const suffix = normalizedPath ? `/${normalizedPath}` : '';
  return `${getBackendBaseUrl()}${suffix}${search}`;
}

function resolveBackendPath(pathSegments: string[] = []): string[] {
  if (pathSegments.length === 0) return [];

  if (pathSegments[0] === 'implement') {
    return ['api', 'tenant', 'implement'];
  }

  if (pathSegments[0] === 'reset-repo') {
    return ['api', 'admin', 'tenant', 'reset-repo'];
  }

  if (pathSegments[0] === 'assets') {
    if (pathSegments[1] === 'upload') {
      return ['api', 'tenant', 'assets', 'upload'];
    }
    return ['api', 'tenant', 'assets', ...pathSegments.slice(1)];
  }

  if (
    pathSegments[0] === 'preview'
    && ['start', 'restart', 'status', 'stop'].includes(pathSegments[1] || '')
  ) {
    return ['api', 'tenant', 'preview', pathSegments[1]];
  }

  if (pathSegments[0] === 'snapshots') {
    const snapshotSuffix = pathSegments[1] === 'create' ? [] : pathSegments.slice(1);
    return ['api', 'tenant', 'snapshots', ...snapshotSuffix];
  }

  if (pathSegments[0] === 'frontend-customization') {
    return ['api', 'frontend-customization', ...pathSegments.slice(1)];
  }

  return pathSegments;
}

async function handleResolveRepoPathRequest(request: NextRequest, userId: string) {
  const projectId = request.nextUrl.searchParams.get('project_id') || request.nextUrl.searchParams.get('projectId') || '';
  const normalizedProjectId = String(projectId).trim();
  if (!normalizedProjectId) {
    return NextResponse.json({ error: 'project_id is required.' }, { status: 400 });
  }

  try {
    const baseRepoPath = await resolveProjectRepoPath(userId, normalizedProjectId);
    return NextResponse.json({
      project_id: normalizedProjectId,
      base_repo_path: baseRepoPath,
    });
  } catch (error) {
    if (error instanceof ProxyResolutionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : 'Failed to resolve project repository path.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function parseUpstreamJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const payload: unknown = await response.json();
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function bindUiuxWorkspaceSession(options: {
  userId: string;
  projectId: string;
  runId?: string;
  agentSessionId?: string;
  status?: string;
  requiresUserInput?: boolean;
  message?: string;
}): Promise<string | null> {
  try {
    if (!options.projectId && !options.runId) return null;
    const existing = options.runId
      ? await findLatestSession({
          userId: options.userId,
          service: 'uiux_customizer',
          externalId: options.runId,
        })
      : options.projectId
        ? await findLatestSession({
            userId: options.userId,
            projectId: options.projectId,
            service: 'uiux_customizer',
          })
        : null;
    const projectId = options.projectId || existing?.project_id || '';
    if (!projectId) return existing?.id ?? null;
    const owned = await verifyProjectOwnership(options.userId, projectId);
    const repo = 'project' in owned
      ? String(owned.project?.name || owned.project?.full_name || projectId)
      : projectId;
    const status = mapUiuxRunStatus(options.status, options.requiresUserInput);
    const stage = status === 'needs_review'
      ? 'review'
      : status === 'completed'
        ? 'completed'
        : status === 'failed'
          ? 'failed'
          : 'running';
    const reuseId = existing && (options.runId || existing.status === 'running' || existing.status === 'needs_review')
      ? existing.id
      : null;
    const session = await resolveOrCreateSession(reuseId, {
      userId: options.userId,
      projectId,
      service: 'uiux_customizer',
      title: `UI/UX customizer · ${repo}`,
      repo,
      status,
      currentStage: stage,
      triggeredBy: options.userId,
      externalId: options.runId || null,
      metadata: {
        agentos_session_id: options.agentSessionId || null,
        run_id: options.runId || null,
      },
    });
    if (session && options.message) {
      await tryAppendSessionLogs(session.id, [{
        level: status === 'failed' ? 'error' : 'info',
        message: options.message,
        stage,
      }]);
    }
    return session?.id ?? null;
  } catch (error) {
    console.error('[sessions] uiux hook failed', error);
    return null;
  }
}

async function proxyUiuxAgentRequest(request: NextRequest, userId: string, pathSegments: string[]) {
  const action = pathSegments[1] || '';
  const agentBaseUrl = getUiuxAgentBaseUrl();
  const workflowId = encodeURIComponent(getUiuxWorkflowId());

  if (request.method === 'GET' && action === 'health') {
    try {
      const upstream = await fetch(`${agentBaseUrl}/uiux/health`, { cache: 'no-store' });
      const payload = await parseUpstreamJson(upstream);
      const ready = payload?.ready !== false;
      return NextResponse.json({
        available: upstream.ok && ready,
        ready,
        detail: upstream.ok && ready
          ? (typeof payload?.detail === 'string' ? payload.detail : undefined)
          : (typeof payload?.detail === 'string'
            ? payload.detail
            : ready ? `Agent health check returned ${upstream.status}.` : 'The UI/UX workflow has no executable stages.'),
        workflow: getUiuxWorkflowId(),
      }, { status: upstream.ok ? 200 : 503 });
    } catch {
      return NextResponse.json({
        available: false,
        ready: false,
        detail: `UI/UX agent is unreachable at ${agentBaseUrl}. Start AgentOS or set UIUX_AGENT_BASE_URL.`,
        workflow: getUiuxWorkflowId(),
      }, { status: 503 });
    }
  }

  if (request.method === 'GET' && action === 'run') {
    const runId = request.nextUrl.searchParams.get('run_id') || '';
    const sessionId = request.nextUrl.searchParams.get('session_id') || '';
    if (!runId || !sessionId) {
      return NextResponse.json({ error: 'run_id and session_id are required.' }, { status: 400 });
    }
    try {
      const query = new URLSearchParams({ session_id: sessionId });
      const upstream = await fetch(
        `${agentBaseUrl}/workflows/${workflowId}/runs/${encodeURIComponent(runId)}?${query.toString()}`,
        { cache: 'no-store' },
      );
      const payload = await parseUpstreamJson(upstream);
      if (!upstream.ok || !payload) {
        return NextResponse.json({
          error: typeof payload?.detail === 'string' ? payload.detail : `Run status failed with ${upstream.status}.`,
        }, { status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502 });
      }
      const requirements = Array.isArray(payload.step_requirements)
        ? payload.step_requirements as Record<string, unknown>[]
        : [];
      const pending = requirements.find((req) => req.requires_user_input === true);
      const resolvedRunId = typeof payload.run_id === 'string' ? payload.run_id : runId;
      const agentSessionId = typeof payload.session_id === 'string' ? payload.session_id : sessionId;
      const status = typeof payload.status === 'string' ? payload.status : undefined;
      const content = typeof payload.content === 'string' ? payload.content : undefined;
      const workspaceSessionId = await bindUiuxWorkspaceSession({
        userId,
        projectId: request.nextUrl.searchParams.get('project_id') || '',
        runId: resolvedRunId,
        agentSessionId,
        status,
        requiresUserInput: Boolean(pending),
        message: content || (typeof pending?.user_input_message === 'string' ? pending.user_input_message : undefined),
      });
      return NextResponse.json({
        ...payload,
        run_id: resolvedRunId,
        session_id: agentSessionId,
        status,
        content,
        step_requirements: requirements,
        requires_user_input: Boolean(pending),
        user_input_message: typeof pending?.user_input_message === 'string' ? pending.user_input_message : undefined,
        user_input_schema: Array.isArray(pending?.user_input_schema) ? pending.user_input_schema : undefined,
        workspace_session_id: workspaceSessionId,
      });
    } catch {
      return NextResponse.json({
        error: `UI/UX agent is unreachable at ${agentBaseUrl}.`,
      }, { status: 502 });
    }
  }

  if (request.method === 'POST' && action === 'continue') {
    let body: Record<string, unknown>;
    try {
      const payload: unknown = await request.json();
      body = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
    } catch {
      body = {};
    }

    const runId = String(body.run_id ?? '').trim();
    const sessionId = String(body.session_id ?? '').trim();
    const projectId = String(body.project_id ?? body.projectId ?? '').trim();
    if (!runId || !sessionId) {
      return NextResponse.json({ error: 'run_id and session_id are required.' }, { status: 400 });
    }
    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required.' }, { status: 400 });
    }

    const userInput = body.user_input && typeof body.user_input === 'object' && !Array.isArray(body.user_input)
      ? body.user_input as Record<string, unknown>
      : {};
    const confirmed = body.confirmed === true;
    const incomingRequirements = Array.isArray(body.step_requirements)
      ? body.step_requirements as Record<string, unknown>[]
      : [];

    const resolvedRequirements = incomingRequirements.map((req) => {
      const next = { ...req };
      if (next.requires_user_input && Object.keys(userInput).length > 0) {
        next.user_input = userInput;
      }
      if (next.requires_confirmation && confirmed) {
        next.confirmed = true;
      }
      return next;
    });

    const form = new URLSearchParams({
      step_requirements: JSON.stringify(resolvedRequirements),
      session_id: sessionId,
      user_id: userId,
      stream: 'false',
    });

    try {
      const upstream = await fetch(
        `${agentBaseUrl}/workflows/${workflowId}/runs/${encodeURIComponent(runId)}/continue`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: form.toString(),
          cache: 'no-store',
        },
      );
      const payload = await parseUpstreamJson(upstream);
      if (!upstream.ok) {
        return NextResponse.json({
          error: typeof payload?.detail === 'string' ? payload.detail : `Continue failed with status ${upstream.status}.`,
        }, { status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502 });
      }
      const resolvedRunId = typeof payload?.run_id === 'string' ? payload.run_id : runId;
      const agentSessionId = typeof payload?.session_id === 'string' ? payload.session_id : sessionId;
      const status = typeof payload?.status === 'string' ? payload.status : 'continued';
      const workspaceSessionId = await bindUiuxWorkspaceSession({
        userId,
        projectId,
        runId: resolvedRunId,
        agentSessionId,
        status,
        message: typeof payload?.content === 'string' ? payload.content : `UI/UX run ${status}.`,
      });
      return NextResponse.json({
        ...payload,
        run_id: resolvedRunId,
        session_id: agentSessionId,
        status,
        workspace_session_id: workspaceSessionId,
      });
    } catch {
      return NextResponse.json({
        error: `UI/UX agent is unreachable at ${agentBaseUrl}.`,
      }, { status: 502 });
    }
  }

  if (request.method !== 'POST' || action !== 'run') {
    return NextResponse.json({ error: 'Unsupported UI/UX agent action.' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    const payload: unknown = await request.json();
    body = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
  } catch {
    body = {};
  }

  const projectId = String(body.project_id ?? body.projectId ?? '').trim();
  const instruction = String(body.message ?? '').trim();
  if (!projectId) return NextResponse.json({ error: 'project_id is required for a UI/UX refactor run.' }, { status: 400 });
  if (!instruction) return NextResponse.json({ error: 'A UI/UX refactor instruction is required.' }, { status: 400 });

  let repoRoot: string;
  try {
    repoRoot = await resolveProjectRepoPath(userId, projectId);
  } catch (error) {
    if (error instanceof ProxyResolutionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : 'Failed to resolve project repository path.';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // AgentOS run endpoints accept a message plus durable session identifiers.
  // Repo context is attached server-side after authorization, never accepted from the browser.
  const sessionId = `uiux-${projectId}`.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  const agentMessage = [
    instruction,
    '',
    '--- trusted execution context ---',
    `repo_root: ${repoRoot}`,
    `project_id: ${projectId}`,
    'Only inspect or modify presentational frontend files. Require confirmation before applying any patch.',
  ].join('\n');
  const form = new URLSearchParams({
    message: agentMessage,
    user_id: userId,
    session_id: sessionId,
    stream: 'false',
  });

  try {
    const upstream = await fetch(`${agentBaseUrl}/workflows/${workflowId}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      cache: 'no-store',
    });
    const payload = await parseUpstreamJson(upstream);
    if (!upstream.ok) {
      return NextResponse.json({
        error: typeof payload?.detail === 'string' ? payload.detail : `UI/UX agent run failed with status ${upstream.status}.`,
      }, { status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502 });
    }
    const requirements = Array.isArray(payload?.step_requirements)
      ? payload?.step_requirements as Record<string, unknown>[]
      : [];
    const pending = requirements.find((req) => req.requires_user_input === true);
    const status = typeof payload?.status === 'string' ? payload.status : 'started';
    const resolvedRunId = typeof payload?.run_id === 'string' ? payload.run_id : undefined;
    const agentSessionId = typeof payload?.session_id === 'string' ? payload.session_id : sessionId;
    const content = typeof payload?.content === 'string' ? payload.content : undefined;
    const message = typeof payload?.message === 'string' ? payload.message : undefined;
    const workspaceSessionId = await bindUiuxWorkspaceSession({
      userId,
      projectId,
      runId: resolvedRunId,
      agentSessionId,
      status,
      requiresUserInput: Boolean(pending),
      message: content || message || instruction,
    });
    return NextResponse.json({
      ...payload,
      status,
      run_id: resolvedRunId,
      session_id: agentSessionId,
      message,
      content,
      step_requirements: requirements,
      requires_user_input: Boolean(pending),
      user_input_message: typeof pending?.user_input_message === 'string' ? pending.user_input_message : undefined,
      user_input_schema: Array.isArray(pending?.user_input_schema) ? pending.user_input_schema : undefined,
      workspace_session_id: workspaceSessionId,
    });
  } catch {
    return NextResponse.json({
      error: `UI/UX agent is unreachable at ${agentBaseUrl}. Start AgentOS or set UIUX_AGENT_BASE_URL.`,
    }, { status: 502 });
  }
}

async function proxyRequest(request: NextRequest, pathSegments: string[] = []) {
  const { user, error } = await requireAuth();
  if (error) return error;

  if (pathSegments[0] === 'uiux') {
    return proxyUiuxAgentRequest(request, String(user.id), pathSegments);
  }

  let customizationProjectId = '';
  let customizationInstruction = '';

  const previewControlActions = new Set(['start', 'restart', 'status', 'stop']);
  const isPreviewControlRequest =
    pathSegments[0] === 'preview'
    && pathSegments.length === 2
    && previewControlActions.has(pathSegments[1]);
  const isPreviewContentRequest =
    request.method === 'GET'
    && pathSegments.length >= 1
    && pathSegments[0] === 'preview'
    && !isPreviewControlRequest;

  if (isPreviewContentRequest) {
    return handlePreviewRequest(request, String(user.id), pathSegments);
  }

  const isResolveRepoPathRequest =
    request.method === 'GET'
    && pathSegments.length === 1
    && pathSegments[0] === 'resolve-repo-path';

  if (isResolveRepoPathRequest) {
    return handleResolveRepoPathRequest(request, String(user.id));
  }

  const headers = new Headers();

  const acceptHeader = request.headers.get('accept');
  const contentTypeHeader = request.headers.get('content-type');

  if (acceptHeader) headers.set('accept', acceptHeader);
  if (contentTypeHeader) headers.set('content-type', contentTypeHeader);

  const init: RequestInit = {
    method: request.method,
    headers,
    cache: 'no-store',
  };

  let targetSearch = request.nextUrl.search;
  const isSnapshotRequest = pathSegments[0] === 'snapshots';
  const isFrontendCustomizationRequest = pathSegments[0] === 'frontend-customization';
  const isBodyRepoBoundCall =
    request.method === 'POST'
    && (
      pathSegments[0] === 'implement'
      || pathSegments[0] === 'reset-repo'
      || isSnapshotRequest
      || isFrontendCustomizationRequest
      || (
        isPreviewControlRequest
        && ['start', 'restart', 'stop'].includes(pathSegments[1])
      )
    );

  if (isBodyRepoBoundCall) {
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      body = {};
    }

    const projectId = String(body.project_id ?? body.projectId ?? '').trim();
    customizationProjectId = projectId;
    customizationInstruction = String(body.goal ?? body.message ?? '').trim();
    const isFrontendRunCreate =
      isFrontendCustomizationRequest
      && pathSegments[1] === 'runs'
      && pathSegments.length === 2;
    const requiresProjectId = isSnapshotRequest || isPreviewControlRequest || isFrontendRunCreate;
    if (requiresProjectId && !projectId) {
      return NextResponse.json({ error: 'project_id is required.' }, { status: 400 });
    }
    delete body.base_repo_path;
    if (projectId) {
      try {
        body.base_repo_path = toCustomizationRepoPath(await resolveProjectRepoPath(String(user.id), projectId));
      } catch (error) {
        if (error instanceof ProxyResolutionError) {
          return NextResponse.json({ error: error.message }, { status: error.status });
        }
        const message = error instanceof Error ? error.message : 'Failed to resolve project repository path.';
        return NextResponse.json({ error: message }, { status: 500 });
      }
    }

    headers.set('content-type', 'application/json');
  body.user_id = String(user.id);
    const needsLlm =
      pathSegments[0] === 'implement'
      || isFrontendRunCreate;
    if (needsLlm) {
      try {
        const llmError = await bindTrustedLlmConfig(String(user.id), body);
        if (llmError) return llmError;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not resolve model credentials.';
        return NextResponse.json({ error: message }, { status: 502 });
      }
    }
    init.body = JSON.stringify(body);
  } else if (
    request.method === 'GET'
    && (
      isSnapshotRequest
      || (isPreviewControlRequest && pathSegments[1] === 'status')
    )
  ) {
    const projectId = String(
      request.nextUrl.searchParams.get('project_id')
      || request.nextUrl.searchParams.get('projectId')
      || '',
    ).trim();
    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required.' }, { status: 400 });
    }
    let baseRepoPath: string;
    try {
      baseRepoPath = await resolveProjectRepoPath(String(user.id), projectId);
    } catch (resolutionError) {
      if (resolutionError instanceof ProxyResolutionError) {
        return NextResponse.json({ error: resolutionError.message }, { status: resolutionError.status });
      }
      const message = resolutionError instanceof Error
        ? resolutionError.message
        : 'Failed to resolve project repository path.';
      return NextResponse.json({ error: message }, { status: 500 });
    }
    const targetParams = new URLSearchParams(request.nextUrl.searchParams);
    targetParams.delete('project_id');
    targetParams.delete('projectId');
    targetParams.delete('base_repo_path');
    targetParams.set('base_repo_path', toCustomizationRepoPath(baseRepoPath));
    targetSearch = targetParams.size ? `?${targetParams.toString()}` : '';
    } else if (request.method !== 'GET' && request.method !== 'HEAD') {
    const raw = await request.arrayBuffer();
    if ((contentTypeHeader || '').includes('application/json')) {
      try {
        const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          parsed.user_id = String(user.id);
          if (pathSegments[0] === 'chat' || (parsed.llm_config && typeof parsed.llm_config === 'object')) {
            const llmError = await bindTrustedLlmConfig(String(user.id), parsed);
            if (llmError) return llmError;
          }
          headers.set('content-type', 'application/json');
          init.body = JSON.stringify(parsed);
        } else {
          init.body = raw;
        }
      } catch {
        init.body = raw;
      }
    } else {
      init.body = raw;
    }
  }

  const targetUrl = buildTargetUrl(resolveBackendPath(pathSegments), targetSearch);
  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, init);
  } catch {
    const message = `Customization backend is unreachable at ${getBackendBaseUrl()}. Start the tenant builder backend or set CUSTOMIZATION_AGENT_BASE_URL.`;
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const responseHeaders = new Headers();
  const upstreamContentType = upstream.headers.get('content-type');
  if (upstreamContentType) {
    responseHeaders.set('content-type', upstreamContentType);
  }
  const contentDisposition = upstream.headers.get('content-disposition');
  if (contentDisposition) {
    responseHeaders.set('content-disposition', contentDisposition);
  }

  const body = await upstream.arrayBuffer();
  if (
    upstream.ok
    && isFrontendCustomizationRequest
    && pathSegments[1] === 'runs'
  ) {
    try {
      const payload = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
      const runId = String(payload.run_id || pathSegments[2] || '').trim();
      const status = String(payload.status || '');
      const events = Array.isArray(payload.events) ? payload.events as Array<{ summary?: string }> : [];
      const latestSummary = events.length > 0
        ? String(events[events.length - 1]?.summary || '')
        : '';
      const isCreate = request.method === 'POST' && pathSegments.length === 2;
      const isContinue = request.method === 'POST' && pathSegments[3] === 'continue';
      const terminal = status === 'completed' || status === 'failed' || status === 'blocked';
      const workspaceSessionId = await bindUiuxWorkspaceSession({
        userId: String(user.id),
        projectId: customizationProjectId,
        runId,
        status,
        requiresUserInput: status === 'awaiting_review',
        message: (isCreate || isContinue || terminal)
          ? (latestSummary || customizationInstruction || (typeof payload.summary === 'string' ? payload.summary : undefined))
          : undefined,
      });
      return NextResponse.json(
        { ...payload, workspace_session_id: workspaceSessionId },
        { status: upstream.status, headers: responseHeaders },
      );
    } catch (sessionError) {
      console.error('[sessions] frontend customization hook failed', sessionError);
    }
  }
  return new NextResponse(body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
) {
  const resolved = await params;
  return proxyRequest(request, resolved.path || []);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
) {
  const resolved = await params;
  return proxyRequest(request, resolved.path || []);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
) {
  const resolved = await params;
  return proxyRequest(request, resolved.path || []);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
) {
  const resolved = await params;
  return proxyRequest(request, resolved.path || []);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
) {
  const resolved = await params;
  return proxyRequest(request, resolved.path || []);
}
