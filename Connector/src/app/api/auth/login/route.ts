import { randomBytes } from 'crypto';
import { NextResponse } from 'next/server';
import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
import { requireEnv } from '@/lib/env';
import { sessionOptions, type SessionData } from '@/lib/session';

export async function GET() {
  const cookieStore = await cookies();
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions);
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
