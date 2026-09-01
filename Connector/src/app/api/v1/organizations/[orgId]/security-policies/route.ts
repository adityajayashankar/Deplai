import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { organizationApiError } from '@/lib/organizations/api';
import { getOrganizationSecurityPolicy, saveOrganizationSecurityPolicy } from '@/lib/organizations/policies';
import type { SecurityPolicyConfiguration } from '@/lib/organizations/governance';

type Context = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId } = await context.params;
    return NextResponse.json({ policy: await getOrganizationSecurityPolicy(auth.user.id, orgId) });
  } catch (error) {
    return organizationApiError(error);
  }
}

export async function PUT(request: NextRequest, context: Context) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId } = await context.params;
    const body = await request.json().catch(() => ({})) as {
      enabled?: boolean;
      configuration?: Partial<SecurityPolicyConfiguration>;
    };
    const policy = await saveOrganizationSecurityPolicy({
      actorUserId: auth.user.id,
      organizationId: orgId,
      enabled: body.enabled === true,
      configuration: body.configuration || {},
    });
    return NextResponse.json({ policy });
  } catch (error) {
    return organizationApiError(error);
  }
}
