import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { redeemPromoCode } from '@/lib/profile/store';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => ({})) as { code?: string };
  try {
    const result = await redeemPromoCode(auth.user.id, String(body.code || ''));
    return NextResponse.json(result);
  } catch (error) {
    const err = error as Error & { status?: number; code?: string };
    return NextResponse.json(
      { error: err.message || 'Unable to redeem promotional code', code: err.code || 'invalid' },
      { status: err.status || 400 },
    );
  }
}
