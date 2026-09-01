import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { setOrganizationTeamMember } from '@/lib/organizations/teams';
import { organizationApiError } from '@/lib/organizations/api';

type Context = { params: Promise<{ orgId: string; teamId: string; memberId: string }> };

async function set(context: Context, present: boolean) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId, teamId, memberId } = await context.params;
    await setOrganizationTeamMember({
      actorUserId: auth.user.id,
      organizationId: orgId,
      teamId,
      memberId,
      present,
    });
    return NextResponse.json({ updated: true, present });
  } catch (error) {
    return organizationApiError(error);
  }
}

export async function PUT(_request: Request, context: Context) {
  return set(context, true);
}

export async function DELETE(_request: Request, context: Context) {
  return set(context, false);
}
