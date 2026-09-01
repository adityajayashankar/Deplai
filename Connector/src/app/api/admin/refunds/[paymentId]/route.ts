import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { writeAdminAuditLog } from '@/lib/billing/admin-audit';
import {
  getCheckoutIntent,
  transitionCheckoutIntentState,
  updateInvoiceStatusByPaymentId,
} from '@/lib/billing/invoices';
import {
  fetchRazorpayPayment,
  isRazorpayConfigured,
  razorpayErrorMessage,
  refundRazorpayPayment,
} from '@/lib/billing/razorpay';
import { recordRefund, refundedAmountForIntent } from '@/lib/billing/refunds';
import { refundOrganizationCreditsForPayment } from '@/lib/billing/organization-credits';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ paymentId: string }> },
) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const { paymentId } = await context.params;
  const internalPaymentId = String(paymentId || '').trim();
  if (!internalPaymentId) return NextResponse.json({ error: 'paymentId is required' }, { status: 400 });

  const body = await request.json().catch(() => ({})) as { reason?: string; amountPaise?: number };
  const reason = String(body.reason || '').trim();
  if (!reason || reason.length > 255) {
    return NextResponse.json({ error: 'A refund reason of at most 255 characters is required' }, { status: 400 });
  }
  if (!isRazorpayConfigured()) return NextResponse.json({ error: 'Razorpay is not configured' }, { status: 501 });

  // paymentId is DeplAI's internal checkout id. The provider payment id is
  // always loaded server-side and cannot be selected by the admin browser.
  const intent = await getCheckoutIntent(internalPaymentId);
  if (!intent?.razorpayPaymentId) {
    return NextResponse.json({ error: 'Captured payment not found' }, { status: 404 });
  }

  const actor = auth.user.email || auth.user.id;
  const before = {
    status: intent.status,
    amountPaise: intent.totalPaise,
    mode: intent.paymentMode,
  };

  try {
    const providerPayment = await fetchRazorpayPayment(intent.razorpayPaymentId);
    if (providerPayment.status !== 'captured' && providerPayment.status !== 'refunded' && !providerPayment.captured) {
      return NextResponse.json(
        { error: 'Only a captured payment can be refunded', code: 'payment_not_captured' },
        { status: 409 },
      );
    }

    const recordedRefunded = await refundedAmountForIntent(intent.id);
    const alreadyRefunded = Math.max(recordedRefunded, providerPayment.amountRefunded);
    const refundable = Math.max(0, providerPayment.amount - alreadyRefunded);
    const requestedAmount = body.amountPaise == null ? refundable : Number(body.amountPaise);
    if (!Number.isInteger(requestedAmount) || requestedAmount <= 0 || requestedAmount > refundable) {
      return NextResponse.json(
        { error: `Refund amount must be between 1 and ${refundable} paise`, code: 'invalid_refund_amount' },
        { status: 400 },
      );
    }

    const digest = createHash('sha256')
      .update(`${intent.id}:${requestedAmount}:${reason}`)
      .digest('hex')
      .slice(0, 12);
    const refund = await refundRazorpayPayment({
      paymentId: intent.razorpayPaymentId,
      amountPaise: requestedAmount,
      reason,
      idempotencyKey: `dpl_ref_${intent.id.slice(0, 12)}_${digest}`.slice(0, 40),
    });
    await recordRefund({
      checkoutIntentId: intent.id,
      providerRefundId: refund.id,
      amountPaise: refund.amount || requestedAmount,
      status: refund.status || 'pending',
      reason,
      requestedByAdminId: actor,
    });
    if (refund.status === 'processed' && intent.organizationId) {
      await refundOrganizationCreditsForPayment({
        organizationId: intent.organizationId,
        actorUserId: auth.user.id,
        paymentId: intent.razorpayPaymentId,
        refundId: refund.id,
        refundAmountPaise: refund.amount || requestedAmount,
        paymentTotalPaise: intent.totalPaise,
        reason,
      });
    }

    const totalAfter = alreadyRefunded + requestedAmount;
    const next = refund.status === 'processed'
      ? totalAfter >= providerPayment.amount
        ? 'refunded'
        : 'partially_refunded'
      : 'refund_pending';
    await transitionCheckoutIntentState(intent.id, next);
    await updateInvoiceStatusByPaymentId(intent.razorpayPaymentId, next);
    await writeAdminAuditLog({
      actor,
      action: 'payment.refund.requested',
      target: intent.id,
      before,
      after: { status: next, refundId: refund.id, amountPaise: requestedAmount },
      reason,
    });
    return NextResponse.json({
      refunded: true,
      payment_id: intent.id,
      refund: {
        id: refund.id,
        amount: refund.amount || requestedAmount,
        status: refund.status,
      },
    });
  } catch (error) {
    const message = razorpayErrorMessage(error, 'Refund could not be created');
    await writeAdminAuditLog({
      actor,
      action: 'payment.refund.failed',
      target: intent.id,
      before,
      reason,
    }).catch(() => undefined);
    return NextResponse.json({ refunded: false, error: message }, { status: 500 });
  }
}
