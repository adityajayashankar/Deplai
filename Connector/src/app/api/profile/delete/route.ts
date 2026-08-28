import { NextRequest, NextResponse } from 'next/server';
import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
import { requireAuth } from '@/lib/auth';
import { getSessionOptions, type SessionData } from '@/lib/session';
import { deleteAccount } from '@/lib/profile/store';
import { LOGIN_HREF } from '@/lib/auth-providers';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => ({})) as { confirmation?: string };
  try {
    const result = await deleteAccount(auth.user, String(body.confirmation || ''));
    const cookieStore = await cookies();
    const session = await getIronSession<SessionData>(cookieStore, getSessionOptions());
    session.destroy();
    const response = NextResponse.json({ ok: true, redirectTo: result.redirectTo || LOGIN_HREF });
    response.cookies.set('deplai_recent_logout', '1', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60,
    });
    return response;
  } catch (error) {
    const err = error as Error & { status?: number; code?: string };
    return NextResponse.json(
      { error: err.message || 'Unable to delete account', code: err.code },
      { status: err.status || 500 },
    );
  }
}
