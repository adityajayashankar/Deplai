export const CREDIT_CATALOG_VERSION = 'v3-inr-rounded-2026-09';
export const CREDIT_UNITS_PER_CREDIT = 1_000_000;
export const CREDIT_VALUE_PAISE = 1_300;

export function creditsToUnits(credits: number): bigint {
  if (!Number.isFinite(credits) || credits < 0) throw new Error('Credits must be a non-negative number');
  return BigInt(Math.round(credits * CREDIT_UNITS_PER_CREDIT));
}

export function unitsToCredits(units: bigint | number | string): number {
  return Number(units) / CREDIT_UNITS_PER_CREDIT;
}

export const BILLING_PLANS = [
  { id: 'free', displayName: 'Free' },
  { id: 'starter_20', displayName: 'Starter' },
  { id: 'pro_50', displayName: 'Pro' },
] as const;
