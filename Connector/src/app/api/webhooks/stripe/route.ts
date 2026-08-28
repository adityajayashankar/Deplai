import { NextRequest, NextResponse } from 'next/server';
import { handleStripeEvent, parseStripeEvent, verifyStripeSignature } from '@/lib/billing/stripe';

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim() || '';
  const signature = request.headers.get('stripe-signature');

  if (!secret) {
    return NextResponse.json({ error: 'STRIPE_WEBHOOK_SECRET is not configured' }, { status: 501 });
  }
  if (!verifyStripeSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  try {
    const event = parseStripeEvent(rawBody);
    const result = await handleStripeEvent(event);
    return NextResponse.json({ received: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Webhook handler failed';
    console.warn('Stripe webhook failed', message);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
