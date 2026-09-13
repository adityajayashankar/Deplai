import { NextRequest, NextResponse } from 'next/server';
import { requireServiceKey } from '@/lib/auth';
import {
  InsufficientOrganizationCreditsError,
  debitOrganizationCredits,
} from '@/lib/billing/organization-credits';
import { unitsToCredits } from '@/lib/billing/credit-catalog';

export async function POST(request: NextRequest) {
  const denied = requireServiceKey(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({})) as {
    organization_id?: string;
    user_id?: string;
    amount?: number;
    source?: string;
    idempotency_key?: string;
  };
  const organizationId = String(body.organization_id || '').trim();
  const userId = String(body.user_id || '').trim() || null;
  const amount = Number(body.amount);
  const source = String(body.source || 'api_usage').trim() || 'api_usage';
  const idempotencyKey = String(body.idempotency_key || `${source}:${organizationId}:${amount}:${Date.now()}`).trim();

  if (!organizationId || !Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { error: 'organization_id and a positive amount are required' },
      { status: 400 },
    );
  }

  try {
    const result = await debitOrganizationCredits({
      organizationId,
      userId,
      credits: amount,
      source,
      idempotencyKey,
    });
    return NextResponse.json({
      organization_id: organizationId,
      available: result.available,
      debited: result.debited,
      duplicate: result.duplicate,
    });
  } catch (error) {
    if (error instanceof InsufficientOrganizationCreditsError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          organization_id: error.organizationId,
          available_credits: unitsToCredits(error.availableUnits),
          required_credits: unitsToCredits(error.requiredUnits),
          top_up_path: error.topUpPath,
        },
        { status: 402 },
      );
    }
    const message = error instanceof Error ? error.message : 'Failed to consume credits';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
