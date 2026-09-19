import { createHash, randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireServiceKey, verifyProjectOwnership } from '@/lib/auth';
import { OrganizationError, requireOrganizationPermission } from '@/lib/organizations/store';
import { denyUnlessPlanFeature } from '@/lib/billing/plan-access-guard';
import { getOrganizationPolicy } from '@/lib/ai-platform/policies';
import { GET as listProjects } from '@/app/api/projects/route';
import { editorPath, loadSnapshotFile, readState, saveState, snapshotRepository, UiuxError, type Snapshot } from '@/lib/uiux/snapshots';
import { proposalPatch, verifyProposal } from '@/lib/uiux/proposals';
import { applyUiuxChanges, createUiuxPullRequest, UiuxPullRequestError } from '@/lib/uiux/pull-request';
import { settleProductUsage } from '@/lib/billing/product-usage';
import { isAllowedBrowserOrigin } from '@/lib/agentic-websocket';
import type { UiuxRun } from '@/features/customization/uiux-workspace-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
type SavedRun = { snapshot: Snapshot; prompt: string; scope: string[]; pr_url?: string; applied_commit?: string };

async function worker<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
  const key = process.env.DEPLAI_SERVICE_KEY?.trim();
  if (!key) throw new UiuxError('UI/UX service authentication is not configured.', 503);
  const base = (process.env.UIUX_AGENT_BASE_URL || 'http://127.0.0.1:7777').replace(/\/$/, '');
  let response: Response;
  try { response = await fetch(`${base}/uiux/${endpoint}`, { method, headers: { 'X-API-Key': key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: AbortSignal.timeout(25000) }); }
  catch { throw new UiuxError('UI/UX worker is unavailable. Start the uiux-agent service and retry.', 503); }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 403) throw new UiuxError('The UI/UX worker service key does not match Connector. Restart the local worker with Connector’s environment configuration.', 503);
  if (!response.ok) throw new UiuxError(typeof data.detail === 'string' ? data.detail : 'UI/UX worker rejected the request.', response.status);
  return data as T;
}

const baselineKey = (runId: string, name: string) => `${runId}-${createHash('sha256').update(name).digest('hex').slice(0, 40)}`;

async function handleSource(request: NextRequest) {
  const denied = requireServiceKey(request);
  if (denied) return denied;
  const body = await request.json();
  const { run_id: runId, user_id: userId, project_id: projectId, operation } = body;
  if (typeof runId !== 'string' || !/^[a-f0-9]{32}$/.test(runId) || typeof userId !== 'string' || typeof projectId !== 'string') throw new UiuxError('Invalid source request.');
  const access = await verifyProjectOwnership(userId, projectId, 'ui_customization.run');
  if (access.error) return access.error;
  if (access.project?.organization_id) await requireOrganizationPermission({ userId, organizationId: access.project.organization_id, action: 'ui_customization.run', resource: { scopeType: 'PROJECT', scopeId: access.project.id, projectId: access.project.id } });
  const saved = await readState<SavedRun>(userId, projectId, runId);
  const editable = (name: string) => editorPath(name) && (!saved.scope.length || saved.scope.includes(name));
  if (operation === 'list') {
    const query = typeof body.query === 'string' ? body.query.toLowerCase().slice(0, 500) : '';
    const offset = Number.isSafeInteger(body.offset) && body.offset >= 0 ? body.offset : 0;
    const files = saved.snapshot.files.filter(file => file.path.toLowerCase().includes(query));
    return NextResponse.json({ files: files.slice(offset, offset + 100).map(file => ({ path: file.path, size: file.size ?? Buffer.byteLength(file.content), editable: editable(file.path) })), next_offset: offset + 100 < files.length ? offset + 100 : null });
  }
  if (operation === 'read' && typeof body.path === 'string') {
    const file = await loadSnapshotFile(saved.snapshot, body.path);
    await saveState(userId, projectId, baselineKey(runId, file.path), file);
    return NextResponse.json({ ...file, editable: editable(file.path) });
  }
  throw new UiuxError('Invalid source operation.');
}

