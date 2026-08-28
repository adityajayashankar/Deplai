import { v4 as uuidv4 } from 'uuid';
import { BILLING_BRAND, billingSeller, isRazorpayConfigured, publicRazorpayKeyId } from './config';
import {
  type BillingPlan,
  type CreditPack,
} from './credits';
import {
  attachRazorpayIds,
  createCheckoutIntent,
  getBillingProfile,
} from './invoices';
import { quoteInrCharge } from './money';

export { isRazorpayConfigured, publicRazorpayKeyId };

const RAZORPAY_API = 'https://api.razorpay.com/v1';

export function razorpaySecret(): string {
  return process.env.RAZORPAY_KEY_SECRET?.trim() || '';
}

function razorpayKeyId(): string {
  return process.env.RAZORPAY_KEY_ID?.trim() || '';
}

function authHeader(): string {
  const keyId = razorpayKeyId();
  const secret = razorpaySecret();
  if (!keyId || !secret) throw new Error('Razorpay is not configured');
  return `Basic ${Buffer.from(`${keyId}:${secret}`).toString('base64')}`;
}

export function razorpayErrorMessage(error: unknown, fallback = 'Failed to start checkout'): string {
  if (error instanceof Error && error.message) return error.message;
  if (!error || typeof error !== 'object') return fallback;
  const record = error as {
    error?: { description?: string; code?: string };
    description?: string;
    message?: string;
    statusCode?: number;
  };
  const description = record.error?.description || record.description || record.message;
  if (record.statusCode === 401 || description === 'Authentication failed') {
    return 'Razorpay authentication failed. Re-copy RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET from Dashboard → Account & Settings → API Keys.';
  }
  return description || fallback;
}

