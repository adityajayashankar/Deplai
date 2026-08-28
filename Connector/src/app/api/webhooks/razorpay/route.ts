import { NextRequest, NextResponse } from 'next/server';
import {
  failFulfillmentAttempt,
  startFulfillmentAttempt,
} from '@/lib/billing/fulfillment-attempts';
import { fulfillFromWebhookPayload } from '@/lib/billing/razorpay-fulfill';
import { verifyRazorpayWebhookSignature } from '@/lib/billing/razorpay-signature';
import {
  beginWebhookDelivery,
  completeWebhookDelivery,
  failWebhookDelivery,
} from '@/lib/billing/webhook-events';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || '';
  const signature = request.headers.get('x-razorpay-signature');

  if (!secret) {
    return NextResponse.json({ error: 'RAZORPAY_WEBHOOK_SECRET is not configured' }, { status: 501 });
  }
  if (!verifyRazorpayWebhookSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  let event: { event?: string; payload?: Record<string, unknown>; entity?: string };
  try {
    event = JSON.parse(rawBody) as { event?: string; payload?: Record<string, unknown> };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const type = String(event.event || '');
  const handledTypes = new Set(['subscription.charged', 'payment.captured']);
  if (!handledTypes.has(type)) {
    return NextResponse.json({ received: true, ignored: true });
  }

  const payment = (event.payload?.payment as { entity?: { id?: string } } | undefined)?.entity
    || (event.payload?.payment as { id?: string } | undefined);
  const paymentId = String(payment?.id || '').trim();
  const eventKey = `${type}:${paymentId || 'unknown'}`;

  const claimed = await beginWebhookDelivery(eventKey, type);
  if (!claimed) return NextResponse.json({ received: true, duplicate: true });

  try {
    const result = await fulfillFromWebhookPayload(event.payload || {});
    if (!result) {
      const attemptId = await startFulfillmentAttempt({
        paymentId: paymentId || null,
        source: 'webhook',
        rawPayload: event.payload || {},
      });
      await failFulfillmentAttempt(attemptId, 'Checkout intent or user could not be resolved from the Razorpay payload');
      await failWebhookDelivery(eventKey);
      return NextResponse.json(
        { error: 'Checkout intent or user could not be resolved from the Razorpay payload' },
        { status: 400 },
      );
    }
    await completeWebhookDelivery(eventKey);
    return NextResponse.json({ received: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Webhook handler failed';
    await failWebhookDelivery(eventKey);
    console.warn('Razorpay webhook failed', message);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
