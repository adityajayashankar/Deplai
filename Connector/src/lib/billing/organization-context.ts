import 'server-only';

import type { NextRequest } from 'next/server';
import {
  ACTIVE_ORGANIZATION_COOKIE,
  requireOrganizationPermission,
  resolveActiveOrganization,
} from '@/lib/organizations/store';
import type { PermissionKey } from '@/lib/organizations/permissions';

export async function resolveBillingOrganization(input: {
  request: NextRequest;
  user: { id: string; name?: string; login?: string; email?: string };
  permission: PermissionKey;
}) {
  const organization = await resolveActiveOrganization(
    input.user,
    input.request.cookies.get(ACTIVE_ORGANIZATION_COOKIE)?.value,
  );
  await requireOrganizationPermission({
    userId: input.user.id,
    organizationId: organization.id,
    action: input.permission,
  });
  return organization;
}
