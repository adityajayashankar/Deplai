import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';

const MAX_SESSIONS_PER_USER = 50;

export interface ChatSession {
  id: string;
  title: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

function isConnectivityError(error: unknown): boolean {
  const err = error as { code?: string };
  return (
    err?.code === 'ECONNREFUSED' ||
    err?.code === 'ENOTFOUND' ||
    err?.code === 'ETIMEDOUT' ||
    err?.code === 'EHOSTUNREACH' ||
    err?.code === 'PROTOCOL_CONNECTION_LOST'
  );
}

// GET /api/chat/sessions - list all sessions for the current user (newest first)
export async function GET() {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const sessions = await query<ChatSession[]>(
      `SELECT id, title, message_count, created_at, updated_at
       FROM chat_sessions
       WHERE user_id = ?
       ORDER BY updated_at DESC
       LIMIT ${MAX_SESSIONS_PER_USER}`,
      [user.id],
    );

    return NextResponse.json({ sessions });
  } catch (error: unknown) {
    console.error('List chat sessions error:', error);
    if (isConnectivityError(error)) {
      return NextResponse.json(
        { error: 'Database unavailable. Verify DB_HOST/DB_PORT and that MySQL is running.' },
        { status: 503 }
      );
    }
    const err = error as { message?: string };
    return NextResponse.json({ error: err.message || 'Failed to fetch sessions' }, { status: 500 });
  }
}

// POST /api/chat/sessions - create a new session
// Body: { title?: string }
export async function POST(req: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    // Enforce per-user session limit: evict the oldest if at cap
    const [{ count }] = await query<{ count: number }[]>(
      'SELECT COUNT(*) AS count FROM chat_sessions WHERE user_id = ?',
      [user.id],
    );

    if (Number(count) >= MAX_SESSIONS_PER_USER) {
      // Delete the oldest session (cascade deletes its messages)
      await query(
        `DELETE FROM chat_sessions
         WHERE user_id = ?
         ORDER BY updated_at ASC
         LIMIT 1`,
        [user.id],
      );
    }

    const body = await req.json().catch(() => ({}));
    const title: string = (body.title as string)?.slice(0, 255) || 'New chat';
    const id = randomUUID();

    await query(
      'INSERT INTO chat_sessions (id, user_id, title) VALUES (?, ?, ?)',
      [id, user.id, title],
    );

    return NextResponse.json({ id, title, message_count: 0 }, { status: 201 });
  } catch (error: unknown) {
    console.error('Create chat session error:', error);
    if (isConnectivityError(error)) {
      return NextResponse.json(
        { error: 'Database unavailable. Verify DB_HOST/DB_PORT and that MySQL is running.' },
        { status: 503 }
      );
    }
    const err = error as { message?: string };
    return NextResponse.json({ error: err.message || 'Failed to create session' }, { status: 500 });
  }
}
