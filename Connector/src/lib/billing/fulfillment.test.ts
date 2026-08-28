import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createInMemoryPaymentLock } from './fulfillment-lock';
import {
  fulfillOnceLocked,
  type FulfillmentIO,
  type FulfillVerifiedInput,
} from './razorpay-fulfill';
import { webhookDeliveryDecision } from './webhook-events';
import type { BillingInvoice, CheckoutIntent } from './invoices';

function topupIntent(overrides?: Partial<CheckoutIntent>): CheckoutIntent {
  return {
    id: 'intent_1',
    userId: 'user_1',
    kind: 'topup',
    planId: null,
    creditPackId: 'pack_10',
    cadence: null,
    displayAmountCents: 1200,
    taxablePaise: 100000,
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise: 18000,
    totalPaise: 118000,
    currency: 'INR',
    taxSplit: 'inter',
    buyerGstin: null,
    buyerName: null,
    buyerAddress: null,
    buyerStateCode: null,
    buyerStateName: null,
    razorpayOrderId: 'order_1',
    razorpaySubscriptionId: null,
    razorpayPlanId: null,
    status: 'pending',
    ...overrides,
  };
}

function invoice(paymentId: string): BillingInvoice {
  return {
    id: `inv_${paymentId}`,
    userId: 'user_1',
    invoiceNumber: 'DPL-1',
    invoiceDate: '2026-08-27',
    status: 'paid',
    kind: 'topup',
    description: 'pack',
    hsnSac: '998314',
    quantity: 1,
    sellerLegalName: 'DeplAI',
    sellerGstin: null,
    sellerAddress: null,
    sellerStateCode: null,
    sellerStateName: null,
    buyerName: 'Buyer',
    buyerEmail: 'a@b.c',
    buyerGstin: null,
    buyerAddress: null,
    buyerStateCode: null,
    buyerStateName: null,
    placeOfSupply: null,
    reverseCharge: false,
    displayAmountCents: 1200,
    displayCurrency: 'USD',
    taxablePaise: 100000,
    cgstRate: 0,
    sgstRate: 0,
    igstRate: 18,
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise: 18000,
    totalPaise: 118000,
    currency: 'INR',
    razorpayOrderId: 'order_1',
    razorpayPaymentId: paymentId,
    razorpaySubscriptionId: null,
    planId: null,
    creditPackId: 'pack_10',
  };
}

function createHarness() {
  const invoices = new Map<string, BillingInvoice>();
  const paidIntents = new Set<string>();
  let grants = 0;
  const io: FulfillmentIO = {
    findInvoiceByPaymentId: async (paymentId) => invoices.get(paymentId) || null,
    markIntentPaid: async (intentId) => {
      paidIntents.add(intentId);
    },
    getSubscription: async () => null,
    applyPlanChange: async () => ({ paidRemaining: 0, bonusRemaining: 0, proratedDelta: 0 }),
    cancelRazorpaySubscription: async () => undefined,
    grantPaidCredits: async () => {
      grants += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { paidRemaining: 10, bonusRemaining: 0, total: 10 };
    },
    grantTopUpCredits: async () => {
      grants += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { paidRemaining: 10, bonusRemaining: 0, total: 10 };
    },
    createPaidInvoice: async (input) => {
      const created = invoice(input.paymentId);
      invoices.set(input.paymentId, created);
      return created;
    },
  };
  return {
    io,
    invoices,
    paidIntents,
    grantCount: () => grants,
  };
}

const input: FulfillVerifiedInput = {
  userId: 'user_1',
  intent: topupIntent(),
  paymentId: 'pay_concurrent',
  orderId: 'order_1',
  source: 'client_verify',
};

describe('webhookDeliveryDecision', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  const timeout = 120_000;

  it('inserts when no row exists', () => {
    assert.equal(webhookDeliveryDecision(null, now, timeout), 'insert');
  });

  it('treats completed rows as duplicates', () => {
    assert.equal(
      webhookDeliveryDecision({ status: 'completed', updatedAt: now }, now, timeout),
      'duplicate',
    );
  });

  it('retries failed rows', () => {
    assert.equal(
      webhookDeliveryDecision({ status: 'failed', updatedAt: now }, now, timeout),
      'retry',
    );
  });

  it('retries processing rows past the timeout and not before', () => {
    assert.equal(
      webhookDeliveryDecision(
        { status: 'processing', updatedAt: new Date(now.getTime() - 30_000) },
        now,
        timeout,
      ),
      'duplicate',
    );
    assert.equal(
      webhookDeliveryDecision(
        { status: 'processing', updatedAt: new Date(now.getTime() - 120_000) },
        now,
        timeout,
      ),
      'retry',
    );
  });
});

describe('fulfillOnceLocked', () => {
  it('marks the checkout intent paid when an invoice already exists', async () => {
    const harness = createHarness();
    harness.invoices.set('pay_existing', invoice('pay_existing'));
    const result = await fulfillOnceLocked(
      { ...input, paymentId: 'pay_existing' },
      harness.io,
    );
    assert.equal(result.alreadyProvisioned, true);
    assert.equal(harness.grantCount(), 0);
    assert.equal(harness.paidIntents.has('intent_1'), true);
  });
});

describe('concurrent fulfillment', () => {
  it('does not double-grant when webhook and client-verify race the same payment id', async () => {
    const harness = createHarness();
    const lock = createInMemoryPaymentLock();

    const [webhook, client] = await Promise.all([
      lock.withPaymentLock(input.paymentId, () => (
        fulfillOnceLocked({ ...input, source: 'webhook' }, harness.io)
      )),
      lock.withPaymentLock(input.paymentId, () => (
        fulfillOnceLocked({ ...input, source: 'client_verify' }, harness.io)
      )),
    ]);

    const provisioned = [webhook, client].filter((item) => !item.alreadyProvisioned);
    const resumed = [webhook, client].filter((item) => item.alreadyProvisioned);
    assert.equal(provisioned.length, 1);
    assert.equal(resumed.length, 1);
    assert.equal(harness.grantCount(), 1);
    assert.equal(harness.invoices.size, 1);
    assert.equal(harness.paidIntents.has('intent_1'), true);
  });
});
