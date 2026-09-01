import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { acceptOrganizationInvitation } from '@/lib/organizations/members';
import { ACTIVE_ORGANIZATION_COOKIE } from '@/lib/organizations/store';
import { organizationApiError } from '@/lib/organizations/api';

export async function POST(_request: Request, context: { params: Promise<{ token: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { token } = await context.params;
    const accepted = await acceptOrganizationInvitation({
      userId: auth.user.id,
      userEmail: auth.user.email,
      token,
    });
    const response = NextResponse.json({ accepted: true, organizationId: accepted.organizationId });
    response.cookies.set(ACTIVE_ORGANIZATION_COOKIE, accepted.organizationId, {
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
