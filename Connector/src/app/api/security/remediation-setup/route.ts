import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { userModelSetup, remediationModelSetup } from '@/lib/ai-platform/model-setup';
import { resolveBillingOrganization } from '@/lib/billing/organization-context';

export async function GET(request: NextRequest) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const organization = await resolveBillingOrganization({
    request,
    user,
    permission: 'billing.read',
  }).catch(() => null);
  return NextResponse.json(await remediationModelSetup({
    userId: user.id,
    organizationId: organization?.id,
  }));
}
