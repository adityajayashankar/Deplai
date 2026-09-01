import { NextResponse } from 'next/server';
import { isBillingEnforced } from '@/lib/ai-platform/subscription-access';
import { planDisplayName } from '@/lib/billing/credit-catalog';

export type PlanTier = 'free' | 'starter' | 'pro' | 'enterprise';

export type PlanFeature =
  | 'managed_llm'
  | 'deploy'
  | 'dast'
  | 'cloud'
  | 'instances'
  | 'customization'
  | 'multi_project';

const TIER_RANK: Record<PlanTier, number> = {
  free: 0,
  starter: 1,
  pro: 2,
  enterprise: 3,
};

const FEATURE_MIN_TIER: Record<PlanFeature, PlanTier> = {
  managed_llm: 'starter',
  deploy: 'starter',
  dast: 'starter',
  cloud: 'starter',
  instances: 'starter',
  customization: 'pro',
  multi_project: 'starter',
};

const NAV_FEATURE_BY_ID: Partial<Record<string, PlanFeature>> = {
  customization: 'customization',
  dast: 'dast',
  cloud: 'cloud',
  deployment: 'deploy',
  instances: 'instances',
};

export function planTierFromId(planId: string | null | undefined): PlanTier {
  const id = String(planId || 'free').trim().toLowerCase();
  if (!id || id === 'free') return 'free';
  if (id === 'enterprise' || id.startsWith('enterprise')) return 'enterprise';
  if (id.startsWith('pro')) return 'pro';
  if (id.startsWith('starter')) return 'starter';
  return 'free';
}

export function minimumTierForFeature(feature: PlanFeature): PlanTier {
  return FEATURE_MIN_TIER[feature];
}

export function minimumPlanLabelForFeature(feature: PlanFeature): string {
  return planDisplayName(minimumTierForFeature(feature) === 'pro' ? 'pro_50' : 'starter_20');
}

export function planIncludesFeature(
  planId: string | null | undefined,
  feature: PlanFeature,
  billingEnforced: boolean = isBillingEnforced(),
): boolean {
  if (!billingEnforced) return true;
  const required = FEATURE_MIN_TIER[feature];
  return TIER_RANK[planTierFromId(planId)] >= TIER_RANK[required];
}

export function buildPlanFeatureMap(
  planId: string | null | undefined,
  billingEnforced: boolean = isBillingEnforced(),
): Record<PlanFeature, boolean> {
  return {
    managed_llm: planIncludesFeature(planId, 'managed_llm', billingEnforced),
    deploy: planIncludesFeature(planId, 'deploy', billingEnforced),
    dast: planIncludesFeature(planId, 'dast', billingEnforced),
    cloud: planIncludesFeature(planId, 'cloud', billingEnforced),
    instances: planIncludesFeature(planId, 'instances', billingEnforced),
    customization: planIncludesFeature(planId, 'customization', billingEnforced),
    multi_project: planIncludesFeature(planId, 'multi_project', billingEnforced),
  };
}

export function navFeatureForItem(navId: string): PlanFeature | null {
  return NAV_FEATURE_BY_ID[navId] || null;
}

export function planAccessDeniedResponse(feature: PlanFeature) {
  const required = minimumTierForFeature(feature);
  return NextResponse.json(
    {
      error: `${minimumPlanLabelForFeature(feature)} plan required for this feature.`,
      code: 'plan_upgrade_required',
      feature,
      required_plan: required,
      required_plan_name: minimumPlanLabelForFeature(feature),
      upgrade_path: '/dashboard/billing',
    },
    { status: 403 },
  );
}
