import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getOrganizationSubscription } from '@/lib/billing/credits';
import {
  getOrganizationCreditBalance,
  publicCreditBalance,
  reconcileOrganizationSubscriptionCredits,
} from '@/lib/billing/organization-credits';
import { planDisplayName } from '@/lib/billing/credit-catalog';
import { resolveBillingOrganization } from '@/lib/billing/organization-context';

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  try {
    const organization = await resolveBillingOrganization({ request, user: auth.user, permission: 'billing.read' });
    await reconcileOrganizationSubscriptionCredits(organization.id).catch(() => null);
    const balance = await getOrganizationCreditBalance(organization.id);
    const subscription = await getOrganizationSubscription(organization.id).catch(() => null);
    const planId = subscription?.planId || 'free';

    return NextResponse.json({
      ...publicCreditBalance(balance),
      plan_id: planId,
      plan_name: planDisplayName(planId),
      subscription,
    });
  } catch (error) {
    console.error('[credits/balance]', error);
    return NextResponse.json(
      { error: 'Could not load credit balance' },
      { status: 503 },
    );
  }
}
