import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

interface Stage7Body {
  project_id?: string;
  infra_plan: Record<string, unknown>;
  budget_cap_usd?: number;
  pipeline_run_id?: string;
  environment?: string;
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

export async function POST(req: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await req.json() as Stage7Body;
    const projectId = String(body.project_id || '').trim();
    if (projectId) {
      const owned = await verifyProjectOwnership(user.id, projectId);
      if ('error' in owned) return owned.error;
    }

    if (!body.infra_plan || typeof body.infra_plan !== 'object') {
      return NextResponse.json({ error: 'infra_plan is required' }, { status: 400 });
    }

    const agenticRes = await fetch(`${AGENTIC_URL}/api/stage7/approval`, {
      method: 'POST',
      headers: {
        ...agenticHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        infra_plan: body.infra_plan,
        budget_cap_usd: Number(body.budget_cap_usd || 100),
        pipeline_run_id: String(body.pipeline_run_id || ''),
        environment: String(body.environment || 'dev'),
      }),
      signal: AbortSignal.timeout(90_000),
    });

    const data = await agenticRes.json().catch(() => ({}));
    if (!agenticRes.ok || data.success !== true) {
      return NextResponse.json(
        { error: String(data.error || 'Stage 7 approval generation failed.') },
        { status: agenticRes.ok ? 500 : agenticRes.status },
      );
    }

    return NextResponse.json({
      success: true,
      approval_payload: data.approval_payload || null,
    });
  } catch (err) {
    const classified = classifyAgenticRouteError(err, 'generate the Stage 7 approval payload');
    return NextResponse.json({ error: classified.message }, { status: classified.status });
  }
}

