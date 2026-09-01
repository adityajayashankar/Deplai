import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { listOrganizationMembers } from '@/lib/organizations/members';
import { organizationApiError } from '@/lib/organizations/api';

export async function GET(_request: Request, context: { params: Promise<{ orgId: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId } = await context.params;
    return NextResponse.json({ members: await listOrganizationMembers(auth.user.id, orgId) });
  } catch (error) {
    return organizationApiError(error);
  }
}
