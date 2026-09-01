import { NextRequest, NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/http/request-context';
import { createRefund, listRefunds } from '@/lib/platform/refunds';
import { writeAdminAuditLog } from '@/lib/audit/logger';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await requireAdminApi(request, { permission: 'ADMIN_BILLING_READ' });
  if ('error' in auth) return auth.error;
  const url = new URL(request.url);
  const data = await listRefunds({
    limit: Number(url.searchParams.get('limit') || 50),
    offset: Number(url.searchParams.get('offset') || 0),
  });
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminApi(request, {
    permission: 'ADMIN_REFUND_CREATE',
    stepUp: 'refund.create',
  });
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => ({})) as {
    checkoutIntentId?: string;
    amountPaise?: number;
    reason?: string;
  };
  const checkoutIntentId = String(body.checkoutIntentId || '');
  const reason = String(body.reason || '').trim();
  const amountPaise = body.amountPaise == null ? undefined : Number(body.amountPaise);

  if (!checkoutIntentId || !reason) {
    return NextResponse.json({ error: 'checkoutIntentId and reason are required' }, { status: 400 });
  }

  try {
    const refund = await createRefund({
      checkoutIntentId,
      amountPaise,
      reason,
      requestedByAdminId: auth.context.session.adminId,
    });
    await writeAdminAuditLog({
      actorAdminId: auth.context.session.adminId,
      action: 'REFUND_CREATED',
      targetType: 'payment',
      targetId: checkoutIntentId,
      ip: auth.context.ip,
      sessionId: auth.context.session.id,
      reason,
      after: refund,
    });
    return NextResponse.json({ refund });
  } catch (error) {
    await writeAdminAuditLog({
      actorAdminId: auth.context.session.adminId,
      action: 'REFUND_FAILED',
      targetType: 'payment',
      targetId: checkoutIntentId,
      ip: auth.context.ip,
      sessionId: auth.context.session.id,
      reason,
      success: false,
      metadata: { error: error instanceof Error ? error.message : 'unknown' },
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Refund failed' },
      { status: 400 },
    );
  }
}
