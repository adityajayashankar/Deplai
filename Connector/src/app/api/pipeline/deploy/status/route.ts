import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

function classifyStatusError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || 'Failed to fetch deployment status.');
  const lowered = raw.toLowerCase();
  if (
    lowered.includes('fetch failed')
    || lowered.includes('econnrefused')
    || lowered.includes('enotfound')
    || lowered.includes('network')
  ) {
    return `Agentic Layer is unavailable at ${AGENTIC_URL}.`;
  }
  if (
    (err instanceof Error && err.name === 'TimeoutError')
    || lowered.includes('aborted due to timeout')
    || lowered.includes('timed out')
  ) {
    return 'Agentic Layer timed out while checking deployment status.';
  }
  return raw || 'Failed to fetch deployment status.';
}

export async function POST(req: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await req.json().catch(() => ({})) as { project_id?: string; project_name?: string };
    const projectId = String(body.project_id || '').trim();
    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    const owned = await verifyProjectOwnership(user.id, projectId);
    if ('error' in owned) return owned.error;

    const projectName = String(body.project_name || owned.project?.name || projectId).trim();

    const res = await fetch(`${AGENTIC_URL}/api/terraform/apply/status`, {
      method: 'POST',
      headers: { ...agenticHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId,
        project_name: projectName,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const data = await res.json().catch(() => ({})) as { success?: boolean; status?: string; result?: unknown; error?: string };
    if (!res.ok || data.success !== true) {
      const message = String(data.error || 'Failed to fetch deployment status.');
      const lowered = message.toLowerCase();
      const isNoActiveState =
        lowered.includes('no active deployment process')
        || lowered.includes('project_id or project_name is required');
      if (res.ok && isNoActiveState) {
        return NextResponse.json({
          success: true,
          status: 'idle',
          result: null,
          warning: message,
        });
      }
      return NextResponse.json(
        {
          success: false,
          status: 'idle',
          result: null,
          error: message,
        },
        { status: res.ok ? 500 : res.status },
      );
    }

    return NextResponse.json({
      success: true,
      status: String(data.status || 'idle'),
      result: (data.result ?? null),
    });
  } catch (err) {
    const msg = classifyStatusError(err);
    return NextResponse.json({
      success: true,
      status: 'idle',
      result: null,
      warning: msg,
    });
  }
}
