import Razorpay from 'razorpay';
import { v4 as uuidv4 } from 'uuid';
import { withNamedLock } from '@/lib/db';
import {
  BILLING_BRAND,
  billingSeller,
  isRazorpayConfigured,
  paymentConfig,
  publicRazorpayKeyId,
  resolvePaymentAmountPaise,
  type PaymentRuntimeConfig,
} from './config';
import { type BillingPlan, type CreditPack } from './credits';
import { assertStarterContributionSafe } from './credit-catalog';
import {
  attachRazorpayIds,
  createCheckoutIntent,
  findCheckoutIntentByIdempotency,
  getBillingProfile,
  transitionCheckoutIntentState,
  type CheckoutIntent,
} from './invoices';
import { quoteGstInclusiveInrCharge, retargetQuoteTotal, type MoneyQuote } from './money';
import { computeReferralDiscountPaise } from '@/lib/referrals/logic';
import { isReferralCheckoutEligible, recordReferralDiscountApplied } from '@/lib/referrals/store';

export { isRazorpayConfigured, publicRazorpayKeyId };

export type ProviderOrder = {
  id: string;
  amount: number;
  currency: string;
};

export type RazorpayPayment = {
  id: string;
  status: string;
  amount: number;
  amountRefunded: number;
  currency: string;
  order_id?: string | null;
  email?: string | null;
  notes?: Record<string, unknown> | null;
  captured?: boolean;
  failureCode?: string | null;
  failureDescription?: string | null;
};

export type ProviderRefund = {
  id: string;
  paymentId: string;
  amount: number;
  status: string;
};

export interface PaymentProvider {
  createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<ProviderOrder>;
  getPayment(paymentId: string): Promise<RazorpayPayment>;
  refundPayment(input: {
    paymentId: string;
    amountPaise?: number;
    reason: string;
    receipt: string;
  }): Promise<ProviderRefund>;
  listCapturedPayments(input: { fromUnix: number; toUnix: number }): Promise<RazorpayPayment[]>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function mapRazorpayPayment(value: unknown): RazorpayPayment {
  const payment = asRecord(value);
  return {
    id: String(payment.id || ''),
    status: String(payment.status || ''),
    amount: Number(payment.amount || 0),
    amountRefunded: Number(payment.amount_refunded || 0),
    currency: String(payment.currency || 'INR'),
    order_id: typeof payment.order_id === 'string' ? payment.order_id : null,
    email: typeof payment.email === 'string' ? payment.email : null,
    notes: payment.notes && typeof payment.notes === 'object' ? payment.notes as Record<string, unknown> : null,
    captured: Boolean(payment.captured),
    failureCode: typeof payment.error_code === 'string' ? payment.error_code : null,
    failureDescription: typeof payment.error_description === 'string'
      ? payment.error_description.slice(0, 255)
      : null,
  };
}

export class RazorpayPaymentProvider implements PaymentProvider {
  private readonly client: Razorpay;

  constructor(config: Pick<PaymentRuntimeConfig, 'keyId' | 'keySecret'>) {
    if (!config.keyId || !config.keySecret) throw new Error('Razorpay is not configured');
    this.client = new Razorpay({ key_id: config.keyId, key_secret: config.keySecret });
  }

  async createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<ProviderOrder> {
    assertMinOrderAmount(input.amountPaise);
    const order = await this.client.orders.create({
      amount: input.amountPaise,
      currency: 'INR',
      receipt: input.receipt.slice(0, 40),
      notes: input.notes,
    });
    const mapped = {
      id: String(order.id || ''),
      amount: Number(order.amount || 0),
      currency: String(order.currency || ''),
    };
    if (!mapped.id || mapped.amount !== input.amountPaise || mapped.currency !== 'INR') {
      throw new Error('Razorpay returned an invalid order');
    }
    return mapped;
  }

  async getPayment(paymentId: string): Promise<RazorpayPayment> {
    const mapped = mapRazorpayPayment(await this.client.payments.fetch(paymentId));
    if (!mapped.id) throw new Error('Razorpay payment is missing an id');
    return mapped;
  }

