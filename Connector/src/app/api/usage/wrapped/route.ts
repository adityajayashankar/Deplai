import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { loadUsageDashboard } from '@/lib/usage/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const payload = await loadUsageDashboard(auth.user);
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load usage';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
