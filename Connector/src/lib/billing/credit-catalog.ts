// v4 prices keep the current customer-facing INR catalog aligned across
// checkout, plan cards, and credit packs. Keep the per-credit
// provider value stable so existing, never-expiring credits retain their
// promised purchasing power; new grants are reduced proportionally instead.
export const CREDIT_CATALOG_VERSION = 'v4-inr-499-999-399-2026-09';
export const CREDIT_UNITS_PER_CREDIT = 1_000_000;
export const CREDIT_VALUE_PAISE = 1_300;
export const DEFAULT_METERING_FX_INR_PER_USD = 95;
export const GST_PERCENT = 18;
export const PROCESSOR_FEE_BPS = 215;

export type CreditReleaseSchedule = {
  creditsPerRelease: number;
  interval: 'monthly';
  releases: number;
};

export type CreditCatalogPlan = {
  id: 'free' | 'starter_20' | 'pro_50';
  name: string;
  displayName: string;
  description: string;
  monthlyPricePaise: number;
  annualPricePaise: number;
  monthlyCredits: number;
  annualCredits: number;
  providerBudgetPaiseMonthly: number;
  providerBudgetPaiseAnnual: number;
  annualReleaseSchedule: CreditReleaseSchedule | null;
  features: string[];
  recommended: boolean;
};

export type CreditCatalogPack = {
  id: 'topup_100_v2';
  name: string;
  pricePaise: number;
  credits: number;
  providerBudgetPaise: number;
  paidTiersOnly: true;
};

export const CREDIT_PLANS: readonly CreditCatalogPlan[] = [
  {
    id: 'free',
    name: 'free',
    displayName: 'Free',
    description: 'Bring your own LLM key and explore DeplAI',
    monthlyPricePaise: 0,
    annualPricePaise: 0,
    monthlyCredits: 0,
    annualCredits: 0,
    providerBudgetPaiseMonthly: 0,
    providerBudgetPaiseAnnual: 0,
    annualReleaseSchedule: null,
    features: ['1 project', 'BYOK model access', 'Basic security scan', 'Community support'],
    recommended: false,
  },
  {
    id: 'starter_20',
    name: 'starter_20',
    displayName: 'Starter',
    description: 'Go from repo connect to approved AWS deploy without stitching scanners, agents, and Terraform yourself',
    monthlyPricePaise: 49_900,
    annualPricePaise: 539_900,
    monthlyCredits: 25,
    annualCredits: 300,
    providerBudgetPaiseMonthly: 32_500,
    providerBudgetPaiseAnnual: 390_000,
    annualReleaseSchedule: { creditsPerRelease: 25, interval: 'monthly', releases: 12 },
    features: [
      'Security Agent: SAST, dependency scans, and AI remediation',
      'Terraform generation with plan review before every apply',
      'DeplAI-managed LLMs — no vendor API keys required',
      'Unlimited projects and deployment pipelines',
      'Organization workspace to share with collaborators',
      'Email support when something blocks your release',
    ],
    recommended: false,
  },
  {
    id: 'pro_50',
    name: 'pro_50',
    displayName: 'Pro',
    description: 'For teams that need design iteration, fix velocity, and deploy confidence in one place',
    monthlyPricePaise: 99_900,
    annualPricePaise: 1_079_900,
    monthlyCredits: 62.5,
    annualCredits: 750,
    providerBudgetPaiseMonthly: 81_250,
    providerBudgetPaiseAnnual: 975_000,
    annualReleaseSchedule: { creditsPerRelease: 62.5, interval: 'monthly', releases: 12 },
    features: [
      'Everything in Starter',
      'UI/UX customizer for safe, frontend-only design changes',
      'Guided vulnerability fixes with human review gates',
      'Traffic-aware AWS cost estimates before infrastructure applies',
      'Priority support for production incidents',
      'Organization roles, teams, and shared billing context',
    ],
    recommended: true,
  },
] as const;

