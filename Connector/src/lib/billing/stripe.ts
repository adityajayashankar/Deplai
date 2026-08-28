import {
  ENTERPRISE_PLAN_ID,
  applyPlanChange,
  findUserIdByStripeCustomer,
  findUserIdByStripeSubscription,
  getSubscription,
  grantTopUpCredits,
  provisionCreditsOnRenewal,
} from './credits';
import { beginWebhookDelivery, completeWebhookDelivery, failWebhookDelivery } from './webhook-events';
import { type StripeEvent } from './stripe-signature';

export { parseStripeEvent, verifyStripeSignature } from './stripe-signature';
export { SALES_EMAIL } from './config';

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim() && process.env.STRIPE_WEBHOOK_SECRET?.trim());
}

export function isStripeCheckoutConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

export function planIdFromStripePrice(priceId: string | null | undefined): string | null {
  if (!priceId) return null;
  const mapping: Array<[string | undefined, string]> = [
    [process.env.STRIPE_PRICE_STARTER_20_MONTHLY, 'starter_20'],
    [process.env.STRIPE_PRICE_STARTER_20_YEARLY, 'starter_20'],
    [process.env.STRIPE_PRICE_PRO_50_MONTHLY, 'pro_50'],
    [process.env.STRIPE_PRICE_PRO_50_YEARLY, 'pro_50'],
  ];
  for (const [envPrice, planId] of mapping) {
    if (envPrice && envPrice === priceId) return planId;
  }
  return null;
}

export function stripePriceForPlan(planId: string, cadence: 'monthly' | 'yearly'): string | null {
  if (planId === 'starter_20') {
    return (cadence === 'yearly'
      ? process.env.STRIPE_PRICE_STARTER_20_YEARLY
      : process.env.STRIPE_PRICE_STARTER_20_MONTHLY) || null;
  }
  if (planId === 'pro_50') {
    return (cadence === 'yearly'
      ? process.env.STRIPE_PRICE_PRO_50_YEARLY
      : process.env.STRIPE_PRICE_PRO_50_MONTHLY) || null;
  }
  return null;
}

const STRIPE_API = 'https://api.stripe.com/v1';

