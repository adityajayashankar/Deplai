import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { getAuthCookieNames } from '@/lib/auth/cookies';

export const runtime = 'nodejs';

export async function GET() {
  const cookieStore = await cookies();
  const pending = Boolean(cookieStore.get(getAuthCookieNames().pending)?.value);
  return NextResponse.json({ pending });
}
