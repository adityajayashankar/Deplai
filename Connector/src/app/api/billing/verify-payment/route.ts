import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { findCheckoutIntent } from '@/lib/billing/invoices';
import { razorpaySecret } from '@/lib/billing/razorpay';
import { assertPaymentSignature, fulfillVerifiedPayment } from '@/lib/billing/razorpay-fulfill';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => ({})) as {
    razorpay_order_id?: string;
    razorpay_payment_id?: string;
    razorpay_subscription_id?: string;
    razorpay_signature?: string;
  };

  const paymentId = String(body.razorpay_payment_id || '').trim();
  const signature = String(body.razorpay_signature || '').trim();
  const orderId = String(body.razorpay_order_id || '').trim() || null;
  const subscriptionId = String(body.razorpay_subscription_id || '').trim() || null;

  if (!paymentId || !signature || (!orderId && !subscriptionId)) {
    return NextResponse.json({ error: 'Missing payment verification fields' }, { status: 400 });
  }

  const secret = razorpaySecret();
  if (!secret) {
    return NextResponse.json({ error: 'Razorpay is not configured' }, { status: 501 });
  }

  try {
    assertPaymentSignature({
      orderId,
      paymentId,
      subscriptionId,
      signature,
      secret,
    });
  } catch {
    return NextResponse.json({ error: 'Invalid payment signature' }, { status: 400 });
  }

  const intent = await findCheckoutIntent({ orderId, subscriptionId });
  if (!intent || intent.userId !== auth.user.id) {
    return NextResponse.json({ error: 'Checkout intent not found' }, { status: 400 });
  }

  try {
    const result = await fulfillVerifiedPayment({
      userId: auth.user.id,
      email: auth.user.email,
      intent,
      paymentId,
      orderId,
      subscriptionId,
      source: 'client_verify',
      rawPayload: body,
    });
    return NextResponse.json({
      ok: true,
      invoice_id: result.invoiceId,
      invoice_number: result.invoiceNumber,
      already_provisioned: result.alreadyProvisioned,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to provision payment';
    console.warn('verify-payment failed', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
