import { NextRequest, NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/http/request-context';
import { getPaymentDetail, listPayments } from '@/lib/platform/billing';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await requireAdminApi(request, { permission: 'ADMIN_BILLING_READ' });
  if ('error' in auth) return auth.error;
  const url = new URL(request.url);
  const paymentId = url.searchParams.get('id');
  if (paymentId) {
    const payment = await getPaymentDetail(paymentId);
    if (!payment) return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
    return NextResponse.json({ payment });
  }
  const data = await listPayments({
    search: url.searchParams.get('q') || undefined,
    limit: Number(url.searchParams.get('limit') || 50),
    offset: Number(url.searchParams.get('offset') || 0),
  });
  return NextResponse.json(data);
}
