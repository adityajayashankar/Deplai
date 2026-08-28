import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getMaskedApiToken, revealApiToken, rotateApiToken } from '@/lib/profile/store';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const reveal = request.nextUrl.searchParams.get('reveal') === '1';
  try {
    if (!reveal) {
      return NextResponse.json(await getMaskedApiToken(auth.user.id));
    }
    const revealed = await revealApiToken(auth.user.id);
    if (!revealed) {
      return NextResponse.json({ error: 'No API token has been issued yet.' }, { status: 404 });
    }
    return NextResponse.json({ configured: true, masked: revealed.masked, token: revealed.token });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load API token';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST() {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const rotated = await rotateApiToken(auth.user.id);
    return NextResponse.json(rotated);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to reset API token';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