async function stripeForm(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
  const body = new URLSearchParams(params);
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof payload.error === 'object' && payload.error && 'message' in payload.error
      ? String((payload.error as { message?: string }).message)
      : `Stripe request failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

export async function createSubscriptionCheckout(input: {
  userId: string;
  email?: string;
  planId: string;
  cadence: 'monthly' | 'yearly';
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string }> {
  if (input.planId === ENTERPRISE_PLAN_ID || input.planId === 'free') {
    throw new Error('This plan does not use Stripe checkout');
  }
  const priceId = stripePriceForPlan(input.planId, input.cadence);
  if (!priceId) {
    throw new Error('Stripe price IDs are not configured for this plan');
  }
  const session = await stripeForm('/checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.userId,
    'metadata[user_id]': input.userId,
    'metadata[plan_id]': input.planId,
    'metadata[cadence]': input.cadence,
    'subscription_data[metadata][user_id]': input.userId,
    'subscription_data[metadata][plan_id]': input.planId,
    'subscription_data[metadata][cadence]': input.cadence,
    ...(input.email ? { customer_email: input.email } : {}),
  });
  if (typeof session.url !== 'string' || !session.url) {
    throw new Error('Stripe did not return a checkout URL');
  }
  return { url: session.url };
}

export async function createTopUpCheckout(input: {
  userId: string;
  email?: string;
  packId: string;
  amountCents: number;
  credits: number;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string }> {
  const session = await stripeForm('/checkout/sessions', {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(input.amountCents),
    'line_items[0][price_data][product_data][name]': `${input.credits} extra credits`,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.userId,
    'metadata[kind]': 'topup',
    'metadata[user_id]': input.userId,
    'metadata[credit_pack_id]': input.packId,
    ...(input.email ? { customer_email: input.email } : {}),
  });
  if (typeof session.url !== 'string' || !session.url) {
    throw new Error('Stripe did not return a checkout URL');
  }
  return { url: session.url };
}

function metadataOf(object: Record<string, unknown>): Record<string, string> {
  const meta = object.metadata;
  if (!meta || typeof meta !== 'object') return {};
  return Object.fromEntries(
    Object.entries(meta as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
  );
}

function firstPriceId(object: Record<string, unknown>): string | null {
  const lines = object.lines as { data?: Array<{ price?: { id?: string } }> } | undefined;
  const fromInvoice = lines?.data?.[0]?.price?.id;
  if (fromInvoice) return fromInvoice;
  const items = object.items as { data?: Array<{ price?: { id?: string } }> } | undefined;
  return items?.data?.[0]?.price?.id || null;
}

async function resolveUserId(object: Record<string, unknown>): Promise<string | null> {
  const meta = metadataOf(object);
  if (meta.user_id) return meta.user_id;
  const parent = object.subscription;
  if (typeof parent === 'string') {
    const fromSub = await findUserIdByStripeSubscription(parent);
    if (fromSub) return fromSub;
  }
  const parentObj = object.subscription as { metadata?: Record<string, string> } | undefined;
  if (parentObj?.metadata?.user_id) return parentObj.metadata.user_id;
  const customer = object.customer;
  if (typeof customer === 'string') {
    return findUserIdByStripeCustomer(customer);
  }
  const clientRef = object.client_reference_id;
  return typeof clientRef === 'string' ? clientRef : null;
}

export async function handleStripeEvent(event: StripeEvent): Promise<{ handled: boolean; duplicate?: boolean }> {
  const claimed = await beginWebhookDelivery(event.id, event.type);
  if (!claimed) return { handled: true, duplicate: true };

  try {
    const result = await processStripeEvent(event);
    await completeWebhookDelivery(event.id);
    return result;
  } catch (error) {
    await failWebhookDelivery(event.id);
    throw error;
  }
}

async function processStripeEvent(event: StripeEvent): Promise<{ handled: boolean; duplicate?: boolean }> {
  const object = event.data.object;
  const meta = metadataOf(object);

  if (event.type === 'invoice.paid') {
    const reason = String(object.billing_reason || '');
    if (reason === 'subscription_update') {
      return { handled: true };
    }
    const userId = await resolveUserId(object);
    const planId = meta.plan_id || planIdFromStripePrice(firstPriceId(object));
    if (!userId || !planId) return { handled: true };
    const cadence = meta.cadence === 'yearly' ? 'yearly' : 'monthly';
    await provisionCreditsOnRenewal(userId, planId, {
      source: 'subscription_renewal',
      cadence,
      stripeCustomerId: typeof object.customer === 'string' ? object.customer : null,
      stripeSubscriptionId: typeof object.subscription === 'string' ? object.subscription : null,
    });
    return { handled: true };
  }

  if (event.type === 'customer.subscription.updated') {
    const userId = await resolveUserId(object);
    const planId = meta.plan_id || planIdFromStripePrice(firstPriceId(object));
    if (!userId || !planId) return { handled: true };
    const current = await getSubscription(userId);
    if (current?.planId === planId) return { handled: true };
    const cadence = meta.cadence === 'yearly' ? 'yearly' : 'monthly';
    await applyPlanChange({
      userId,
      nextPlanId: planId,
      cadence,
      stripeCustomerId: typeof object.customer === 'string' ? object.customer : null,
      stripeSubscriptionId: typeof object.id === 'string' ? object.id : null,
    });
    return { handled: true };
  }

  if (event.type === 'checkout.session.completed') {
    if (meta.kind === 'topup' && meta.user_id && meta.credit_pack_id) {
      await grantTopUpCredits(meta.user_id, meta.credit_pack_id);
      return { handled: true };
    }
    return { handled: true };
  }

  return { handled: false };
}
