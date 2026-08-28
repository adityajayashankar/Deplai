import { NextRequest, NextResponse } from 'next/server';
import { requireServiceKey } from '@/lib/auth';
import { expireBonusCredits, provisionDueCycles } from '@/lib/billing/credits';

export async function POST(request: NextRequest) {
  const denied = requireServiceKey(request);
  if (denied) return denied;

  const expired = await expireBonusCredits();
  const provisioned = await provisionDueCycles();
  return NextResponse.json({ expired, provisioned });
}
