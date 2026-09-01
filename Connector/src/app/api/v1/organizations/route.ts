import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import {
  ACTIVE_ORGANIZATION_COOKIE,
  createOrganization,
  ensurePersonalOrganization,
  listOrganizations,
  resolveActiveOrganization,
} from '@/lib/organizations/store';
import {
  normalizeOrganizationName,
  normalizeOrganizationSlug,
  organizationApiError,
} from '@/lib/organizations/api';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    await ensurePersonalOrganization(auth.user);
    const organizations = await listOrganizations(auth.user.id);
    const active = await resolveActiveOrganization(
      auth.user,
      request.cookies.get(ACTIVE_ORGANIZATION_COOKIE)?.value,
    );
    return NextResponse.json({ organizations, activeOrganizationId: active.id });
  } catch (error) {
    return organizationApiError(error);
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const body = await request.json().catch(() => ({})) as { name?: unknown; slug?: unknown };
    const name = normalizeOrganizationName(body.name);
    const slug = normalizeOrganizationSlug(body.slug, name);
    const organization = await createOrganization({ userId: auth.user.id, name, slug });
    const response = NextResponse.json({ organization }, { status: 201 });
    response.cookies.set(ACTIVE_ORGANIZATION_COOKIE, organization.id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
    return response;
  } catch (error) {
    return organizationApiError(error);
  }
}
