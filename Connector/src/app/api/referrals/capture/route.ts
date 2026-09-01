import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { referralCookieOptions } from '@/lib/referrals/cookie';
import { clientRateLimitKey, takeReferralRateLimit } from '@/lib/referrals/rate-limit';
import { validateReferralCodeForUser } from '@/lib/referrals/store';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const rate = takeReferralRateLimit({
    key: clientRateLimitKey(request),
    action: 'capture',
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Try again shortly.', code: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }
  const body = await request.json().catch(() => ({})) as { code?: string };
  const code = String(body.code || '').trim();
  const validation = await validateReferralCodeForUser(code);
  if (!validation.ok) {
    return NextResponse.json(
      { error: validation.error, code: validation.code },
      { status: validation.code === 'referrer_full' ? 409 : 400 },
    );
  }
  const options = referralCookieOptions(validation.referralCode);
  if (!options) {
    return NextResponse.json({ error: 'Invalid referral code.' }, { status: 400 });
  }
  const cookieStore = await cookies();
  cookieStore.set(options);
  return NextResponse.json({
    ok: true,
    referralCode: validation.referralCode,
    referrerName: validation.referrerName,
    discountPercent: validation.discountPercent,
  });
}
