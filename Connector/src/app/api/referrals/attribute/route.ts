import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { clearReferralCookie } from '@/lib/referrals/cookie';
import { clientRateLimitKey, takeReferralRateLimit } from '@/lib/referrals/rate-limit';
import { applyReferralCodeForUser } from '@/lib/referrals/store';

export const runtime = 'nodejs';

function statusForCode(code: string): number {
  if (code === 'self_referral' || code === 'already_claimed' || code === 'referrer_full' || code === 'apply_failed') {
    return 409;
  }
  if (code === 'disabled') return 503;
  if (code === 'not_eligible') return 403;
  return 400;
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const rate = takeReferralRateLimit({
    key: clientRateLimitKey(request, auth.user.id),
    action: 'attribute',
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many apply attempts. Try again shortly.', code: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }
  const body = await request.json().catch(() => ({})) as { code?: string };
  const code = String(body.code || '').trim();
  const result = await applyReferralCodeForUser(auth.user.id, code);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, code: result.code },
      { status: statusForCode(result.code) },
    );
  }
  await clearReferralCookie();
  return NextResponse.json({
    ok: true,
    attributionId: result.attribution.id,
    status: result.attribution.status,
    discountPercent: result.attribution.refereeDiscountPercent,
  });
}
