import { NextRequest, NextResponse } from 'next/server';

import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders, formatAgenticFetchError } from '@/lib/agentic';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { projectId } = await context.params;
  const owned = await verifyProjectOwnership(auth.user.id, projectId);
  if (owned.error) return owned.error;

  try {
    const upstream = await fetch(
      `${AGENTIC_URL}/api/remediate/runs/${encodeURIComponent(projectId)}`,
      {
        headers: agenticHeaders(),
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return NextResponse.json(
        { error: body?.detail || body?.error || 'Remediation status is unavailable.' },
        { status: upstream.status },
      );
    }
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: formatAgenticFetchError(error) }, { status: 502 });
  }
}
