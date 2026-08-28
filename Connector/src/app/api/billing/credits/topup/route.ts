import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getBalance, listCreditPacks } from '@/lib/billing/credits';
import {
  createCreditPackOrder,
  createCustomCreditOrder,
  isRazorpayConfigured,
  razorpayErrorMessage,
  razorpayHttpStatus,
} from '@/lib/billing/razorpay';
import { validateCustomCreditUsd } from '@/lib/profile/logic';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  if (!isRazorpayConfigured()) {
    return NextResponse.json(
      {
        error: 'Razorpay is not configured. Top-up packs cannot be purchased until RAZORPAY_KEY_ID is set.',
        code: 'razorpay_not_configured',
      },
      { status: 501 },
    );
  }

  const body = await request.json().catch(() => ({})) as { credit_pack_id?: string; amount_usd?: number };
  const packId = String(body.credit_pack_id || '').trim();
  const wantsCustom = body.amount_usd != null || packId === 'custom';

  try {
    if (wantsCustom) {
      const parsed = validateCustomCreditUsd(body.amount_usd);
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
      }
      const balance = await getBalance(auth.user.id);
      if (balance.planId === 'free' || balance.planName === 'free') {
        return NextResponse.json(
          { error: 'Custom credits are available on paid plans only', code: 'paid_tier_required' },
          { status: 403 },
        );
      }
      const checkout = await createCustomCreditOrder({
        userId: auth.user.id,
        email: auth.user.email,
        name: auth.user.name,
        usdAmount: parsed.amount,
      });
      return NextResponse.json(checkout);
    }

    const packs = await listCreditPacks();
    const pack = packs.find((item) => item.id === packId);
    if (!pack) {
      return NextResponse.json({ error: 'Unknown credit pack' }, { status: 400 });
    }

    const balance = await getBalance(auth.user.id);
    if (pack.paidTiersOnly && (balance.planId === 'free' || balance.planName === 'free')) {
      return NextResponse.json(
        { error: 'Top-up packs are available on paid plans only', code: 'paid_tier_required' },
        { status: 403 },
      );
    }

    const checkout = await createCreditPackOrder({
      userId: auth.user.id,
      email: auth.user.email,
      name: auth.user.name,
      pack,
    });
    return NextResponse.json(checkout);
  } catch (error) {
    const message = razorpayErrorMessage(error, 'Failed to start top-up checkout');
    console.warn('Razorpay top-up checkout failed', message);
    return NextResponse.json({ error: message }, { status: razorpayHttpStatus(error) });
  }
}