  async refundPayment(input: {
    paymentId: string;
    amountPaise?: number;
    reason: string;
    receipt: string;
  }): Promise<ProviderRefund> {
    const refund = await this.client.payments.refund(input.paymentId, {
      ...(input.amountPaise == null ? {} : { amount: input.amountPaise }),
      receipt: input.receipt.slice(0, 40),
      notes: { reason: input.reason.slice(0, 255) },
    });
    return {
      id: String(refund.id || ''),
      paymentId: String(refund.payment_id || input.paymentId),
      amount: Number(refund.amount || input.amountPaise || 0),
      status: String(refund.status || 'pending'),
    };
  }

  async listCapturedPayments(input: { fromUnix: number; toUnix: number }): Promise<RazorpayPayment[]> {
    const collected: RazorpayPayment[] = [];
    let skip = 0;
    const count = 100;
    for (;;) {
      const page = await this.client.payments.all({
        from: input.fromUnix,
        to: input.toUnix,
        count,
        skip,
      });
      const items = Array.isArray(page.items) ? page.items : [];
      for (const item of items) {
        const payment = mapRazorpayPayment(item);
        if (payment.id && (payment.status === 'captured' || payment.captured)) collected.push(payment);
      }
      if (items.length < count) break;
      skip += count;
      if (skip > 10_000) break;
    }
    return collected;
  }
}

export function razorpaySecret(): string {
  return paymentConfig().keySecret;
}

export function paymentProvider(config: PaymentRuntimeConfig = paymentConfig()): PaymentProvider {
  if (!config.enabled) throw new Error('Payments are disabled');
  return new RazorpayPaymentProvider(config);
}

export function razorpayErrorMessage(error: unknown, fallback = 'Payment provider request failed'): string {
  const record = asRecord(error);
  const code = String(record.code || '');
  if (code.startsWith('ER_')) {
    if (code === 'ER_BAD_FIELD_ERROR' || code === 'ER_NO_SUCH_TABLE') {
      return 'Billing database is not ready. Run npm run migrate:billing in the Connector folder, then restart the app.';
    }
    return 'Billing database error. Run npm run migrate:billing in the Connector folder, then restart the app.';
  }
  const nested = asRecord(record.error);
  const status = Number(record.statusCode || nested.status_code || 0);
  const description = String(nested.description || record.message || '');
  if (record.safeToExpose === true && description) return description.slice(0, 255);
  if (status === 401 || /authentication failed/i.test(description)) {
    return 'Payment provider authentication failed. Check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in Connector/.env.local (test keys must start with rzp_test_).';
  }
  if (status === 429) return 'Payment provider is busy. Please try again shortly.';
  if (status >= 500) return 'Payment provider is temporarily unavailable. Please try again.';
  return fallback;
}

export function razorpayHttpStatus(error: unknown): number {
  const record = asRecord(error);
  const nested = asRecord(record.error);
  const status = Number(record.statusCode || nested.status_code || 0);
  if (status === 400 || status === 409) return status;
  if (status === 401) return 502;
  if (status === 429) return 503;
  return 500;
}

function assertMinOrderAmount(paise: number): void {
  if (!Number.isInteger(paise) || paise < 100) throw new Error('Amount must be at least 100 paise');
}

export function normalizeCheckoutIdempotencyKey(value: unknown): string {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    throw Object.assign(new Error('A valid idempotency_key is required'), { statusCode: 400, safeToExpose: true });
  }
  return key;
}

export type CheckoutSession = {
  key_id: string;
  amount: number;
  currency: 'INR';
  name: string;
  description: string;
  prefill: { name?: string; email?: string };
  notes: Record<string, string>;
  payment_id: string;
  intent_id: string;
  mode: 'test' | 'live';
  test_charge: boolean;
  idempotency_reused: boolean;
  display: {
    usdCents: number;
    taxablePaise: number;
    gstPaise: number;
    totalPaise: number;
  };
  order_id: string;
};

async function quoteForUser(input: {
  userId: string;
  totalPaise: number;
  displayAmountCents: number;
  buyerName?: string;
  config: PaymentRuntimeConfig;
}) {
  const seller = billingSeller();
  const profile = await getBillingProfile(input.userId);
  const realQuote = quoteGstInclusiveInrCharge({
    totalPaise: input.totalPaise,
    displayAmountCents: input.displayAmountCents,
    gstPercent: seller.gstPercent,
    sellerStateCode: seller.stateCode,
    buyerStateCode: profile.stateCode,
  });
  const quote = retargetQuoteTotal(
    realQuote,
    resolvePaymentAmountPaise(realQuote.totalPaise, input.config),
  );
  return {
    profile,
    quote,
    buyerName: profile.legalName || input.buyerName || '',
    buyerGstin: profile.gstin || null,
    buyerAddress: profile.address || null,
    buyerStateCode: profile.stateCode || null,
    buyerStateName: profile.stateName || null,
  };
}

