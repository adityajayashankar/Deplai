import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { clientRateLimitKey, takeReferralRateLimit } from '@/lib/referrals/rate-limit';
import { getRefereeClaimState, validateReferralCodeForUser } from '@/lib/referrals/store';

export const runtime = 'nodejs';

function statusForCode(code: string): number {
  if (code === 'referrer_full' || code === 'already_claimed' || code === 'self_referral') return 409;
  if (code === 'disabled') return 503;
  if (code === 'not_eligible') return 403;
  return 400;
}

export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser();
  const rate = takeReferralRateLimit({
    key: clientRateLimitKey(request, user?.id),
    action: 'validate',
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { valid: false, error: 'Too many validation attempts. Try again shortly.', code: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }
  const code = request.nextUrl.searchParams.get('code') || '';
  const result = await validateReferralCodeForUser(code, user?.id);
  if (!result.ok) {
    return NextResponse.json(
      { valid: false, error: result.error, code: result.code },
      { status: statusForCode(result.code) },
    );
  }
  const claim = user ? await getRefereeClaimState(user.id) : null;
  return NextResponse.json({
    valid: true,
    referralCode: result.referralCode,
    referrerName: result.referrerName,
    discountPercent: result.discountPercent,
    referrerSlotsRemaining: result.referrerSlotsRemaining,
    claim: claim ? {
      hasClaimed: claim.hasClaimed,
      canClaimMore: claim.canClaimMore,
      message: claim.message,
    } : null,
  });
}
