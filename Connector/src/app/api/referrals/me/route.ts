import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { buildReferralShareMessage } from '@/lib/referrals/logic';
import { getReferralProgramConfig } from '@/lib/referrals/config';
import { getProfileBundle } from '@/lib/profile/store';
import { getReferrerDashboard, getRefereeClaimState } from '@/lib/referrals/store';
import { buildReferralSignupUrl } from '@/lib/public-app-url';

export const runtime = 'nodejs';

export async function GET() {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const config = getReferralProgramConfig();
  await getProfileBundle(auth.user);
  const [dashboard, claim] = await Promise.all([
    getReferrerDashboard(auth.user.id),
    getRefereeClaimState(auth.user.id),
  ]);
  const referralUrl = buildReferralSignupUrl(dashboard.referralCode);
  const shareMessage = buildReferralShareMessage({
    referralCode: dashboard.referralCode,
    referralUrl,
    discountPercent: config.refereeDiscountPercent,
  });
  return NextResponse.json({
    referralCode: dashboard.referralCode,
    referralUrl,
    shareMessage,
    stats: dashboard.stats,
    slots: dashboard.slots,
    referrals: dashboard.referrals,
    claim: {
      hasClaimed: claim.hasClaimed,
      canClaimMore: claim.canClaimMore,
      status: claim.status,
      message: claim.message,
    },
    program: {
      maxReferralsPerReferrer: config.maxReferralsPerReferrer,
      refereeDiscountPercent: config.refereeDiscountPercent,
      referrerRewardPercent: config.referrerRewardPercent,
    },
  });
}
