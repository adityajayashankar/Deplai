import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { permissionGroups } from '@/lib/organizations/permissions';
import { organizationApiError } from '@/lib/organizations/api';
import { requireOrganizationPermission, roleCatalog } from '@/lib/organizations/store';

export async function GET(_request: Request, context: { params: Promise<{ orgId: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId } = await context.params;
    await requireOrganizationPermission({ userId: auth.user.id, organizationId: orgId, action: 'role.read' });
    return NextResponse.json({ roles: roleCatalog(), permissionGroups: permissionGroups() });
  } catch (error) {
    return organizationApiError(error);
  }
}
