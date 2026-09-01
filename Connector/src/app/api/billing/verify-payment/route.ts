import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { writeAdminAuditLog } from '@/lib/billing/admin-audit';
import { getCheckoutIntent, transitionCheckoutIntentState } from '@/lib/billing/invoices';
import { takeBillingRateLimit } from '@/lib/billing/rate-limit';
import {
  assertCapturedPaymentMatchesIntent,
  fetchRazorpayPayment,
  razorpaySecret,
} from '@/lib/billing/razorpay';
import { assertPaymentSignature, fulfillVerifiedPayment } from '@/lib/billing/razorpay-fulfill';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const rateLimit = takeBillingRateLimit({ userId: auth.user.id, action: 'verify_payment', limit: 20 });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many verification attempts. Please wait and try again.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } },
    );
  }

  const body = await request.json().catch(() => ({})) as {
    payment_id?: string;
    razorpay_order_id?: string;
    razorpay_payment_id?: string;
    razorpay_signature?: string;
  };
  const internalPaymentId = String(body.payment_id || '').trim();
  const providerPaymentId = String(body.razorpay_payment_id || '').trim();
  const submittedOrderId = String(body.razorpay_order_id || '').trim();
  const signature = String(body.razorpay_signature || '').trim();

  if (!internalPaymentId || !providerPaymentId || !signature) {
    return NextResponse.json({ error: 'Missing payment verification fields' }, { status: 400 });
  }

  const intent = await getCheckoutIntent(internalPaymentId);
  if (!intent || intent.userId !== auth.user.id) {
    return NextResponse.json({ error: 'Checkout intent not found' }, { status: 404 });
  }
  if (!intent.razorpayOrderId) {
    return NextResponse.json({ error: 'Checkout order is not ready' }, { status: 409 });
  }
  if (submittedOrderId && submittedOrderId !== intent.razorpayOrderId) {
    await writePaymentAudit(auth.user.email || auth.user.id, 'payment.signature.failed', intent.id, {
      reason: 'submitted_order_mismatch',
    });
    return NextResponse.json({ error: 'Payment does not match this checkout' }, { status: 400 });
  }

  const secret = razorpaySecret();
  if (!secret) return NextResponse.json({ error: 'Razorpay is not configured' }, { status: 501 });

  try {
    // The signature payload always uses the provider order id loaded from the
    // database. The browser-supplied order id is never trusted for HMAC input.
    assertPaymentSignature({
      orderId: intent.razorpayOrderId,
      paymentId: providerPaymentId,
      signature,
      secret,
    });
  } catch {
    await writePaymentAudit(auth.user.email || auth.user.id, 'payment.signature.failed', intent.id);
    return NextResponse.json({ error: 'Invalid payment signature' }, { status: 400 });
  }

  await writePaymentAudit(auth.user.email || auth.user.id, 'payment.signature.verified', intent.id, {
    providerPaymentId,
    mode: intent.paymentMode,
  });

  try {
    const payment = await fetchRazorpayPayment(providerPaymentId);
    if (payment.order_id !== intent.razorpayOrderId
      || payment.amount !== intent.totalPaise
      || payment.currency !== intent.currency) {
      return NextResponse.json({ error: 'Payment does not match this checkout' }, { status: 400 });
    }

    if (payment.status === 'authorized' && !payment.captured) {
      await transitionCheckoutIntentState(intent.id, 'authorized', {
        paymentId: providerPaymentId,
        signatureVerified: true,
      });
      return NextResponse.json({
        ok: false,
        pending: true,
        payment_id: intent.id,
        status: 'authorized',
      }, { status: 202 });
    }
    if (payment.status === 'failed') {
      await transitionCheckoutIntentState(intent.id, 'failed', {
        paymentId: providerPaymentId,
        signatureVerified: true,
        failureCode: payment.failureCode || 'payment_failed',
        failureDescription: payment.failureDescription || 'The payment provider reported a failed payment',
      });
      return NextResponse.json({ error: 'Payment failed. No access was activated.' }, { status: 409 });
    }

    assertCapturedPaymentMatchesIntent(payment, intent);
    await transitionCheckoutIntentState(intent.id, 'captured', {
      paymentId: providerPaymentId,
      signatureVerified: true,
    });
    const result = await fulfillVerifiedPayment({
      userId: auth.user.id,
      email: auth.user.email,
      intent,
      paymentId: providerPaymentId,
      orderId: intent.razorpayOrderId,
      source: 'client_verify',
      captured: true,
      rawPayload: {
        payment_id: providerPaymentId,
        order_id: intent.razorpayOrderId,
        status: payment.status,
      },
    });
    await writePaymentAudit(auth.user.email || auth.user.id, 'payment.captured', intent.id, {
      providerPaymentId,
      mode: intent.paymentMode,
    });
    return NextResponse.json({
      ok: true,
      payment_id: intent.id,
      status: 'captured',
      invoice_id: result.invoiceId,
      invoice_number: result.invoiceNumber,
      already_provisioned: result.alreadyProvisioned,
    });
  } catch (error) {
    const code = String((error as { code?: string }).code || 'payment_verification_failed');
    if (code === 'payment_not_captured') {
      return NextResponse.json({
        ok: false,
        pending: true,
        payment_id: intent.id,
        status: String((error as { paymentStatus?: string }).paymentStatus || 'pending'),
      }, { status: 202 });
    }
    if (code === 'payment_order_mismatch' || code === 'payment_amount_mismatch') {
      await writePaymentAudit(auth.user.email || auth.user.id, 'payment.verification.failed', intent.id, { code });
      return NextResponse.json({ error: 'Payment does not match this checkout' }, { status: 400 });
    }
    console.warn('verify-payment failed', code);
    return NextResponse.json(
      { error: 'We could not confirm the payment. No access has been activated yet.' },
      { status: 500 },
    );
  }
}

async function writePaymentAudit(
  actor: string,
  action: string,
  paymentId: string,
  after?: unknown,
): Promise<void> {
  await writeAdminAuditLog({
    actor,
    action,
    target: paymentId,
    after,
  }).catch(() => undefined);
}
