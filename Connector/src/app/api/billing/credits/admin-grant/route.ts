import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { adminCreditGrant } from '@/lib/billing/credits';

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => ({})) as {
    user_id?: string;
    paid_credits?: number;
    bonus_percent?: number;
    rollover_months_cap?: number;
    seat_count?: number;
    notes?: string;
  };
  const userId = String(body.user_id || '').trim();
  const paidCredits = Number(body.paid_credits);
  if (!userId || !Number.isInteger(paidCredits) || paidCredits < 0) {
    return NextResponse.json({ error: 'user_id and paid_credits are required' }, { status: 400 });
  }

  const result = await adminCreditGrant({
    userId,
    paidCredits,
    bonusPercent: Number.isFinite(body.bonus_percent) ? Number(body.bonus_percent) : 0,
    rolloverMonthsCap: Number.isFinite(body.rollover_months_cap) ? Number(body.rollover_months_cap) : 0,
    seatCount: Number.isFinite(body.seat_count) ? Number(body.seat_count) : 1,
    notes: body.notes,
  });
  return NextResponse.json(result);
}
