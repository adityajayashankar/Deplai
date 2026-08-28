import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { ENTERPRISE_PLAN_ID, FREE_PLAN_ID, getBalance, listCreditPacks, listPlans } from '@/lib/billing/credits';
import { SALES_EMAIL } from '@/lib/billing/config';
import {
  createCreditPackOrder,
  createPlanSubscriptionCheckout,
  isRazorpayConfigured,
  razorpayErrorMessage,
  razorpayHttpStatus,
} from '@/lib/billing/razorpay';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  if (!isRazorpayConfigured()) {
    return NextResponse.json({ error: 'Razorpay is not configured' }, { status: 501 });
  }

  const body = await request.json().catch(() => ({})) as {
    plan_id?: string;
    credit_pack_id?: string;
    cadence?: 'monthly' | 'yearly';
  };

  try {
    if (body.credit_pack_id) {
      const packs = await listCreditPacks();
      const pack = packs.find((item) => item.id === String(body.credit_pack_id).trim());
      if (!pack) return NextResponse.json({ error: 'Unknown credit pack' }, { status: 400 });
      const balance = await getBalance(auth.user.id);
      if (pack.paidTiersOnly && (balance.planId === 'free' || balance.planName === 'free')) {
        return NextResponse.json({ error: 'Top-up packs are available on paid plans only' }, { status: 403 });
      }
      const checkout = await createCreditPackOrder({
        userId: auth.user.id,
        email: auth.user.email,
        name: auth.user.name,
        pack,
      });
      return NextResponse.json({
        order_id: checkout.order_id,
        amount: checkout.amount,
        currency: checkout.currency,
        key_id: checkout.key_id,
        name: checkout.name,
        description: checkout.description,
        prefill: checkout.prefill,
        notes: checkout.notes,
      });
    }

    const planId = String(body.plan_id || '').trim();
    const cadence = body.cadence === 'yearly' ? 'yearly' : 'monthly';
    const plans = await listPlans();
    const plan = plans.find((item) => item.id === planId);
    if (!plan) {
      return NextResponse.json({ error: 'Unknown plan. Pass plan_id or credit_pack_id.' }, { status: 400 });
    }
    if (plan.id === ENTERPRISE_PLAN_ID || plan.isCustom) {
      return NextResponse.json({ error: 'Contact sales for Enterprise', salesEmail: SALES_EMAIL }, { status: 400 });
    }
    if (plan.id === FREE_PLAN_ID) {
      return NextResponse.json({ error: 'Free plan does not require checkout' }, { status: 400 });
    }

    const checkout = await createPlanSubscriptionCheckout({
      userId: auth.user.id,
      email: auth.user.email,
      name: auth.user.name,
      plan,
      cadence,
    });
    return NextResponse.json({
      order_id: checkout.order_id,
      amount: checkout.amount,
      currency: checkout.currency,
      key_id: checkout.key_id,
      name: checkout.name,
      description: checkout.description,
      prefill: checkout.prefill,
      notes: checkout.notes,
    });
  } catch (error) {
    const message = razorpayErrorMessage(error);
    return NextResponse.json({ error: message }, { status: razorpayHttpStatus(error) });
  }
}
