import {
  applyPlanChange,
  findUserIdByRazorpaySubscription,
  getSubscription,
  grantPaidCredits,
  grantTopUpCredits,
  provisionCreditsOnRenewal,
  linkSubscriptionToOrganization,
} from './credits';
import {
  type BillingInvoice,
  type CheckoutIntent,
  createPaidInvoice,
  findCheckoutIntent,
  findInvoiceByPaymentId,
  getCheckoutIntent,
  markIntentPaid,
  transitionCheckoutIntentState,
} from './invoices';
import {
  completeFulfillmentAttempt,
  failFulfillmentAttempt,
  startFulfillmentAttempt,
  type FulfillmentSource,
} from './fulfillment-attempts';
import { withPaymentLock } from './fulfillment-lock';
import {
  assertCapturedPaymentMatchesIntent,
  cancelRazorpaySubscription,
  type RazorpayPayment,
} from './razorpay';
import { verifyRazorpayPaymentSignature } from './razorpay-signature';
import { isConfirmedPaymentState } from './payment-state';
import { fulfillOrganizationCreditPurchase } from './organization-credits';

export type FulfillResult = {
  invoiceId: string;
  invoiceNumber: string;
  alreadyProvisioned: boolean;
};

export type FulfillmentIO = {
  findInvoiceByPaymentId: (paymentId: string) => Promise<BillingInvoice | null>;
  markIntentPaid: (intentId: string) => Promise<void>;
  getSubscription: typeof getSubscription;
  applyPlanChange: typeof applyPlanChange;
  cancelRazorpaySubscription: typeof cancelRazorpaySubscription;
  grantPaidCredits: typeof grantPaidCredits;
  grantTopUpCredits: typeof grantTopUpCredits;
  createPaidInvoice: typeof createPaidInvoice;
  fulfillOrganizationCreditPurchase?: typeof fulfillOrganizationCreditPurchase;
  linkSubscriptionToOrganization?: typeof linkSubscriptionToOrganization;
};

const productionIo: FulfillmentIO = {
  findInvoiceByPaymentId,
  markIntentPaid,
  getSubscription,
  applyPlanChange,
  cancelRazorpaySubscription,
  grantPaidCredits,
  grantTopUpCredits,
  createPaidInvoice,
  fulfillOrganizationCreditPurchase,
  linkSubscriptionToOrganization,
};

export type FulfillVerifiedInput = {
  userId: string;
  email?: string;
  intent: CheckoutIntent;
  paymentId: string;
  orderId?: string | null;
  subscriptionId?: string | null;
  source?: FulfillmentSource;
  rawPayload?: unknown;
  captured: true;
};

function notesOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, String(entry)]),
  );
}

export async function fulfillOnceLocked(
  input: FulfillVerifiedInput,
  io: FulfillmentIO = productionIo,
): Promise<FulfillResult> {
  if (input.captured !== true) throw new Error('Captured payment evidence is required before fulfillment');
  const existing = await io.findInvoiceByPaymentId(input.paymentId);
  if (existing) {
    await io.markIntentPaid(input.intent.id);
    return {
      invoiceId: existing.id,
      invoiceNumber: existing.invoiceNumber,
      alreadyProvisioned: true,
    };
  }

  if (input.intent.kind === 'subscription' && input.intent.planId) {
    const current = await io.getSubscription(input.userId);
    const previousSubId = current?.razorpaySubscriptionId;
    await io.applyPlanChange({
      userId: input.userId,
      nextPlanId: input.intent.planId,
      cadence: input.intent.cadence || 'monthly',
      razorpaySubscriptionId: input.subscriptionId || input.intent.razorpaySubscriptionId,
    });
    if (input.intent.organizationId && io.linkSubscriptionToOrganization) {
      await io.linkSubscriptionToOrganization(input.userId, input.intent.organizationId);
    }
    if (previousSubId && previousSubId !== (input.subscriptionId || input.intent.razorpaySubscriptionId)) {
      await io.cancelRazorpaySubscription(previousSubId);
    }
  } else if (input.intent.kind !== 'topup' || !input.intent.creditPackId || input.intent.creditPackId === 'custom') {
    throw new Error('Checkout intent is missing a plan or credit pack');
  }

  if (input.intent.organizationId && io.fulfillOrganizationCreditPurchase) {
    await io.fulfillOrganizationCreditPurchase({
      organizationId: input.intent.organizationId,
      userId: input.userId,
      paymentId: input.paymentId,
      planId: input.intent.planId,
      creditPackId: input.intent.creditPackId,
      cadence: input.intent.cadence,
      paymentMode: input.intent.paymentMode,
    });
  } else if (input.intent.kind === 'topup' && input.intent.creditPackId) {
    // Compatibility only for checkout intents created before organization wallets.
    await io.grantTopUpCredits(input.userId, input.intent.creditPackId);
  }

  if (input.intent.kind === 'subscription' && input.intent.planId && input.intent.planId !== 'free') {
    const { processReferralConversion } = await import('@/lib/referrals/rewards');
    await processReferralConversion({
      referredUserId: input.userId,
      paymentId: input.paymentId,
      checkoutIntentId: input.intent.id,
      planId: input.intent.planId,
      cadence: input.intent.cadence,
    });
  }

  const description = input.intent.kind === 'subscription'
    ? `DeplAI ${input.intent.planId} ${input.intent.cadence || 'monthly'} subscription`
    : `DeplAI credit pack ${input.intent.creditPackId}`;

  const invoice = await io.createPaidInvoice({
    userId: input.userId,
    buyerEmail: input.email || '',
    intent: input.intent,
    description,
    paymentId: input.paymentId,
    orderId: input.orderId,
    subscriptionId: input.subscriptionId,
  });
  await io.markIntentPaid(input.intent.id);
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    alreadyProvisioned: false,
  };
}

