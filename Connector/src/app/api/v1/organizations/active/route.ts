import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { ACTIVE_ORGANIZATION_COOKIE, requireOrganizationPermission } from '@/lib/organizations/store';
import { organizationApiError } from '@/lib/organizations/api';

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const body = await request.json().catch(() => ({})) as { organizationId?: unknown };
    const organizationId = String(body.organizationId || '').trim();
    await requireOrganizationPermission({ userId: auth.user.id, organizationId, action: 'organization.read' });
    const response = NextResponse.json({ activeOrganizationId: organizationId });
    response.cookies.set(ACTIVE_ORGANIZATION_COOKIE, organizationId, {
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
