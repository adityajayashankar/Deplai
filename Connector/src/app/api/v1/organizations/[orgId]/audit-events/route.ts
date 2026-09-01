import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { organizationApiError } from '@/lib/organizations/api';
import { listOrganizationAudit } from '@/lib/organizations/store';

export async function GET(request: NextRequest, context: { params: Promise<{ orgId: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    const { orgId } = await context.params;
    const result = await listOrganizationAudit(auth.user.id, orgId, {
      limit: Number(request.nextUrl.searchParams.get('limit') || 30),
      cursor: request.nextUrl.searchParams.get('cursor'),
      action: request.nextUrl.searchParams.get('action'),
    });
    return NextResponse.json(result);
  } catch (error) {
    return organizationApiError(error);
  }
}
