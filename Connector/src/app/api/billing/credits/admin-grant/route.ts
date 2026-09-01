import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { adminOrganizationCreditGrant } from '@/lib/billing/organization-credits';
import { resolveActiveOrganization } from '@/lib/organizations/store';

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => ({})) as {
    user_id?: string;
    organization_id?: string;
    paid_credits?: number;
    notes?: string;
  };
  const userId = String(body.user_id || '').trim();
  const organizationId = String(body.organization_id || '').trim();
  const paidCredits = Number(body.paid_credits);
  if ((!userId && !organizationId) || !Number.isInteger(paidCredits) || paidCredits < 0) {
    return NextResponse.json(
      { error: 'organization_id or user_id and a non-negative integer paid_credits are required' },
      { status: 400 },
    );
  }

  try {
    let targetOrgId = organizationId;
    if (!targetOrgId) {
      const organization = await resolveActiveOrganization({ id: userId, email: '', name: '' });
      targetOrgId = organization.id;
    }
    const result = await adminOrganizationCreditGrant({
      organizationId: targetOrgId,
      userId: userId || auth.user.id,
      credits: paidCredits,
      notes: body.notes,
    });
    return NextResponse.json({
      organization_id: targetOrgId,
      grant_id: result.grantId,
      available: result.balance.availableUnits.toString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to grant organization credits';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
