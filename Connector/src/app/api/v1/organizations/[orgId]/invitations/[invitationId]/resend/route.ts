import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { resendOrganizationInvitation } from '@/lib/organizations/members';
import { organizationApiError } from '@/lib/organizations/api';

export async function POST(_request: Request, context: { params: Promise<{ orgId: string; invitationId: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId, invitationId } = await context.params;
    const invitation = await resendOrganizationInvitation({ actorUserId: auth.user.id, organizationId: orgId, invitationId });
    return NextResponse.json({ acceptPath: `/invite/${invitation.token}`, expiresInSeconds: invitation.expiresInSeconds });
  } catch (error) {
    return organizationApiError(error);
  }
}
