import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { findInvoiceByIntentId, getCheckoutIntent } from '@/lib/billing/invoices';
import { isConfirmedPaymentState } from '@/lib/billing/payment-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ paymentId: string }> },
) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const { paymentId } = await context.params;
  const intent = await getCheckoutIntent(String(paymentId || '').trim());
  if (!intent || intent.userId !== auth.user.id) {
    return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
  }

  const invoice = await findInvoiceByIntentId(intent.id);
  return NextResponse.json({
    payment_id: intent.id,
    status: intent.status,
    amount: intent.totalPaise,
    currency: intent.currency,
    mode: intent.paymentMode,
    confirmed: Boolean(invoice && isConfirmedPaymentState(intent.status)),
    invoice: invoice ? {
      invoice_id: invoice.id,
      invoice_number: invoice.invoiceNumber,
    } : null,
  });
}
