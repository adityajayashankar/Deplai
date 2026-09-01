import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { resolveBillingOrganization } from '@/lib/billing/organization-context';
import { listOrganizationCreditTransactions } from '@/lib/billing/organization-credits';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const organization = await resolveBillingOrganization({ request, user: auth.user, permission: 'billing.read' });
    const result = await listOrganizationCreditTransactions({
      organizationId: organization.id,
      cursor: request.nextUrl.searchParams.get('cursor'),
      limit: Number(request.nextUrl.searchParams.get('limit') || 30),
    });
    return NextResponse.json({ organization_id: organization.id, ...result });
  } catch (error) {
    console.error('[credits/transactions]', error);
    return NextResponse.json({ error: 'Could not load organization credit transactions' }, { status: 503 });
  }
}
