import { NextRequest, NextResponse } from 'next/server';

import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { resolveProjectMeta } from '@/lib/project-meta';
import {
  buildDeploymentWorkspace,
  validateRepositoryContextJson,
} from '@/lib/deployment-planning-contract';

interface RepositoryAnalysisBody {
  project_id: string;
  workspace?: string;
}

async function assertAgenticHealthy(action: string): Promise<void> {
  const healthRes = await fetch(`${AGENTIC_URL}/health`, {
    method: 'GET',
    headers: agenticHeaders(),
    signal: AbortSignal.timeout(3_000),
    cache: 'no-store',
  });
  if (!healthRes.ok) {
    throw new Error(`Agentic Layer health check returned ${healthRes.status} while trying to ${action}.`);
  }
}

function classifyAgenticRouteError(err: unknown, action: string): { message: string; status: number } {
  const raw = err instanceof Error ? err.message : String(err || 'unknown upstream error');
  const lowered = raw.toLowerCase();
  if (err instanceof Error && err.name === 'TimeoutError' || lowered.includes('aborted due to timeout') || lowered.includes('timed out')) {
    return {
      message: `Agentic Layer timed out while trying to ${action}. If you recently changed backend planning code, restart or unpause the Agentic Layer service and retry.`,
      status: 504,
    };
  }
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

export async function POST(req: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await req.json() as RepositoryAnalysisBody;
    const projectId = String(body.project_id || '').trim();
    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    const owned = await verifyProjectOwnership(user.id, projectId);
    if ('error' in owned) return owned.error;

    const meta = await resolveProjectMeta(String(user.id), projectId);
    if (!meta) {
      return NextResponse.json({ error: 'Project metadata could not be resolved.' }, { status: 404 });
    }

    const projectName = String(owned.project?.name || owned.project?.full_name || projectId).split('/').pop() || projectId;
    const workspace = buildDeploymentWorkspace(projectId, body.workspace || projectName);
    await assertAgenticHealthy('run repository analysis');

    const agenticRes = await fetch(`${AGENTIC_URL}/api/repository-analysis/run`, {
      method: 'POST',
      headers: {
        ...agenticHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        project_id: projectId,
        project_name: projectName,
        project_type: meta.project_type,
        user_id: String(user.id),
        repo_full_name: meta.repo_full_name,
        workspace,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    const data = await agenticRes.json().catch(() => ({})) as {
      success?: boolean;
      context_json?: unknown;
      context_md?: string;
      runtime_paths?: Record<string, string>;
      error?: string;
      workspace?: string;
    };

    if (!agenticRes.ok || data.success !== true) {
      return NextResponse.json(
        { error: String(data.error || 'Repository analysis failed.') },
        { status: agenticRes.ok ? 500 : agenticRes.status },
      );
    }

    const validation = validateRepositoryContextJson(data.context_json);
    if (!validation.valid || !validation.normalized) {
      return NextResponse.json(
        { error: `context_json validation failed: ${validation.errors.join('; ')}` },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      workspace: data.workspace || workspace,
      context_json: validation.normalized,
      context_md: String(data.context_md || ''),
      runtime_paths: data.runtime_paths || null,
    });
  } catch (err) {
    const classified = classifyAgenticRouteError(err, 'run repository analysis');
    return NextResponse.json({ error: classified.message }, { status: classified.status });
  }
}
