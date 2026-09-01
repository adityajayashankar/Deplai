import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import {
  organizationOverview,
  scheduleOrganizationDeletion,
  updateOrganization,
} from '@/lib/organizations/store';
import {
  normalizeOrganizationName,
  normalizeOrganizationSlug,
  organizationApiError,
} from '@/lib/organizations/api';

type Context = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId } = await context.params;
    return NextResponse.json(await organizationOverview(auth.user.id, orgId));
  } catch (error) {
    return organizationApiError(error);
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId } = await context.params;
    const body = await request.json().catch(() => ({})) as { name?: unknown; slug?: unknown };
    const name = normalizeOrganizationName(body.name);
    const slug = normalizeOrganizationSlug(body.slug, name);
    await updateOrganization({ userId: auth.user.id, organizationId: orgId, name, slug });
    return NextResponse.json({ updated: true });
  } catch (error) {
    return organizationApiError(error);
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId } = await context.params;
    await scheduleOrganizationDeletion(auth.user.id, orgId);
    return NextResponse.json({ deletionScheduled: true, recoveryDays: 30 });
  } catch (error) {
    return organizationApiError(error);
  }
}
