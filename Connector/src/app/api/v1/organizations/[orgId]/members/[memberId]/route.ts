import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { removeOrganizationMember, updateOrganizationMember } from '@/lib/organizations/members';
import { organizationApiError } from '@/lib/organizations/api';

type Context = { params: Promise<{ orgId: string; memberId: string }> };

export async function PATCH(request: NextRequest, context: Context) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId, memberId } = await context.params;
    const body = await request.json().catch(() => ({})) as { roleKey?: string; status?: 'ACTIVE' | 'SUSPENDED' };
    await updateOrganizationMember({
      actorUserId: auth.user.id,
      organizationId: orgId,
      memberId,
      roleKey: body.roleKey,
      status: body.status,
    });
    return NextResponse.json({ updated: true });
  } catch (error) {
    return organizationApiError(error);
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId, memberId } = await context.params;
    await removeOrganizationMember({ actorUserId: auth.user.id, organizationId: orgId, memberId });
    return NextResponse.json({ removed: true });
  } catch (error) {
    return organizationApiError(error);
  }
}
