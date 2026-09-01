import { NextRequest, NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/http/request-context';
import { getDashboardMetrics } from '@/lib/platform/billing';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await requireAdminApi(request, { permission: 'ADMIN_BILLING_READ' });
  if ('error' in auth) return auth.error;
  const metrics = await getDashboardMetrics();
  return NextResponse.json(metrics);
}
