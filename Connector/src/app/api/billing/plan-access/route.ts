import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getOrganizationSubscription } from '@/lib/billing/credits';
import { planDisplayName, unitsToCredits } from '@/lib/billing/credit-catalog';
import {
  getOrganizationCreditBalance,
  reconcileOrganizationSubscriptionCredits,
} from '@/lib/billing/organization-credits';
import { buildPlanFeatureMap } from '@/lib/billing/plan-features';
import { resolveBillingOrganization } from '@/lib/billing/organization-context';
import { isBillingEnforced } from '@/lib/ai-platform/subscription-access';
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  try {
    const organization = await resolveBillingOrganization({
      request,
      user: auth.user,
      permission: 'billing.read',
    });
    await reconcileOrganizationSubscriptionCredits(organization.id).catch(() => null);
    const [subscription, wallet] = await Promise.all([
      getOrganizationSubscription(organization.id).catch(() => null),
      getOrganizationCreditBalance(organization.id),
    ]);
    const planId = subscription?.planId || 'free';
    const available = unitsToCredits(wallet.availableUnits);

    return NextResponse.json({
      organization_id: organization.id,
      plan_id: planId,
      plan_name: planDisplayName(planId),
      billing_enforced: isBillingEnforced(),
      credits: {
        available,
        reserved: unitsToCredits(wallet.reservedUnits),
        total: unitsToCredits(wallet.balanceUnits),
        status: wallet.status,
        never_expires: true,
      },
      features: buildPlanFeatureMap(planId, isBillingEnforced()),
    });
  } catch (error) {
    console.error('[billing/plan-access]', error);
    return NextResponse.json({ error: 'Could not load plan access' }, { status: 503 });
  }
}
