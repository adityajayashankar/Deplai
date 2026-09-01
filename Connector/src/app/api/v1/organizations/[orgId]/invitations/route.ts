import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import {
  createOrganizationInvitation,
  listOrganizationInvitations,
} from '@/lib/organizations/members';
import { normalizeEmail, organizationApiError } from '@/lib/organizations/api';

type Context = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId } = await context.params;
    return NextResponse.json({ invitations: await listOrganizationInvitations(auth.user.id, orgId) });
  } catch (error) {
    return organizationApiError(error);
  }
}

export async function POST(request: NextRequest, context: Context) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId } = await context.params;
    const body = await request.json().catch(() => ({})) as { email?: unknown; roleKey?: unknown };
    const invitation = await createOrganizationInvitation({
      actorUserId: auth.user.id,
      organizationId: orgId,
      email: normalizeEmail(body.email),
      roleKey: String(body.roleKey || 'DEVELOPER'),
    });
    return NextResponse.json({
      invitation: {
        id: invitation.id,
        acceptPath: `/invite/${invitation.token}`,
        expiresInSeconds: invitation.expiresInSeconds,
      },
    }, { status: 201 });
  } catch (error) {
    return organizationApiError(error);
  }
}
