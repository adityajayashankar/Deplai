import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { writeAdminAuditLog } from '@/lib/billing/admin-audit';
import {
  failFulfillmentAttempt,
  startFulfillmentAttempt,
} from '@/lib/billing/fulfillment-attempts';
import {
  findCheckoutIntent,
  findCheckoutIntentByPaymentId,
  transitionCheckoutIntentState,
  updateInvoiceStatusByPaymentId,
} from '@/lib/billing/invoices';
import { fulfillFromWebhookPayload } from '@/lib/billing/razorpay-fulfill';
import { verifyRazorpayWebhookSignature } from '@/lib/billing/razorpay-signature';
import { recordRefund, refundedAmountForIntent, updateRefundStatus } from '@/lib/billing/refunds';
import { refundOrganizationCreditsForPayment } from '@/lib/billing/organization-credits';
import {
  beginWebhookDelivery,
  completeWebhookDelivery,
  failWebhookDelivery,
} from '@/lib/billing/webhook-events';

export const runtime = 'nodejs';

type RazorpayEvent = { event?: string; payload?: Record<string, unknown> };

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || '';
  const signature = request.headers.get('x-razorpay-signature');

  if (!secret) return NextResponse.json({ error: 'Webhook is not configured' }, { status: 501 });
  if (!verifyRazorpayWebhookSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  let event: RazorpayEvent;
  try {
    event = JSON.parse(rawBody) as RazorpayEvent;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const type = String(event.event || '').trim();
  const handledTypes = new Set([
    'payment.authorized',
    'payment.captured',
    'payment.failed',
    'order.paid',
    'subscription.charged',
    'refund.created',
    'refund.processed',
    'refund.failed',
  ]);
  if (!handledTypes.has(type)) return NextResponse.json({ received: true, ignored: true });

  const providerEventId = request.headers.get('x-razorpay-event-id')?.trim()
    || `body_${createHash('sha256').update(rawBody).digest('hex')}`;
  const eventKey = `razorpay:${providerEventId}`.slice(0, 191);
  const claimed = await beginWebhookDelivery(eventKey, type);
  if (!claimed) return NextResponse.json({ received: true, duplicate: true });

  try {
    const payload = event.payload || {};
    if (type === 'payment.authorized') {
      const payment = entity(payload, 'payment');
      const intent = await findCheckoutIntent({ orderId: stringField(payment, 'order_id') });
      if (intent) {
        await transitionCheckoutIntentState(intent.id, 'authorized', {
          paymentId: stringField(payment, 'id'),
        });
      }
    } else if (type === 'payment.failed') {
      const payment = entity(payload, 'payment');
      const intent = await findCheckoutIntent({ orderId: stringField(payment, 'order_id') });
      if (intent) {
        await transitionCheckoutIntentState(intent.id, 'failed', {
          paymentId: stringField(payment, 'id'),
          failureCode: stringField(payment, 'error_code') || 'payment_failed',
          failureDescription: sanitizeFailure(stringField(payment, 'error_description')),
        });
        await paymentAudit('payment.failed', intent.id, { mode: intent.paymentMode });
      }
    } else if (type.startsWith('refund.')) {
      await processRefundWebhook(type, payload);
    } else {
      const result = await fulfillFromWebhookPayload(payload);
      if (!result) {
        const payment = entity(payload, 'payment');
        const attemptId = await startFulfillmentAttempt({
          paymentId: stringField(payment, 'id'),
          orderId: stringField(payment, 'order_id'),
          source: 'webhook',
          rawPayload: { event: type },
        });
        await failFulfillmentAttempt(attemptId, 'Checkout intent could not be resolved from the signed webhook');
        throw new Error('Checkout intent could not be resolved');
      }
    }

    await completeWebhookDelivery(eventKey);
    return NextResponse.json({ received: true });
  } catch (error) {
    await failWebhookDelivery(eventKey);
    const code = String((error as { code?: string }).code || 'webhook_processing_failed');
    console.warn('Razorpay webhook processing failed', code);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}

async function processRefundWebhook(type: string, payload: Record<string, unknown>): Promise<void> {
  const refund = entity(payload, 'refund');
  const refundId = stringField(refund, 'id');
  const providerPaymentId = stringField(refund, 'payment_id');
  if (!refundId || !providerPaymentId) throw new Error('Refund webhook is missing identifiers');
  const intent = await findCheckoutIntentByPaymentId(providerPaymentId);
  if (!intent) throw new Error('Refund checkout intent was not found');

  const status = type === 'refund.failed'
    ? 'failed'
    : type === 'refund.processed'
      ? 'processed'
      : String(refund?.status || 'pending');
  const amountPaise = Math.max(0, Number(refund?.amount || 0));
  await recordRefund({
    checkoutIntentId: intent.id,
    providerRefundId: refundId,
    amountPaise,
    status,
    reason: 'Razorpay webhook update',
    requestedByAdminId: 'razorpay-webhook',
  });
  await updateRefundStatus(refundId, status);

  if (status === 'failed') {
    await transitionCheckoutIntentState(intent.id, 'captured');
    await updateInvoiceStatusByPaymentId(providerPaymentId, 'paid');
    return;
  }
  if (status === 'processed' && intent.organizationId && amountPaise > 0) {
    await refundOrganizationCreditsForPayment({
      organizationId: intent.organizationId,
      paymentId: providerPaymentId,
      refundId,
      refundAmountPaise: amountPaise,
      paymentTotalPaise: intent.totalPaise,
      reason: 'Razorpay refund processed',
    });
  }
  const refunded = await refundedAmountForIntent(intent.id);
  const next = status === 'processed' && refunded >= intent.totalPaise
    ? 'refunded'
    : status === 'processed'
      ? 'partially_refunded'
      : 'refund_pending';
  await transitionCheckoutIntentState(intent.id, next);
  await updateInvoiceStatusByPaymentId(providerPaymentId, next);
  await paymentAudit(`payment.${next}`, intent.id, { providerRefundId: refundId, amountPaise });
}

function entity(payload: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = payload[key];
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return record.entity && typeof record.entity === 'object'
    ? record.entity as Record<string, unknown>
    : record;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sanitizeFailure(value: string | null): string {
  return (value || 'The payment provider reported a failed payment').slice(0, 255);
}

async function paymentAudit(action: string, target: string, after?: unknown): Promise<void> {
  await writeAdminAuditLog({ actor: 'razorpay-webhook', action, target, after }).catch(() => undefined);
}
