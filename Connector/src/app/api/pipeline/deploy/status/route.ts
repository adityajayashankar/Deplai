import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

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
      return NextResponse.json(
        { error: data.error || 'Failed to fetch deployment status.' },
        { status: res.ok ? 500 : res.status },
      );
    }

    return NextResponse.json({
      success: true,
      status: String(data.status || 'idle'),
      result: (data.result ?? null),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch deployment status';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
