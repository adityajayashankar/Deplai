import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { createOrganizationTeam, listOrganizationTeams } from '@/lib/organizations/teams';
import { normalizeDescription, normalizeTeamName, organizationApiError } from '@/lib/organizations/api';

type Context = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId } = await context.params;
    return NextResponse.json({ teams: await listOrganizationTeams(auth.user.id, orgId) });
  } catch (error) {
    return organizationApiError(error);
  }
}

export async function POST(request: NextRequest, context: Context) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId } = await context.params;
    const body = await request.json().catch(() => ({})) as { name?: unknown; description?: unknown };
    const team = await createOrganizationTeam({
      actorUserId: auth.user.id,
      organizationId: orgId,
      name: normalizeTeamName(body.name),
      description: normalizeDescription(body.description),
    });
    return NextResponse.json({ team }, { status: 201 });
  } catch (error) {
    return organizationApiError(error);
  }
}
