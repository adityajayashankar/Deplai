import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { ENTERPRISE_PLAN_ID, FREE_PLAN_ID, listPlans } from '@/lib/billing/credits';
import { SALES_EMAIL } from '@/lib/billing/config';
import { createPlanSubscriptionCheckout, isRazorpayConfigured, razorpayErrorMessage, razorpayHttpStatus } from '@/lib/billing/razorpay';
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
    return NextResponse.json(
      { error: 'Razorpay is not configured', code: 'razorpay_not_configured', salesEmail: SALES_EMAIL },
      { status: 501 },
    );
  }

  const body = await request.json().catch(() => ({})) as {
    plan_id?: string;
    cadence?: 'monthly' | 'yearly';
    idempotency_key?: string;
  };
  const planId = String(body.plan_id || '').trim();
  const cadence = body.cadence === 'yearly' ? 'yearly' : 'monthly';
  const plans = await listPlans();
  const plan = plans.find((item) => item.id === planId);
  if (!plan) {
    return NextResponse.json({ error: 'Unknown plan' }, { status: 400 });
  }
  if (plan.id === ENTERPRISE_PLAN_ID || plan.isCustom) {
    return NextResponse.json({ error: 'Contact sales for Enterprise', salesEmail: SALES_EMAIL }, { status: 400 });
  }
  if (plan.id === FREE_PLAN_ID) {
    return NextResponse.json({ error: 'Free plan does not require checkout' }, { status: 400 });
  }

  try {
    const organization = await resolveBillingOrganization({ request, user: auth.user, permission: 'billing.manage' });
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
    console.warn('Razorpay checkout failed', message);
    return NextResponse.json({ error: message }, { status: razorpayHttpStatus(error) });
  }
}
