// Next.js does not natively support WebSocket upgrades in Route Handlers.
// Use a custom server (server.ts / server.js) with the `ws` package to proxy
// browser connections to the Agentic Layer websocket when real-time streaming
// is required. Otherwise, rely on polling via /api/pipeline/iac-status.
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ runId: string }> }) {
  const { error, user } = await requireAuth();
  if (error) return error;

  const projectId = String(request.nextUrl.searchParams.get('project_id') || '').trim();
  if (!projectId) {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
  }

  const owned = await verifyProjectOwnership(user.id, projectId);
  if ('error' in owned) return owned.error;

  const { runId } = await context.params;
  return NextResponse.json(
    {
      error: 'WebSocket upgrades are not handled by this Next.js route runtime.',
      run_id: runId,
      hint: 'Use /api/pipeline/ws-config plus /api/scan/ws-token to connect to the Agentic Layer websocket directly.',
    },
    { status: 426 },
  );
}
