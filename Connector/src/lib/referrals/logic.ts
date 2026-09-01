import { catalogPlan } from '@/lib/billing/credit-catalog';
import { isRecognizedReferralCode } from './codes';

const REFERRAL_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;
export type ReferralAttributionStatus = 'pending' | 'converted' | 'expired' | 'ineligible';

export function normalizeReferralCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  if (!code || !REFERRAL_CODE_RE.test(code) || !isRecognizedReferralCode(code)) return null;
  return code;
}

export function validateReferralCodeFormat(code: string): boolean {
  return REFERRAL_CODE_RE.test(code) && isRecognizedReferralCode(code);
}
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.indexOf('@');
  if (at <= 1) return '••••@••••';
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const maskedLocal = `${local[0]}${'•'.repeat(Math.max(1, local.length - 2))}${local.slice(-1)}`;
  const domainParts = domain.split('.');
  const maskedDomain = domainParts.length > 1
    ? `${domainParts[0][0]}•••.${domainParts.slice(1).join('.')}`
    : `${domain[0]}•••`;
  return `${maskedLocal}@${maskedDomain}`;
}

export function computeReferralDiscountPaise(totalPaise: number, discountPercent: number): number {
  if (!Number.isFinite(totalPaise) || totalPaise <= 0 || discountPercent <= 0) return 0;
  return Math.floor(totalPaise * discountPercent / 100);
}

export function computeReferrerRewardCredits(input: {
  planId: string;
  cadence: 'monthly' | 'yearly' | null;
  rewardPercent: number;
}): number {
  const plan = catalogPlan(input.planId);
  if (!plan || plan.id === 'free') return 0;
  const baseCredits = input.cadence === 'yearly'
    ? (plan.annualReleaseSchedule?.creditsPerRelease ?? plan.monthlyCredits)
    : plan.monthlyCredits;
  if (!baseCredits || input.rewardPercent <= 0) return 0;
  return Math.max(1, Math.floor(baseCredits * input.rewardPercent / 100));
}

export function isAttributionActive(status: ReferralAttributionStatus, expiresAt: Date): boolean {
  if (status !== 'pending') return false;
  return expiresAt.getTime() > Date.now();
}

export function referrerSlotsRemaining(used: number, max: number): number {
  return Math.max(0, max - used);
}

export function referrerCanAcceptMore(used: number, max: number): boolean {
  return used < max;
}

export function buildReferralShareMessage(input: {
  referralCode: string;
  referralUrl: string;
  discountPercent: number;
}): string {
  return [
    `Join me on DeplAI and get ${input.discountPercent}% off your first paid plan.`,
    `Use referral code: ${input.referralCode}`,
    `Sign up: ${input.referralUrl}`,
  ].join('\n');
}
