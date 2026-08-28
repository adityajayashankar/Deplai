import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { integrationStatus } from '@/lib/profile/store';

export const runtime = 'nodejs';

export async function GET() {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    return NextResponse.json(await integrationStatus(auth.user.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load integrations';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
