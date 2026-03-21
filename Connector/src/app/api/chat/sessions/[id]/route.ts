import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';

const MAX_MESSAGES_PER_SESSION = 200;

interface RouteContext { params: Promise<{ id: string }> }

async function resolveSession(userId: string, sessionId: string) {
  const [session] = await query<{ id: string; user_id: string; title: string; message_count: number }[]>(
    'SELECT id, user_id, title, message_count FROM chat_sessions WHERE id = ?',
    [sessionId],
  );
  if (!session) return null;
  if (session.user_id !== userId) return null; // ownership check
  return session;
}

// GET /api/chat/sessions/[id] — load full message history for a session
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { user, error } = await requireAuth();
  if (error) return error;

  const { id } = await ctx.params;
  const session = await resolveSession(user.id, id);
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const messages = await query<{ id: string; role: string; content: string; metadata: string | null; created_at: string }[]>(
    `SELECT id, role, content, metadata, created_at
     FROM chat_messages
     WHERE session_id = ?
     ORDER BY created_at ASC
     LIMIT ${MAX_MESSAGES_PER_SESSION}`,
    [id],
  );

  // Parse metadata JSON stored as string — guard against malformed data
  const parsed = messages.map(m => {
    let metadata: object | null = null;
    if (m.metadata) {
      try { metadata = JSON.parse(m.metadata as string); } catch { /* ignore malformed metadata */ }
    }
    return { ...m, metadata };
  });

  return NextResponse.json({ session, messages: parsed });
}

// PATCH /api/chat/sessions/[id] — append messages + update title/message_count
// Body: { messages: [{role, content, metadata?}][], title?: string }
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const { user, error } = await requireAuth();
  if (error) return error;

  const { id } = await ctx.params;
  const session = await resolveSession(user.id, id);
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const incoming: { role: string; content: string; metadata?: object }[] = Array.isArray(body.messages) ? body.messages : [];
  const newTitle: string | undefined = typeof body.title === 'string' ? body.title.slice(0, 255) : undefined;

  // Enforce per-session message cap
  const remaining = MAX_MESSAGES_PER_SESSION - session.message_count;
  const toInsert = incoming.slice(0, Math.max(0, remaining));

  for (const msg of toInsert) {
    if (!['user', 'assistant'].includes(msg.role)) continue;
    await query(
      'INSERT INTO chat_messages (id, session_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)',
      [
        randomUUID(),
        id,
        msg.role,
        msg.content,
        msg.metadata ? JSON.stringify(msg.metadata) : null,
      ],
    );
  }

  const newCount = session.message_count + toInsert.length;
  await query(
    `UPDATE chat_sessions SET message_count = ?, title = COALESCE(?, title), updated_at = NOW() WHERE id = ?`,
    [newCount, newTitle ?? null, id],
  );

  return NextResponse.json({ appended: toInsert.length, message_count: newCount });
}

// DELETE /api/chat/sessions/[id]
export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  const { user, error } = await requireAuth();
  if (error) return error;

  const { id } = await ctx.params;
  const session = await resolveSession(user.id, id);
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // CASCADE deletes chat_messages automatically
  await query('DELETE FROM chat_sessions WHERE id = ?', [id]);
  return NextResponse.json({ deleted: true });
}
