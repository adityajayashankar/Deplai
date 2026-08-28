import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getBalance, getSubscription } from '@/lib/billing/credits';

export async function GET() {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  try {
    const balance = await getBalance(auth.user.id);
    const subscription = await getSubscription(auth.user.id).catch(() => null);

    return NextResponse.json({
      paid_remaining: balance.paidRemaining,
      bonus_remaining: balance.bonusRemaining,
      bonus_unlocked: balance.bonusUnlocked,
      bonus_expires_at: balance.bonusExpiresAt,
      total: balance.total,
      plan_id: balance.planId,
      plan_name: balance.planName,
      cycle_start: balance.cycleStart,
      cycle_end: balance.cycleEnd,
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
