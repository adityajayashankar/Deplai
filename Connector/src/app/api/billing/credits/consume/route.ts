import { NextRequest, NextResponse } from 'next/server';
import { requireServiceKey } from '@/lib/auth';
import { InsufficientCreditsError, consumeCredits } from '@/lib/billing/credits';

export async function POST(request: NextRequest) {
  const denied = requireServiceKey(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({})) as {
    user_id?: string;
    amount?: number;
    source?: string;
  };
  const userId = String(body.user_id || '').trim();
  const amount = Number(body.amount);
  const source = String(body.source || 'api_usage').trim() || 'api_usage';
  if (!userId || !Number.isInteger(amount) || amount <= 0) {
    return NextResponse.json({ error: 'user_id and a positive integer amount are required' }, { status: 400 });
  }

  try {
    const result = await consumeCredits(userId, amount, source);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          paid_remaining: error.paidRemaining,
          bonus_remaining: error.bonusRemaining,
        },
        { status: 402 },
      );
    }
    const message = error instanceof Error ? error.message : 'Failed to consume credits';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
