import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { writeAdminAuditLog } from '@/lib/billing/admin-audit';
import { findInvoiceByPaymentId, updateInvoiceStatusByPaymentId } from '@/lib/billing/invoices';
import {
  fetchRazorpayPayment,
  isRazorpayConfigured,
  razorpayErrorMessage,
  refundRazorpayPayment,
} from '@/lib/billing/razorpay';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ paymentId: string }> },
) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const { paymentId } = await context.params;
  const id = String(paymentId || '').trim();
  if (!id) {
    return NextResponse.json({ error: 'paymentId is required' }, { status: 400 });
  }

  const body = await request.json().catch(() => ({})) as { reason?: string };
  const reason = String(body.reason || '').trim();
  if (!reason) {
    return NextResponse.json({ error: 'reason is required' }, { status: 400 });
  }
  if (!isRazorpayConfigured()) {
    return NextResponse.json({ error: 'Razorpay is not configured' }, { status: 501 });
  }

  const actor = auth.user.email || auth.user.id;
  const invoice = await findInvoiceByPaymentId(id);
  const before = {
    invoiceStatus: invoice?.status || null,
    invoiceId: invoice?.id || null,
  };

  try {
    const payment = await fetchRazorpayPayment(id);
    let refund: Record<string, unknown> | { skipped: true; status: string } ;
    if (payment.status === 'refunded') {
      refund = { skipped: true, status: payment.status };
    } else if (payment.status !== 'captured' && !payment.captured) {
      await writeAdminAuditLog({
        actor,
        action: 'refund.skipped',
        target: id,
        before,
        reason: `Payment is ${payment.status}, not captured`,
      });
      return NextResponse.json(
        {
          refunded: false,
          reason: `Razorpay payment status is ${payment.status || 'unknown'}; only captured payments can be refunded.`,
          code: 'payment_not_captured',
        },
        { status: 409 },
      );
    } else {
      refund = await refundRazorpayPayment({
        paymentId: id,
        reason,
        idempotencyKey: `deplai-refund-${id}`,
      });
    }

    if (invoice) {
      await updateInvoiceStatusByPaymentId(id, 'refunded');
    }
    const after = {
      invoiceStatus: invoice ? 'refunded' : null,
      razorpay: refund,
    };
    await writeAdminAuditLog({
      actor,
      action: 'refund.create',
      target: id,
      before,
      after,
      reason,
    });
    return NextResponse.json({
      refunded: true,
      invoice_updated: Boolean(invoice),
      razorpay: refund,
    });
  } catch (error) {
    const message = razorpayErrorMessage(error, error instanceof Error ? error.message : 'Refund failed');
    await writeAdminAuditLog({
      actor,
      action: 'refund.failed',
      target: id,
      before,
      reason: `${reason}; ${message}`,
    }).catch(() => undefined);
    return NextResponse.json({ refunded: false, reason: message }, { status: 500 });
  }
}
