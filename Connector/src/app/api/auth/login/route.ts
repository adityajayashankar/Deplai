import { NextResponse } from 'next/server';
import { requireEnv } from '@/lib/env';

export async function GET() {
  const params = new URLSearchParams({
    client_id: requireEnv('GITHUB_CLIENT_ID'),
    redirect_uri: `${requireEnv('NEXT_PUBLIC_APP_URL')}/api/auth/callback`,
    scope: 'user:email read:user read:org',
  });

  return NextResponse.redirect(`https://github.com/login/oauth/authorize?${params}`);
}
