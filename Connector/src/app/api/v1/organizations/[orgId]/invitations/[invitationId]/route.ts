import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { revokeOrganizationInvitation } from '@/lib/organizations/members';
import { organizationApiError } from '@/lib/organizations/api';

export async function DELETE(_request: Request, context: { params: Promise<{ orgId: string; invitationId: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId, invitationId } = await context.params;
    await revokeOrganizationInvitation({ actorUserId: auth.user.id, organizationId: orgId, invitationId });
    return NextResponse.json({ revoked: true });
  } catch (error) {
    return organizationApiError(error);
  }
}
