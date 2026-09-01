import 'server-only';

import type { NextRequest } from 'next/server';
import { resolveBillingOrganization } from '@/lib/billing/organization-context';
import type { PermissionKey } from '@/lib/organizations/permissions';

export type AgenticBillingContext = {
  userId: string;
  organizationId: string;
  fields: {
    user_id: string;
    organization_id: string;
  };
};

export async function resolveAgenticBillingContext(input: {
  request: NextRequest;
  user: { id: string; name?: string; login?: string; email?: string };
  permission?: PermissionKey;
}): Promise<AgenticBillingContext> {
  const organization = await resolveBillingOrganization({
    request: input.request,
    user: input.user,
    permission: input.permission || 'ai_provider.use',
  });
  const userId = String(input.user.id);
  const organizationId = String(organization.id);
  return {
    userId,
    organizationId,
    fields: {
      user_id: userId,
      organization_id: organizationId,
    },
  };
}
