import { NextResponse } from 'next/server';
import { getReferralProgramConfig } from '@/lib/referrals/config';

export const runtime = 'nodejs';

export async function GET() {
  const config = getReferralProgramConfig();
  return NextResponse.json({
    enabled: config.enabled,
    refereeDiscountPercent: config.refereeDiscountPercent,
    referrerRewardPercent: config.referrerRewardPercent,
    attributionWindowDays: config.attributionWindowDays,
    maxReferralsPerReferrer: config.maxReferralsPerReferrer,
    headline: config.headline,
    refereeBenefit: config.refereeBenefit,
    referrerBenefit: config.referrerBenefit,
    sharePath: '/auth/signup?ref=',
  });
}