async function handle(request: NextRequest, context: Context) {
  const { path: segments } = await context.params;
  if (segments.join('/') === 'source' && request.method === 'POST') {
    try { return await handleSource(request); }
    catch (error) { return NextResponse.json({ error: error instanceof UiuxError || error instanceof OrganizationError ? error.message : 'Source retrieval failed.' }, { status: error instanceof UiuxError || error instanceof OrganizationError ? error.status : 502 }); }
  }
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const route = segments.join('/');
    if (request.method !== 'GET') {
      const origin = request.headers.get('origin');
      if (origin && !isAllowedBrowserOrigin(origin, {
        requestOrigin: request.nextUrl.origin,
        forwardedHost: request.headers.get('x-forwarded-host'),
        forwardedProto: request.headers.get('x-forwarded-proto'),
        hostHeader: request.headers.get('host'),
        publicAppUrl: process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL,
        corsOrigins: process.env.CORS_ORIGINS,
      })) {
        throw new UiuxError('Cross-origin requests are not allowed.', 403);
      }
    }
    if (route === 'projects' && request.method === 'GET') return listProjects(request);
    if (route === 'health' && request.method === 'GET') {
      try {
        const health = await worker<{ configured: boolean }>('health');
        return NextResponse.json({ user_id: String(auth.user.id), available: health.configured, detail: health.configured ? 'Platform GLM 5.3 Flash worker is configured.' : 'The platform OpenRouter key is missing.' });
      } catch (error) { return NextResponse.json({ user_id: String(auth.user.id), available: false, detail: error instanceof UiuxError ? error.message : 'UI/UX worker unavailable.' }); }
    }
    let body: Record<string, unknown> = {};
    if (request.method === 'POST') {
      const text = await request.text();
      if (text.length > 20000) throw new UiuxError('Request is too large.', 413);
      try { body = JSON.parse(text); } catch { throw new UiuxError('Invalid JSON request.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UiuxError('Invalid request.');
      const allowed = route === 'runs' ? ['project_id', 'prompt', 'scope'] : ['project_id'];
      if (Object.keys(body).some(key => !allowed.includes(key))) throw new UiuxError('Unsupported request fields. Provider keys and repository paths cannot be supplied.');
    }
    const projectId = String(body.project_id || request.nextUrl.searchParams.get('project_id') || '');
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(projectId)) throw new UiuxError('Select a repository first.');
    const userId = String(auth.user.id);
    const action = request.method === 'GET' ? 'ui_customization.read' : request.method === 'DELETE' ? 'agent.cancel' : ['pr', 'apply'].includes(String(segments[2] || '')) ? 'project.update' : 'ui_customization.run';
    const access = await verifyProjectOwnership(userId, projectId, action);
    if (access.error) return access.error;
    if (!access.project) throw new UiuxError('Project not found.', 404);
    if (access.project.organization_id) await requireOrganizationPermission({ userId, organizationId: access.project.organization_id, action, resource: { scopeType: 'PROJECT', scopeId: access.project.id, projectId: access.project.id } });
    if (request.method === 'POST') {
      const denied = await denyUnlessPlanFeature(request, auth.user, 'customization');
      if (denied) return denied;
    }
    if (route === 'repository' && request.method === 'GET') {
      const snapshot = await snapshotRepository(userId, projectId, access.project.user_id);
      await saveState(userId, projectId, 'repository', snapshot);
      return NextResponse.json({ project: snapshot.project, source_sha: snapshot.source_sha, files: snapshot.files.map(file => ({ path: file.path, size: file.size ?? Buffer.byteLength(file.content), editable: editorPath(file.path) })), warnings: snapshot.warnings });
    }
    if (route === 'file' && request.method === 'GET') {
      const snapshot = await readState<Snapshot>(userId, projectId, 'repository');
      const file = await loadSnapshotFile(snapshot, request.nextUrl.searchParams.get('path') || '');
      return NextResponse.json({ ...file, editable: editorPath(file.path) });
    }
    if (route === 'runs' && request.method === 'POST') {
      if (typeof body.prompt !== 'string' || body.prompt.trim().length < 3 || body.prompt.length > 12000) throw new UiuxError('Describe your UI change in 3–12,000 characters.');
      if (body.scope !== undefined && (!Array.isArray(body.scope) || body.scope.some(value => typeof value !== 'string'))) throw new UiuxError('Invalid file scope.');
      const policy = await getOrganizationPolicy(userId);
      if (policy.byokRequired || !policy.platformCredentialsAllowed || !policy.allowedCredentialModes.some(mode => mode === 'platform' || mode === 'auto') || (policy.allowedProviders && !policy.allowedProviders.includes('openrouter'))) throw new UiuxError('Your AI policy does not allow platform OpenRouter access.', 403);
      if (policy.allowedModels?.length && !policy.allowedModels.some(model => ['z-ai/glm-5.3-flash', 'openrouter:z-ai/glm-5.3-flash'].includes(model))) throw new UiuxError('Your AI policy must allow GLM 5.3 Flash for UI/UX editing.', 403);
      const snapshot = await readState<Snapshot>(userId, projectId, 'repository');
      const scope = (body.scope || []) as string[];
      if (scope.some(value => !editorPath(value) || !snapshot.files.some(file => file.path === value))) throw new UiuxError('The scope contains an unsupported or missing file.');
      const keywords = body.prompt.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2);
      const score = (name: string) => keywords.reduce((value, word) => value + Number(name.toLowerCase().includes(word)), 0);
      const candidates = snapshot.files.filter(file => editorPath(file.path) && (!scope.length || scope.includes(file.path)) && (file.size || 0) <= 128 * 1024).sort((a, b) => score(b.path) - score(a.path));
      if (!candidates.length) throw new UiuxError('No supported React or CSS files fit the per-file editing window.');
      // Seed a small context; the worker discovers and reads the rest on demand.
      const files: { path: string; content: string }[] = [];
      let bytes = 0;
      for (const candidate of candidates.slice(0, 12)) {
        try {
          const file = await loadSnapshotFile(snapshot, candidate.path);
          if (bytes + Buffer.byteLength(file.content) > 200_000) continue;
          files.push(file); bytes += Buffer.byteLength(file.content);
        } catch (error) { if (!(error instanceof UiuxError && [403, 413].includes(error.status))) throw error; }
      }
      const runId = randomUUID().replace(/-/g, '');
      await saveState(userId, projectId, runId, { snapshot, prompt: body.prompt, scope });
      for (const file of files) await saveState(userId, projectId, baselineKey(runId, file.path), file);
      const run = await worker<UiuxRun>('runs', 'POST', { request_id: runId, repository_access: true, project_id: projectId, user_id: userId, organization_id: access.project.organization_id, source_sha: snapshot.source_sha, prompt: body.prompt, files, scope });
      return NextResponse.json(run, { status: 202 });
    }
    if (segments[0] === 'runs' && /^[a-f0-9]{32}$/.test(segments[1] || '')) {
      const runId = segments[1];
      const saved = await readState<SavedRun>(userId, projectId, runId);
      const query = new URLSearchParams({ user_id: userId, project_id: projectId });
      if (request.method === 'DELETE' && segments.length === 2) return NextResponse.json(await worker(`runs/${runId}?${query}`, 'DELETE'));
      const result = await worker<UiuxRun>(`runs/${runId}?${query}`);
      const verifiedFiles: Snapshot['files'] = [];
      for (const change of result.status === 'completed' ? result.changes || [] : []) {
        if (!change || typeof change.path !== 'string' || !saved.snapshot.files.some(file => file.path === change.path) || (saved.scope.length && !saved.scope.includes(change.path))) throw new UiuxError('Proposed change is outside the authorized repository scope.', 409);
        const original = await readState<{ path: string; content: string }>(userId, projectId, baselineKey(runId, change.path)).catch(error => {
          const legacy = saved.snapshot.files.find(file => file.path === change.path && file.loaded !== false);
          if (error instanceof UiuxError && error.status === 404 && legacy) return legacy;
          throw error;
        });
        verifiedFiles.push(original);
      }
      const verifiedSnapshot = { ...saved.snapshot, files: verifiedFiles };
      const run = verifyProposal(verifiedSnapshot, result);
      run.prompt = saved.prompt;
      run.pr_url = saved.pr_url;
      run.applied_commit = saved.applied_commit;
      if (request.method === 'GET' && segments.length === 2) {
        let usageCharge: Record<string, unknown> | null = null;
        if (run.status === 'completed' && access.project.organization_id) {
          try {
            const settlement = await settleProductUsage({
              kind: 'uiux',
              outcome: 'succeeded',
              organizationId: access.project.organization_id,
              userId,
              projectId,
              runId,
              usage: result.usage || null,
            });
            usageCharge = {
              status: 'settled',
              credits: settlement.credits,
              debited: settlement.debited,
              duplicate: settlement.duplicate,
            };
          } catch (billingError) {
            console.error('[uiux] usage settlement failed', billingError instanceof Error ? billingError.name : 'UnknownError');
            usageCharge = { status: 'pending', error: 'Verified changes are available; credit settlement is pending.' };
          }
        }
        return NextResponse.json({ ...run, usage_charge: usageCharge });
      }
      if (run.status !== 'completed') throw new UiuxError('Only verified completed changes can be exported or published.', 409);
      if (segments[2] === 'patch' && segments.length === 3 && request.method === 'GET') return new Response(proposalPatch(run), { headers: { 'Content-Type': 'text/x-diff; charset=utf-8', 'Content-Disposition': `attachment; filename="uiux-${runId}.patch"` } });
      if (segments[2] === 'pr' && segments.length === 3 && request.method === 'POST') {
        const result = await createUiuxPullRequest(verifiedSnapshot, run);
        await saveState(userId, projectId, runId, { ...saved, pr_url: result.url });
        return NextResponse.json(result);
      }
      if (segments[2] === 'apply' && segments.length === 3 && request.method === 'POST') {
        if (saved.applied_commit) return NextResponse.json({ branch: verifiedSnapshot.project.branch, commit: saved.applied_commit, existing: true });
        const result = await applyUiuxChanges(verifiedSnapshot, run);
        await saveState(userId, projectId, runId, { ...saved, applied_commit: result.commit });
        return NextResponse.json(result);
      }
    }
    throw new UiuxError('UI/UX endpoint not found.', 404);
  } catch (error) {
    if (error instanceof UiuxError || error instanceof UiuxPullRequestError || error instanceof OrganizationError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[uiux] Request failed', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'Unable to complete this UI/UX request. Check the connected repository and service configuration.' }, { status: 502 });
  }
}
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