function checkoutSessionFromIntent(input: {
  intent: CheckoutIntent;
  config: PaymentRuntimeConfig;
  description: string;
  name?: string;
  email?: string;
  reused: boolean;
}): CheckoutSession {
  const orderId = input.intent.razorpayOrderId;
  if (!orderId) {
    throw Object.assign(new Error('Previous checkout attempt did not create an order'), {
      statusCode: 409,
      safeToExpose: true,
    });
  }
  return {
    key_id: input.config.keyId,
    order_id: orderId,
    amount: input.intent.totalPaise,
    currency: 'INR',
    name: BILLING_BRAND,
    description: input.description,
    prefill: { name: input.name, email: input.email },
    notes: { intent_id: input.intent.id },
    payment_id: input.intent.id,
    intent_id: input.intent.id,
    mode: input.intent.paymentMode,
    test_charge: input.config.testAmountOverride,
    idempotency_reused: input.reused,
    display: {
      usdCents: input.intent.displayAmountCents,
      taxablePaise: input.intent.taxablePaise,
      gstPaise: input.intent.cgstPaise + input.intent.sgstPaise + input.intent.igstPaise,
      totalPaise: input.intent.totalPaise,
    },
  };
}

async function createOrderCheckout(input: {
  userId: string;
  organizationId: string;
  email?: string;
  name?: string;
  idempotencyKey: string;
  kind: 'subscription' | 'topup';
  planId: string | null;
  creditPackId: string | null;
  cadence: 'monthly' | 'yearly' | null;
  totalPaise: number;
  displayAmountCents: number;
  description: string;
}): Promise<CheckoutSession> {
  assertStarterContributionSafe();
  const config = paymentConfig();
  if (!config.enabled || !config.keyId || !config.keySecret) throw new Error('Razorpay is not configured');
  const idempotencyKey = normalizeCheckoutIdempotencyKey(input.idempotencyKey);
  const lockName = `checkout:${input.userId}:${idempotencyKey}`.slice(0, 64);

  let referralAttributionId: string | null = null;
  let discountPaise = 0;
  let chargedTotalPaise = input.totalPaise;

  if (input.kind === 'subscription' && input.planId && input.planId !== 'free') {
    const referral = await isReferralCheckoutEligible(input.userId);
    if (referral.eligible && referral.attribution) {
      discountPaise = computeReferralDiscountPaise(input.totalPaise, referral.discountPercent);
      chargedTotalPaise = Math.max(100, input.totalPaise - discountPaise);
      referralAttributionId = referral.attribution.id;
    }
  }

  return withNamedLock(lockName, 15, async () => {
    const existing = await findCheckoutIntentByIdempotency(input.userId, idempotencyKey);
    if (existing) {
      const sameProduct = existing.kind === input.kind
        && existing.planId === input.planId
        && existing.creditPackId === input.creditPackId
        && existing.cadence === input.cadence;
      if (!sameProduct || existing.paymentMode !== config.mode) {
        throw Object.assign(new Error('Idempotency key was already used for another checkout'), {
          statusCode: 409,
          safeToExpose: true,
        });
      }
      return checkoutSessionFromIntent({
        intent: existing,
        config,
        description: input.description,
        name: input.name,
        email: input.email,
        reused: true,
      });
    }

    const priced = await quoteForUser({
      userId: input.userId,
      totalPaise: chargedTotalPaise,
      displayAmountCents: input.displayAmountCents,
      buyerName: input.name,
      config,
    });
    const intentId = uuidv4();
    const receipt = `dpl_${intentId.replace(/-/g, '')}`.slice(0, 40);
    const intent = await createCheckoutIntent({
      id: intentId,
      userId: input.userId,
      organizationId: input.organizationId,
      idempotencyKey,
      receipt,
      provider: 'razorpay',
      paymentMode: config.mode,
      kind: input.kind,
      planId: input.planId,
      creditPackId: input.creditPackId,
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
      referralAttributionId,
      discountPaise,
    });

    if (referralAttributionId && discountPaise > 0) {
      await recordReferralDiscountApplied({
        attributionId: referralAttributionId,
        checkoutIntentId: intentId,
        discountPaise,
      });
    }

    try {
      const order = await paymentProvider(config).createOrder({
        amountPaise: intent.totalPaise,
        receipt,
        notes: {
          intent_id: intentId,
          purchase_kind: input.kind,
          product_id: input.planId || input.creditPackId || '',
        },
      });
      await attachRazorpayIds(intentId, { orderId: order.id });
      return checkoutSessionFromIntent({
        intent: { ...intent, razorpayOrderId: order.id, status: 'pending' },
        config,
        description: input.description,
        name: input.name,
        email: input.email,
        reused: false,
      });
    } catch (error) {
      await transitionCheckoutIntentState(intentId, 'failed', {
        failureCode: 'provider_order_create_failed',
        failureDescription: 'The payment provider could not create an order',
      }).catch(() => undefined);
      throw error;
    }
  });
}

