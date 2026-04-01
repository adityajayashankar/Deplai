import { NextRequest, NextResponse } from 'next/server';

import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { resolveProjectMeta } from '@/lib/project-meta';
import {
  buildDeploymentWorkspace,
  validateDeploymentProfileJson,
  validateDerivedArchitectureView,
} from '@/lib/deployment-planning-contract';

interface ArchitectureReviewCompleteBody {
  project_id: string;
  workspace: string;
  answers: Record<string, string>;
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

    const body = await req.json() as ArchitectureReviewCompleteBody;
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
    await assertAgenticHealthy('complete the architecture review');
    const agenticRes = await fetch(`${AGENTIC_URL}/api/architecture/review/complete`, {
      method: 'POST',
      headers: {
        ...agenticHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        project_id: projectId,
        project_name: projectName,
        project_type: meta.project_type,
        workspace,
        user_id: String(user.id),
        repo_full_name: meta.repo_full_name,
        answers: body.answers || {},
      }),
      signal: AbortSignal.timeout(120_000),
    });

    const data = await agenticRes.json().catch(() => ({})) as {
      success?: boolean;
      deployment_profile?: unknown;
      architecture_view?: unknown;
      approval_payload?: Record<string, unknown>;
      answers_json?: Record<string, unknown>;
      runtime_paths?: Record<string, string>;
      error?: string;
    };
    if (!agenticRes.ok || data.success !== true) {
      return NextResponse.json(
        { error: String(data.error || 'Architecture review completion failed.') },
        { status: agenticRes.ok ? 500 : agenticRes.status },
      );
    }

    const profileValidation = validateDeploymentProfileJson(data.deployment_profile);
    if (!profileValidation.valid || !profileValidation.normalized) {
      return NextResponse.json(
        { error: `deployment_profile validation failed: ${profileValidation.errors.join('; ')}` },
        { status: 500 },
      );
    }

    const viewValidation = validateDerivedArchitectureView(data.architecture_view);
    if (!viewValidation.valid || !viewValidation.normalized) {
      return NextResponse.json(
        { error: `architecture_view validation failed: ${viewValidation.errors.join('; ')}` },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      answers_json: data.answers_json || null,
      deployment_profile: profileValidation.normalized,
      architecture_view: viewValidation.normalized,
      approval_payload: data.approval_payload || null,
      runtime_paths: data.runtime_paths || null,
    });
  } catch (err) {
    const classified = classifyAgenticRouteError(err, 'complete the architecture review');
    return NextResponse.json({ error: classified.message }, { status: classified.status });
  }
}
