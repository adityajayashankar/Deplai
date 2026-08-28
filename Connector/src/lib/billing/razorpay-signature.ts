import { createHmac, timingSafeEqual } from 'node:crypto';

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function razorpayExpectedSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyRazorpayPaymentSignature(input: {
  orderId?: string | null;
  paymentId: string;
  subscriptionId?: string | null;
  signature: string;
  secret: string;
}): boolean {
  const paymentId = input.paymentId.trim();
  const signature = input.signature.trim();
  const secret = input.secret.trim();
  if (!paymentId || !signature || !secret) return false;

  const subscriptionId = input.subscriptionId?.trim();
  const orderId = input.orderId?.trim();
  const candidates: string[] = [];
  if (orderId) candidates.push(`${orderId}|${paymentId}`);
  if (subscriptionId) candidates.push(`${paymentId}|${subscriptionId}`);
  if (candidates.length === 0) return false;

  return candidates.some((payload) => safeEqual(razorpayExpectedSignature(payload, secret), signature));
}

export function verifyRazorpayWebhookSignature(rawBody: string, header: string | null | undefined, secret: string): boolean {
  const signature = String(header || '').trim();
  const trimmedSecret = secret.trim();
  if (!signature || !trimmedSecret) return false;
  return safeEqual(razorpayExpectedSignature(rawBody, trimmedSecret), signature);
}