export async function createPlanSubscriptionCheckout(input: {
  userId: string;
  organizationId: string;
  email?: string;
  name?: string;
  plan: BillingPlan;
  cadence: 'monthly' | 'yearly';
  idempotencyKey: string;
}): Promise<CheckoutSession> {
  const totalPaise = input.cadence === 'yearly' ? input.plan.yearlyPricePaise : input.plan.pricePaise;
  if (!totalPaise || totalPaise <= 0) throw new Error('This plan does not have a checkout price');
  return createOrderCheckout({
    ...input,
    kind: 'subscription',
    planId: input.plan.id,
    creditPackId: null,
    totalPaise,
    displayAmountCents: Math.round(totalPaise / 100),
    description: `${input.plan.displayName} ${input.cadence} (incl. GST)`,
  });
}

export async function createCreditPackOrder(input: {
  userId: string;
  organizationId: string;
  email?: string;
  name?: string;
  pack: CreditPack;
  idempotencyKey: string;
}): Promise<CheckoutSession> {
  return createOrderCheckout({
    ...input,
    kind: 'topup',
    planId: null,
    creditPackId: input.pack.id,
    cadence: null,
    totalPaise: input.pack.pricePaise,
    displayAmountCents: Math.round(input.pack.pricePaise / 100),
    description: `${input.pack.name} (incl. GST)`,
  });
}

export async function cancelRazorpaySubscription(subscriptionId: string | null | undefined): Promise<void> {
  // Current DeplAI self-serve checkout is an Orders API purchase that creates a
  // local plan membership. There is no provider subscription to cancel here.
  if (!subscriptionId) return;
  console.warn('Provider subscription cancellation requested for a legacy subscription id');
}

export async function fetchRazorpayPayment(paymentId: string): Promise<RazorpayPayment> {
  return paymentProvider().getPayment(paymentId);
}

export async function refundRazorpayPayment(input: {
  paymentId: string;
  amountPaise?: number;
  reason: string;
  idempotencyKey: string;
}): Promise<ProviderRefund> {
  return paymentProvider().refundPayment({
    paymentId: input.paymentId,
    amountPaise: input.amountPaise,
    reason: input.reason,
    receipt: input.idempotencyKey,
  });
}

export async function listRazorpayCapturedPayments(input: {
  fromUnix: number;
  toUnix: number;
}): Promise<RazorpayPayment[]> {
  return paymentProvider().listCapturedPayments(input);
}

export function assertCapturedPaymentMatchesIntent(
  payment: RazorpayPayment,
  intent: CheckoutIntent,
): void {
  if (payment.status !== 'captured' && !payment.captured) {
    throw Object.assign(new Error('Payment is not captured yet'), {
      code: 'payment_not_captured',
      paymentStatus: payment.status,
    });
  }
  if (!intent.razorpayOrderId || payment.order_id !== intent.razorpayOrderId) {
    throw Object.assign(new Error('Payment order does not match the stored checkout'), { code: 'payment_order_mismatch' });
  }
  if (payment.amount !== intent.totalPaise || payment.currency !== intent.currency) {
    throw Object.assign(new Error('Payment amount or currency does not match the stored checkout'), { code: 'payment_amount_mismatch' });
  }
}

export function applyPaymentAmountPolicy(
  quote: MoneyQuote,
  config: PaymentRuntimeConfig,
): MoneyQuote {
  return retargetQuoteTotal(quote, resolvePaymentAmountPaise(quote.totalPaise, config));
}
