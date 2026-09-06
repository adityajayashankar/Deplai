import { NextResponse, type NextRequest } from 'next/server';
import { isBillingEnforced } from '@/lib/ai-platform/subscription-access';
import { getOrganizationSubscription } from '@/lib/billing/credits';
import { resolveBillingOrganization } from '@/lib/billing/organization-context';
import type { SessionUser } from '@/lib/profile/store';
import {
  minimumPlanLabelForFeature,
  minimumTierForFeature,
  planAccessDeniedResponse,
  planIncludesFeature,
  type PlanFeature,
} from './plan-features';

export async function resolveOrganizationPlanId(
  request: NextRequest,
  user: SessionUser,
): Promise<{ organizationId: string; planId: string }> {
  const organization = await resolveBillingOrganization({
    request,
    user,
    permission: 'billing.read',
  });
  const subscription = await getOrganizationSubscription(organization.id).catch(() => null);
  return {
    organizationId: organization.id,
    planId: subscription?.planId || 'free',
  };
}

export async function denyUnlessPlanFeature(
  request: NextRequest,
  user: SessionUser,
  feature: PlanFeature,
): Promise<NextResponse | null> {
  if (!isBillingEnforced()) return null;
  const { planId } = await resolveOrganizationPlanId(request, user);
  if (!planIncludesFeature(planId, feature)) {
    return planAccessDeniedResponse(feature);
  }
  return null;
}

export { planAccessDeniedResponse, minimumPlanLabelForFeature, minimumTierForFeature };
