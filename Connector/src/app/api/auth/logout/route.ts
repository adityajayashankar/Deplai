import { NextResponse } from 'next/server';
import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
import { sessionOptions } from '@/lib/session';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

const LOGOUT_GUARD_COOKIE = 'deplai_recent_logout';

export async function POST() {
  const cookieStore = await cookies();
  const session = await getIronSession(cookieStore, sessionOptions);
  const cleanupOnLogout = (process.env.CLEANUP_SCAN_VOLUMES_ON_LOGOUT || '').toLowerCase() === 'true';

  if (cleanupOnLogout) {
    try {
      const cleanupRes = await fetch(`${AGENTIC_URL}/api/cleanup`, {
        method: 'POST',
        headers: agenticHeaders(),
      });
      if (!cleanupRes.ok) {
        const detail = await cleanupRes.json().catch(() => ({}));
        console.error('Backend cleanup failed:', cleanupRes.status, detail);
      }
    } catch (err) {
      console.error('Backend cleanup unreachable:', err);
    }
  }

  session.destroy();
  const response = NextResponse.json({ success: true });
  response.cookies.set(LOGOUT_GUARD_COOKIE, '1', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60,
  });

  return response;
}
