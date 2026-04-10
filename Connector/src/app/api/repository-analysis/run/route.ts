import { NextRequest, NextResponse } from 'next/server';

import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { resolveProjectMeta, resolveProjectSourceRoot } from '@/lib/project-meta';
import {
  buildDeploymentWorkspace,
  validateRepositoryContextJson,
} from '@/lib/deployment-planning-contract';

interface RepositoryAnalysisBody {
  project_id: string;
  workspace?: string;
}

const AGENTIC_ANALYSIS_TIMEOUT_MS = 600_000;
const AGENTIC_ANALYSIS_RETRIES = 1;

function isTimeoutLikeError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err || '');
  const lowered = raw.toLowerCase();
  return (
    (err instanceof Error && err.name === 'TimeoutError')
    || lowered.includes('aborted due to timeout')
    || lowered.includes('timed out')
  );
}

async function postRepositoryAnalysis(payload: Record<string, unknown>): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= AGENTIC_ANALYSIS_RETRIES; attempt += 1) {
    try {
      const response = await fetch(`${AGENTIC_URL}/api/repository-analysis/run`, {
        method: 'POST',
        headers: {
          ...agenticHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(AGENTIC_ANALYSIS_TIMEOUT_MS),
      });

      if (response.status >= 500 && attempt < AGENTIC_ANALYSIS_RETRIES) {
        continue;
      }

      return response;
    } catch (err) {
      lastError = err;
      if (!isTimeoutLikeError(err) || attempt >= AGENTIC_ANALYSIS_RETRIES) {
        throw err;
      }
    }
  }
  throw lastError || new Error('Repository analysis failed after retry.');
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

    const preparedSourceRoot = await resolveProjectSourceRoot(String(user.id), projectId);
    if (!preparedSourceRoot) {
      return NextResponse.json(
        { error: 'Repository source could not be prepared locally. Refresh the GitHub repository connection and retry.' },
        { status: 502 },
      );
    }

    const projectName = String(owned.project?.name || owned.project?.full_name || projectId).split('/').pop() || projectId;
    const workspace = buildDeploymentWorkspace(projectId, body.workspace || projectName);
    const agenticRes = await postRepositoryAnalysis({
      project_id: projectId,
      project_name: projectName,
      project_type: meta.project_type,
      user_id: String(user.id),
      repo_full_name: meta.repo_full_name,
      workspace,
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
