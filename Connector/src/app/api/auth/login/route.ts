import { randomBytes } from 'crypto';
import { NextResponse } from 'next/server';
import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
import { requireEnv } from '@/lib/env';
import { sessionOptions, type SessionData } from '@/lib/session';

const LOGOUT_GUARD_COOKIE = 'deplai_recent_logout';

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions);
  const { searchParams } = new URL(request.url);
  const logoutGuardCookie = cookieStore.get(LOGOUT_GUARD_COOKIE)?.value;
  const isForcedLogin = searchParams.get('force') === '1';

  if (logoutGuardCookie && !isForcedLogin) {
    return NextResponse.redirect(`${requireEnv('NEXT_PUBLIC_APP_URL')}/?logged_out=1`, 302);
  }

  if (logoutGuardCookie && isForcedLogin) {
    cookieStore.delete(LOGOUT_GUARD_COOKIE);
  }

  const state = randomBytes(32).toString('hex');
  session.oauthState = state;
  session.oauthStateExpiresAt = Date.now() + (10 * 60 * 1000);
  await session.save();

  const params = new URLSearchParams({
    client_id: requireEnv('GITHUB_CLIENT_ID'),
    redirect_uri: `${requireEnv('NEXT_PUBLIC_APP_URL')}/api/auth/callback`,
    scope: 'user:email read:user read:org',
    state,
  });

  return NextResponse.redirect(`https://github.com/login/oauth/authorize?${params}`, 302);
}