async function razorpayRequest<T>(
  path: string,
  body?: Record<string, unknown>,
  extra?: { method?: 'GET' | 'POST'; headers?: Record<string, string> },
): Promise<T> {
  const method = extra?.method || (body ? 'POST' : 'GET');
  const response = await fetch(`${RAZORPAY_API}${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(extra?.headers || {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown> & {
    error?: { description?: string; code?: string };
  };
  if (!response.ok) {
    const err = new Error(razorpayErrorMessage({ ...payload, statusCode: response.status }));
    (err as Error & { statusCode?: number }).statusCode = response.status;
    throw err;
  }
  return payload as T;
}

export function razorpayHttpStatus(error: unknown): number {
  const status = (error as { statusCode?: number })?.statusCode;
  if (status === 401) return 401;
  if (error instanceof Error && /authentication failed/i.test(error.message)) return 401;
  return 500;
}

function assertMinOrderAmount(paise: number) {
  if (!Number.isInteger(paise) || paise < 100) {
    throw new Error('Amount must be at least 100 paise');
  }
}

async function createRazorpayOrder(input: {
  amountPaise: number;
  receipt: string;
  notes: Record<string, string>;
}): Promise<{ id: string; amount: number; currency: string }> {
  assertMinOrderAmount(input.amountPaise);
  return razorpayRequest('/orders', {
    amount: input.amountPaise,
    currency: 'INR',
    receipt: input.receipt.slice(0, 40),
    notes: input.notes,
  });
}

export type CheckoutSession = {
  key_id: string;
  amount: number;
  currency: 'INR';
  name: string;
  description: string;
  prefill: { name?: string; email?: string };
  notes: Record<string, string>;
  intent_id: string;
  display: {
    usdCents: number;
    taxablePaise: number;
    gstPaise: number;
    totalPaise: number;
  };
  order_id?: string;
  subscription_id?: string;
};

async function quoteForUser(input: {
  userId: string;
  usdCents: number;
  buyerName?: string;
}) {
  const seller = billingSeller();
  const profile = await getBillingProfile(input.userId);
  const quote = quoteInrCharge({
    usdCents: input.usdCents,
    usdToInr: seller.usdToInr,
    gstPercent: seller.gstPercent,
    sellerStateCode: seller.stateCode,
    buyerStateCode: profile.stateCode,
  });
  return {
    seller,
    profile,
    quote,
    buyerName: profile.legalName || input.buyerName || '',
    buyerGstin: profile.gstin || null,
    buyerAddress: profile.address || null,
    buyerStateCode: profile.stateCode || null,
    buyerStateName: profile.stateName || null,
  };
}

export async function createPlanSubscriptionCheckout(input: {
  userId: string;
  email?: string;
  name?: string;
  plan: BillingPlan;
  cadence: 'monthly' | 'yearly';
}): Promise<CheckoutSession> {
  const usdCents = input.cadence === 'yearly' ? input.plan.yearlyPriceCents : input.plan.priceCents;
  if (!usdCents || usdCents <= 0) throw new Error('This plan does not have a checkout price');
  const priced = await quoteForUser({ userId: input.userId, usdCents, buyerName: input.name });
  const intentId = uuidv4();
  await createCheckoutIntent({
    id: intentId,
    userId: input.userId,
    kind: 'subscription',
    planId: input.plan.id,
    creditPackId: null,
    cadence: input.cadence,
    displayAmountCents: priced.quote.displayAmountCents,
    taxablePaise: priced.quote.taxablePaise,
    cgstPaise: priced.quote.cgstPaise,
    sgstPaise: priced.quote.sgstPaise,
    igstPaise: priced.quote.igstPaise,
    totalPaise: priced.quote.totalPaise,
    currency: 'INR',
    taxSplit: priced.quote.taxSplit,
    buyerGstin: priced.buyerGstin,
    buyerName: priced.buyerName || null,
    buyerAddress: priced.buyerAddress,
    buyerStateCode: priced.buyerStateCode,
    buyerStateName: priced.buyerStateName,
  });

  const receipt = `pl_${input.plan.id}_${Date.now()}`.slice(0, 40);
  const order = await createRazorpayOrder({
    amountPaise: priced.quote.totalPaise,
    receipt,
    notes: {
      user_id: input.userId,
      plan_id: input.plan.id,
      cadence: input.cadence,
      intent_id: intentId,
      kind: 'subscription',
    },
  });
  await attachRazorpayIds(intentId, { orderId: order.id });

  return {
    key_id: publicRazorpayKeyId(),
    order_id: order.id,
    amount: priced.quote.totalPaise,
    currency: 'INR',
    name: BILLING_BRAND,
    description: `${input.plan.displayName} ${input.cadence} (incl. GST)`,
    prefill: { name: input.name, email: input.email },
    notes: { intent_id: intentId, user_id: input.userId, plan_id: input.plan.id },
    intent_id: intentId,
    display: {
      usdCents: priced.quote.displayAmountCents,
      taxablePaise: priced.quote.taxablePaise,
      gstPaise: priced.quote.cgstPaise + priced.quote.sgstPaise + priced.quote.igstPaise,
      totalPaise: priced.quote.totalPaise,
    },
  };
}

export async function createCreditPackOrder(input: {
  userId: string;
  email?: string;
  name?: string;
  pack: CreditPack;
}): Promise<CheckoutSession> {
  const priced = await quoteForUser({ userId: input.userId, usdCents: input.pack.priceCents, buyerName: input.name });
  const intentId = uuidv4();
  await createCheckoutIntent({
    id: intentId,
    userId: input.userId,
    kind: 'topup',
    planId: null,
    creditPackId: input.pack.id,
    cadence: null,
    displayAmountCents: priced.quote.displayAmountCents,
    taxablePaise: priced.quote.taxablePaise,
    cgstPaise: priced.quote.cgstPaise,
    sgstPaise: priced.quote.sgstPaise,
    igstPaise: priced.quote.igstPaise,
    totalPaise: priced.quote.totalPaise,
    currency: 'INR',
    taxSplit: priced.quote.taxSplit,
    buyerGstin: priced.buyerGstin,
    buyerName: priced.buyerName || null,
    buyerAddress: priced.buyerAddress,
    buyerStateCode: priced.buyerStateCode,
    buyerStateName: priced.buyerStateName,
  });

  const receipt = `tp_${input.pack.id}_${Date.now()}`.slice(0, 40);
  const order = await createRazorpayOrder({
    amountPaise: priced.quote.totalPaise,
    receipt,
    notes: {
      user_id: input.userId,
      credit_pack_id: input.pack.id,
      intent_id: intentId,
      kind: 'topup',
    },
  });
  await attachRazorpayIds(intentId, { orderId: order.id });

  return {
    key_id: publicRazorpayKeyId(),
    order_id: order.id,
    amount: priced.quote.totalPaise,
    currency: 'INR',
    name: BILLING_BRAND,
    description: `${input.pack.name} (incl. GST)`,
    prefill: { name: input.name, email: input.email },
    notes: { intent_id: intentId, user_id: input.userId, credit_pack_id: input.pack.id },
    intent_id: intentId,
    display: {
      usdCents: priced.quote.displayAmountCents,
      taxablePaise: priced.quote.taxablePaise,
      gstPaise: priced.quote.cgstPaise + priced.quote.sgstPaise + priced.quote.igstPaise,
      totalPaise: priced.quote.totalPaise,
    },
  };
}

export async function createCustomCreditOrder(input: {
  userId: string;
  email?: string;
  name?: string;
  usdAmount: number;
}): Promise<CheckoutSession> {
  const usdCents = Math.round(input.usdAmount) * 100;
  const priced = await quoteForUser({ userId: input.userId, usdCents, buyerName: input.name });
  const intentId = uuidv4();
  await createCheckoutIntent({
    id: intentId,
    userId: input.userId,
    kind: 'topup',
    planId: null,
    creditPackId: 'custom',
    cadence: null,
    displayAmountCents: priced.quote.displayAmountCents,
    taxablePaise: priced.quote.taxablePaise,
    cgstPaise: priced.quote.cgstPaise,
    sgstPaise: priced.quote.sgstPaise,
    igstPaise: priced.quote.igstPaise,
    totalPaise: priced.quote.totalPaise,
    currency: 'INR',
    taxSplit: priced.quote.taxSplit,
    buyerGstin: priced.buyerGstin,
    buyerName: priced.buyerName || null,
    buyerAddress: priced.buyerAddress,
    buyerStateCode: priced.buyerStateCode,
    buyerStateName: priced.buyerStateName,
  });

  const receipt = `tp_custom_${Date.now()}`.slice(0, 40);
  const order = await createRazorpayOrder({
    amountPaise: priced.quote.totalPaise,
    receipt,
    notes: {
      user_id: input.userId,
      credit_pack_id: 'custom',
      intent_id: intentId,
      kind: 'topup',
    },
  });
  await attachRazorpayIds(intentId, { orderId: order.id });

  return {
    key_id: publicRazorpayKeyId(),
    order_id: order.id,
    amount: priced.quote.totalPaise,
    currency: 'INR',
    name: BILLING_BRAND,
    description: `Custom credits $${Math.round(input.usdAmount)} (incl. GST)`,
    prefill: { name: input.name, email: input.email },
    notes: { intent_id: intentId, user_id: input.userId, credit_pack_id: 'custom' },
    intent_id: intentId,
    display: {
      usdCents: priced.quote.displayAmountCents,
      taxablePaise: priced.quote.taxablePaise,
      gstPaise: priced.quote.cgstPaise + priced.quote.sgstPaise + priced.quote.igstPaise,
      totalPaise: priced.quote.totalPaise,
    },
  };
}

export async function cancelRazorpaySubscription(subscriptionId: string | null | undefined): Promise<void> {
  if (!subscriptionId) return;
  try {
    await razorpayRequest(`/subscriptions/${subscriptionId}/cancel`, { cancel_at_cycle_end: 0 });
  } catch (error) {
    console.warn('Failed to cancel previous Razorpay subscription', subscriptionId, razorpayErrorMessage(error));
  }
}

export type RazorpayPayment = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  order_id?: string | null;
  email?: string | null;
  notes?: Record<string, unknown> | null;
  captured?: boolean;
};

function mapRazorpayPayment(value: Record<string, unknown>): RazorpayPayment {
  return {
    id: String(value.id || ''),
    status: String(value.status || ''),
    amount: Number(value.amount || 0),
    currency: String(value.currency || 'INR'),
    order_id: typeof value.order_id === 'string' ? value.order_id : null,
    email: typeof value.email === 'string' ? value.email : null,
    notes: value.notes && typeof value.notes === 'object' ? value.notes as Record<string, unknown> : null,
    captured: Boolean(value.captured),
  };
}

export async function fetchRazorpayPayment(paymentId: string): Promise<RazorpayPayment> {
  const payload = await razorpayRequest<Record<string, unknown>>(`/payments/${encodeURIComponent(paymentId)}`);
  const mapped = mapRazorpayPayment(payload);
  if (!mapped.id) throw new Error('Razorpay payment is missing an id');
  return mapped;
}

export async function refundRazorpayPayment(input: {
  paymentId: string;
  reason: string;
  idempotencyKey: string;
}): Promise<Record<string, unknown>> {
  return razorpayRequest(
    `/payments/${encodeURIComponent(input.paymentId)}/refund`,
    { notes: { reason: input.reason.slice(0, 255) } },
    { headers: { 'Idempotency-Key': input.idempotencyKey.slice(0, 64) } },
  );
}

export async function listRazorpayCapturedPayments(input: {
  fromUnix: number;
  toUnix: number;
}): Promise<RazorpayPayment[]> {
  const collected: RazorpayPayment[] = [];
  let skip = 0;
  const count = 100;
  for (;;) {
    const page = await razorpayRequest<{ items?: Array<Record<string, unknown>> }>(
      `/payments?from=${input.fromUnix}&to=${input.toUnix}&count=${count}&skip=${skip}`,
    );
    const items = Array.isArray(page.items) ? page.items : [];
    for (const item of items) {
      const mapped = mapRazorpayPayment(item);
      if (mapped.id && (mapped.status === 'captured' || mapped.captured)) {
        collected.push(mapped);
      }
    }
    if (items.length < count) break;
    skip += count;
    if (skip > 10000) break;
  }
  return collected;
}
