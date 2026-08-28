import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { writeAdminAuditLog } from '@/lib/billing/admin-audit';
import { fetchRazorpayPayment, isRazorpayConfigured, razorpayErrorMessage } from '@/lib/billing/razorpay';
import { fulfillCapturedRazorpayPayment } from '@/lib/billing/razorpay-fulfill';

export const runtime = 'nodejs';

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ paymentId: string }> },
) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const { paymentId } = await context.params;
  const id = String(paymentId || '').trim();
  if (!id) {
    return NextResponse.json({ error: 'paymentId is required' }, { status: 400 });
  }
  if (!isRazorpayConfigured()) {
    return NextResponse.json({ error: 'Razorpay is not configured' }, { status: 501 });
  }

  const actor = auth.user.email || auth.user.id;
  try {
    const payment = await fetchRazorpayPayment(id);
    if (payment.status !== 'captured' && !payment.captured) {
      await writeAdminAuditLog({
        actor,
        action: 'fulfillment.retry_skipped',
        target: id,
        before: { status: payment.status },
        reason: `Payment is ${payment.status}, not captured`,
      });
      return NextResponse.json(
        {
          repaired: false,
          reason: `Razorpay payment status is ${payment.status || 'unknown'}; only captured payments can be fulfilled.`,
          code: 'payment_not_captured',
        },
        { status: 409 },
      );
    }

    const result = await fulfillCapturedRazorpayPayment(payment);
    await writeAdminAuditLog({
      actor,
      action: 'fulfillment.retry',
      target: id,
      after: result,
      reason: result.alreadyProvisioned ? 'Already provisioned; intent marked paid if needed' : 'Fulfillment repaired',
    });
    return NextResponse.json({
      repaired: !result.alreadyProvisioned,
      already_provisioned: result.alreadyProvisioned,
      invoice_id: result.invoiceId,
      invoice_number: result.invoiceNumber,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = razorpayErrorMessage(error, error instanceof Error ? error.message : 'Fulfillment retry failed');
    await writeAdminAuditLog({
      actor,
      action: 'fulfillment.retry_failed',
      target: id,
      reason: message,
    }).catch(() => undefined);
    const status = code === 'intent_not_found' || code === 'payment_not_captured' ? 409 : 500;
    return NextResponse.json({ repaired: false, reason: message, code: code || 'retry_failed' }, { status });
  }
}
