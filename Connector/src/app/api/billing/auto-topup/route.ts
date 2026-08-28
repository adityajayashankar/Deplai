import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getProfileBundle, saveAutoTopup } from '@/lib/profile/store';

export const runtime = 'nodejs';

export async function GET() {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const bundle = await getProfileBundle(auth.user);
    return NextResponse.json({ autoTopup: bundle.autoTopup });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load automatic top-up';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const body = await request.json().catch(() => ({})) as {
      enabled?: boolean;
      thresholdUsd?: number;
      addUsd?: number;
    };
    const autoTopup = await saveAutoTopup(auth.user, body);
    return NextResponse.json({ autoTopup });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to save automatic top-up';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
