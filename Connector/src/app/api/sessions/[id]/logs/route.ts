import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import {
  appendSessionLogs,
  getOwnedSession,
  updateSession,
  type SessionLogInput,
} from '@/lib/sessions/store';
import { isSessionLogLevel, isSessionStatus } from '@/lib/sessions/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { id } = await context.params;

  const session = await getOwnedSession(id, auth.user.id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found.' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({})) as {
    lines?: Array<{ level?: string; message?: string; ts?: string; stage?: string | null }>;
    line?: { level?: string; message?: string; ts?: string; stage?: string | null };
    status?: string;
    current_stage?: string | null;
    changed_files_count?: number;
    completed?: boolean;
  };

  const rawLines = [
    ...(Array.isArray(body.lines) ? body.lines : []),
    ...(body.line ? [body.line] : []),
  ].slice(0, 200);

  const lines: SessionLogInput[] = rawLines
    .map((line) => ({
      level: isSessionLogLevel(line.level) ? line.level : 'info',
      message: String(line.message || ''),
      ts: line.ts,
      stage: line.stage ?? null,
    }))
    .filter((line) => line.message.trim().length > 0);

  try {
    const written = lines.length > 0 ? await appendSessionLogs(session.id, lines) : 0;
    const nextStatus = isSessionStatus(body.status)
      ? body.status
      : body.completed
        ? session.status
        : undefined;
    const updated = (nextStatus || body.current_stage !== undefined || body.changed_files_count !== undefined)
      ? await updateSession(session.id, {
          status: nextStatus,
          currentStage: body.current_stage !== undefined ? body.current_stage : undefined,
          changedFilesCount: body.changed_files_count,
          completedAt: nextStatus === 'completed' || nextStatus === 'failed'
            ? new Date()
            : nextStatus
              ? null
              : undefined,
        })
      : session;
    return NextResponse.json({ ok: true, written, session: updated });
  } catch (error) {
    console.error('[sessions] log ingest failed', error);
    return NextResponse.json({ error: 'Could not persist session log.' }, { status: 500 });
  }
}
