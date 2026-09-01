import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getOrganizationSubscription, listCreditPacks } from '@/lib/billing/credits';
import {
  createCreditPackOrder,
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
    return NextResponse.json(
      {
        error: 'Razorpay is not configured. Top-up packs cannot be purchased until RAZORPAY_KEY_ID is set.',
        code: 'razorpay_not_configured',
      },
      { status: 501 },
    );
  }

  const body = await request.json().catch(() => ({})) as {
    credit_pack_id?: string;
    idempotency_key?: string;
  };
  const packId = String(body.credit_pack_id || '').trim();

  try {
    const organization = await resolveBillingOrganization({ request, user: auth.user, permission: 'billing.manage' });

    const packs = await listCreditPacks();
    const pack = packs.find((item) => item.id === packId);
    if (!pack) {
      return NextResponse.json({ error: 'Unknown credit pack' }, { status: 400 });
    }

    const subscription = await getOrganizationSubscription(organization.id).catch(() => null);
    if (pack.paidTiersOnly && (!subscription || subscription.planId === 'free')) {
      return NextResponse.json(
        { error: 'Top-up packs are available on paid plans only', code: 'paid_tier_required' },
        { status: 403 },
      );
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
  } catch (error) {
    const message = razorpayErrorMessage(error, 'Failed to start top-up checkout');
    console.warn('Razorpay top-up checkout failed', message);
    return NextResponse.json({ error: message }, { status: razorpayHttpStatus(error) });
  }
}
