import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { FREE_PLAN_ID, getOrganizationSubscription, listCreditPacks, listPlans } from '@/lib/billing/credits';
import {
  createCreditPackOrder,
  createPlanSubscriptionCheckout,
  isRazorpayConfigured,
  razorpayErrorMessage,
  razorpayHttpStatus,
} from '@/lib/billing/razorpay';
import { takeBillingRateLimit } from '@/lib/billing/rate-limit';
import { resolveBillingOrganization } from '@/lib/billing/organization-context';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const rateLimit = takeBillingRateLimit({ userId: auth.user.id, action: 'create_order' });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many checkout attempts. Please wait and try again.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } },
    );
  }

  if (!isRazorpayConfigured()) {
    return NextResponse.json({ error: 'Razorpay is not configured' }, { status: 501 });
  }

  const body = await request.json().catch(() => ({})) as {
    plan_id?: string;
    credit_pack_id?: string;
    cadence?: 'monthly' | 'yearly';
    idempotency_key?: string;
  };

  try {
    const organization = await resolveBillingOrganization({ request, user: auth.user, permission: 'billing.manage' });
    if (body.credit_pack_id) {
      const packs = await listCreditPacks();
      const pack = packs.find((item) => item.id === String(body.credit_pack_id).trim());
      if (!pack) return NextResponse.json({ error: 'Unknown credit pack' }, { status: 400 });
      const subscription = await getOrganizationSubscription(organization.id).catch(() => null);
      if (pack.paidTiersOnly && (!subscription || subscription.planId === 'free')) {
        return NextResponse.json({ error: 'Top-up packs are available on paid plans only' }, { status: 403 });
      }
      const checkout = await createCreditPackOrder({
        userId: auth.user.id,
        organizationId: organization.id,
        email: auth.user.email,
        name: auth.user.name,
        pack,
        idempotencyKey: String(body.idempotency_key || ''),
      });
      return NextResponse.json(checkout);
    }

    const planId = String(body.plan_id || '').trim();
    const cadence = body.cadence === 'yearly' ? 'yearly' : 'monthly';
    const plans = await listPlans();
    const plan = plans.find((item) => item.id === planId);
    if (!plan) {
      return NextResponse.json({ error: 'Unknown plan. Pass plan_id or credit_pack_id.' }, { status: 400 });
    }
    if (!plan.isAvailable) {
      return NextResponse.json(
        { error: plan.availabilityMessage || 'This plan is not available yet.', code: 'plan_coming_soon' },
        { status: 409 },
      );
    }
    if (plan.id === FREE_PLAN_ID) {
      return NextResponse.json({ error: 'Free plan does not require checkout' }, { status: 400 });
    }

    const checkout = await createPlanSubscriptionCheckout({
      userId: auth.user.id,
      organizationId: organization.id,
      email: auth.user.email,
      name: auth.user.name,
      plan,
      cadence,
      idempotencyKey: String(body.idempotency_key || ''),
    });
    return NextResponse.json(checkout);
  } catch (error) {
    const message = razorpayErrorMessage(error);
    return NextResponse.json({ error: message }, { status: razorpayHttpStatus(error) });
  }
}
