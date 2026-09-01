import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import {
  deleteOrganizationTeam,
  getOrganizationTeam,
  updateOrganizationTeam,
} from '@/lib/organizations/teams';
import { normalizeDescription, normalizeTeamName, organizationApiError } from '@/lib/organizations/api';

type Context = { params: Promise<{ orgId: string; teamId: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId, teamId } = await context.params;
    return NextResponse.json({ team: await getOrganizationTeam(auth.user.id, orgId, teamId) });
  } catch (error) {
    return organizationApiError(error);
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId, teamId } = await context.params;
    const body = await request.json().catch(() => ({})) as { name?: unknown; description?: unknown };
    await updateOrganizationTeam({
      actorUserId: auth.user.id,
      organizationId: orgId,
      teamId,
      name: normalizeTeamName(body.name),
      description: normalizeDescription(body.description),
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
    const { orgId, teamId } = await context.params;
    await deleteOrganizationTeam({ actorUserId: auth.user.id, organizationId: orgId, teamId });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return organizationApiError(error);
  }
}
