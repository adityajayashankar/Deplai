import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getOwnedSession, listSessionLogs } from '@/lib/sessions/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { id } = await context.params;
  try {
    const session = await getOwnedSession(id, auth.user.id);
    if (!session) {
      return NextResponse.json({ error: 'Session not found.' }, { status: 404 });
    }
    const logs = await listSessionLogs(session.id);
    const stageHistory = Array.from(
      new Map(
        logs
          .filter((line) => line.stage)
          .map((line) => [line.stage as string, { stage: line.stage, ts: line.ts }]),
      ).values(),
    );
    return NextResponse.json({
      session,
      logs,
      stage_history: stageHistory,
      changed_files_count: session.changed_files_count,
    });
  } catch (error) {
    console.error('[sessions] detail failed', error);
    return NextResponse.json({ error: 'Could not load session.' }, { status: 500 });
  }
}