export async function fulfillVerifiedPayment(
  input: FulfillVerifiedInput,
  io: FulfillmentIO = productionIo,
  lock: <T>(paymentId: string, work: () => Promise<T>) => Promise<T> = withPaymentLock,
): Promise<FulfillResult> {
  const attemptId = await startFulfillmentAttempt({
    paymentId: input.paymentId,
    orderId: input.orderId,
    source: input.source || 'client_verify',
    rawPayload: input.rawPayload,
  });
  try {
    const result = await lock(input.paymentId, () => fulfillOnceLocked(input, io));
    await completeFulfillmentAttempt(attemptId);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to provision payment';
    await failFulfillmentAttempt(attemptId, message);
    throw error;
  }
}

export function assertPaymentSignature(input: {
  orderId?: string | null;
  paymentId: string;
  subscriptionId?: string | null;
  signature: string;
  secret: string;
}): void {
  if (!verifyRazorpayPaymentSignature(input)) {
    throw new Error('Invalid Razorpay signature');
  }
}

export async function fulfillFromWebhookPayload(
  payload: Record<string, unknown>,
): Promise<FulfillResult | null> {
  const paymentEntity = nestedEntity(payload, 'payment') || asRecord(payload.payment);
  const subscriptionEntity = nestedEntity(payload, 'subscription') || asRecord(payload.subscription);
  const paymentId = stringId(paymentEntity);
  const subscriptionId = stringId(subscriptionEntity)
    || (typeof paymentEntity?.subscription_id === 'string' ? paymentEntity.subscription_id : null);
  const orderId = typeof paymentEntity?.order_id === 'string' ? paymentEntity.order_id : null;
  if (!paymentId) return null;

  const intent = await findCheckoutIntent({ orderId, subscriptionId });
  const userId = intent?.userId || (subscriptionId ? await findUserIdByRazorpaySubscription(subscriptionId) : null);
  if (!intent || !userId) return null;

  const payment: RazorpayPayment = {
    id: paymentId,
    status: String(paymentEntity?.status || ''),
    amount: Number(paymentEntity?.amount || 0),
    amountRefunded: Number(paymentEntity?.amount_refunded || 0),
    currency: String(paymentEntity?.currency || ''),
    order_id: orderId,
    email: typeof paymentEntity?.email === 'string' ? paymentEntity.email : null,
    notes: paymentEntity?.notes && typeof paymentEntity.notes === 'object'
      ? paymentEntity.notes as Record<string, unknown>
      : null,
    captured: Boolean(paymentEntity?.captured) || paymentEntity?.status === 'captured',
  };
  const wasPreviouslyCaptured = isConfirmedPaymentState(intent.status);
  assertCapturedPaymentMatchesIntent(payment, intent);
  await transitionCheckoutIntentState(intent.id, 'captured', { paymentId });

  const existing = await findInvoiceByPaymentId(paymentId);
  const isRenewal = Boolean(subscriptionId && intent.kind === 'subscription' && wasPreviouslyCaptured);
  if (!existing && isRenewal && intent.planId) {
    await provisionCreditsOnRenewal(userId, intent.planId, {
      source: 'subscription_renewal',
      cadence: intent.cadence || 'monthly',
      razorpaySubscriptionId: subscriptionId,
    });
  }

  return fulfillVerifiedPayment({
    userId,
    email: typeof paymentEntity?.email === 'string' ? paymentEntity.email : undefined,
    intent,
    paymentId,
    orderId,
    subscriptionId,
    source: 'webhook',
    captured: true,
    rawPayload: payload,
  });
}

export async function fulfillCapturedRazorpayPayment(payment: RazorpayPayment): Promise<FulfillResult> {
  if (payment.status !== 'captured' && !payment.captured) {
    throw Object.assign(new Error(`Razorpay payment ${payment.id} is ${payment.status || 'not captured'}`), {
      code: 'payment_not_captured',
    });
  }
  const notes = notesOf(payment.notes);
  const orderId = payment.order_id || null;
  const subscriptionId = typeof payment.notes === 'object' && payment.notes && typeof (payment.notes as { subscription_id?: unknown }).subscription_id === 'string'
    ? String((payment.notes as { subscription_id: string }).subscription_id)
    : null;
  const intent = (notes.intent_id ? await getCheckoutIntent(notes.intent_id) : null)
    || await findCheckoutIntent({ orderId, subscriptionId });
  const userId = notes.user_id || intent?.userId || null;
  if (!intent || !userId) {
    throw Object.assign(new Error('No checkout intent is linked to this Razorpay payment'), {
      code: 'intent_not_found',
    });
  }
  assertCapturedPaymentMatchesIntent(payment, intent);
  await transitionCheckoutIntentState(intent.id, 'captured', { paymentId: payment.id });
  return fulfillVerifiedPayment({
    userId,
    email: payment.email || undefined,
    intent,
    paymentId: payment.id,
    orderId,
    subscriptionId: subscriptionId || intent.razorpaySubscriptionId,
    source: 'admin_retry',
    captured: true,
    rawPayload: { payment },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  if ('entity' in (value as Record<string, unknown>) && typeof (value as { entity?: unknown }).entity === 'object') {
    return (value as { entity: Record<string, unknown> }).entity;
  }
  return value as Record<string, unknown>;
}

function nestedEntity(payload: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const container = payload[key];
  if (!container || typeof container !== 'object') return null;
  const inner = (container as { entity?: unknown }).entity;
  if (inner && typeof inner === 'object') return inner as Record<string, unknown>;
  return container as Record<string, unknown>;
}

function stringId(entity: Record<string, unknown> | null): string | null {
  if (!entity) return null;
  return typeof entity.id === 'string' ? entity.id : null;
}
