export const REFERRAL_COOKIE_NAME = 'deplai_referral_code';
export const REFERRAL_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type ReferralProgramConfig = {
  enabled: boolean;
  refereeDiscountPercent: number;
  referrerRewardPercent: number;
  attributionWindowDays: number;
  maxReferralsPerReferrer: number;
  codePrefix: string;
  headline: string;
  refereeBenefit: string;
  referrerBenefit: string;
};

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

export function getReferralProgramConfig(): ReferralProgramConfig {
  const refereeDiscountPercent = envNumber('REFERRAL_REFEREE_DISCOUNT_PERCENT', 10);
  const referrerRewardPercent = envNumber('REFERRAL_REFERRER_REWARD_PERCENT', 20);
  const attributionWindowDays = envNumber('REFERRAL_ATTRIBUTION_WINDOW_DAYS', 30);
  const maxReferralsPerReferrer = envNumber('REFERRAL_MAX_REFERRALS_PER_USER', 3);
  return {
    enabled: envBoolean('REFERRAL_ENABLED', true),
    refereeDiscountPercent,
    referrerRewardPercent,
    attributionWindowDays,
    maxReferralsPerReferrer: Math.max(1, maxReferralsPerReferrer),
    codePrefix: 'DPL',
    headline: 'Refer friends, earn credits',
    refereeBenefit: `${refereeDiscountPercent}% off their first paid plan`,
    referrerBenefit: `${referrerRewardPercent}% of their plan credits when they subscribe`,
  };
}