export const CREDIT_PACKS: readonly CreditCatalogPack[] = [
  {
    id: 'topup_100_v2',
    name: '25 credit top-up',
    pricePaise: 39_900,
    credits: 25,
    providerBudgetPaise: 32_500,
    paidTiersOnly: true,
  },
] as const;

export function catalogPlan(planId: string): CreditCatalogPlan | null {
  return CREDIT_PLANS.find((plan) => plan.id === planId) || null;
}

export function catalogPack(packId: string): CreditCatalogPack | null {
  return CREDIT_PACKS.find((pack) => pack.id === packId) || null;
}

export function planDisplayName(planId: string): string {
  const plan = catalogPlan(planId);
  if (plan) return plan.displayName;
  if (planId === 'enterprise') return 'Enterprise';
  if (planId === 'free') return 'Free';
  return planId;
}

export function creditsToUnits(credits: number): bigint {
  if (!Number.isFinite(credits) || credits < 0) throw new Error('Credits must be a non-negative number');
  return BigInt(Math.round(credits * CREDIT_UNITS_PER_CREDIT));
}

export function unitsToCredits(units: bigint | number | string): number {
  return Number(units) / CREDIT_UNITS_PER_CREDIT;
}

export function providerCostUsdToUnits(
  providerCostUsd: number,
  fxInrPerUsd = DEFAULT_METERING_FX_INR_PER_USD,
): bigint {
  if (!Number.isFinite(providerCostUsd) || providerCostUsd < 0) throw new Error('Invalid provider cost');
  if (!Number.isFinite(fxInrPerUsd) || fxInrPerUsd <= 0) throw new Error('Invalid metering FX rate');
  return BigInt(Math.ceil((providerCostUsd * fxInrPerUsd / (CREDIT_VALUE_PAISE / 100)) * CREDIT_UNITS_PER_CREDIT));
}

export function splitGstInclusive(totalPaise: number, gstPercent = GST_PERCENT) {
  if (!Number.isInteger(totalPaise) || totalPaise < 0) throw new Error('Total must be integer paise');
  const taxablePaise = Math.round(totalPaise / (1 + gstPercent / 100));
  return { taxablePaise, gstPaise: totalPaise - taxablePaise, totalPaise };
}

export function catalogEconomics(totalPaise: number, credits: number) {
  const tax = splitGstInclusive(totalPaise);
  const processorFeePaise = Math.round(totalPaise * PROCESSOR_FEE_BPS / 10_000);
  const providerBudgetPaise = credits * CREDIT_VALUE_PAISE;
  return {
    ...tax,
    processorFeePaise,
    providerBudgetPaise,
    contributionPaise: tax.taxablePaise - processorFeePaise - providerBudgetPaise,
  };
}

export function assertStarterContributionSafe(env: Record<string, string | undefined> = process.env): void {
  const gstPercent = Number(env.BILLING_GST_RATE || GST_PERCENT);
  const feeBps = Number(env.BILLING_PROCESSOR_FEE_BPS || PROCESSOR_FEE_BPS);
  const starter = CREDIT_PLANS.find((plan) => plan.id === 'starter_20');
  if (!starter || !Number.isFinite(gstPercent) || !Number.isFinite(feeBps)) {
    throw new Error('Credit catalog safety inputs are invalid');
  }
  const taxablePaise = Math.round(starter.monthlyPricePaise / (1 + gstPercent / 100));
  const processorFeePaise = Math.round(starter.monthlyPricePaise * feeBps / 10_000);
  const contributionPerHundredPaise = Math.round(
    (taxablePaise - processorFeePaise - starter.providerBudgetPaiseMonthly)
      * (100 / starter.monthlyCredits),
  );
  if (contributionPerHundredPaise < 30_000) {
    throw Object.assign(new Error('New credit purchases are temporarily paused by pricing safety controls'), {
      statusCode: 503,
      safeToExpose: true,
      code: 'credit_pricing_safety_pause',
    });
  }
}
