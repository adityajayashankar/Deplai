import { NextResponse } from 'next/server';
import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
import { sessionOptions } from '@/lib/session';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

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

  return NextResponse.json({ success: true });
}
