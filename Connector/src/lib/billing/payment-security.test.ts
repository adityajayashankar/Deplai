import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PaymentConfigurationError,
  paymentConfig,
  publicPaymentConfig,
  resolvePaymentAmountPaise,
} from './config';
import { quoteInrCharge, retargetQuoteTotal } from './money';
import { canTransitionPaymentState } from './payment-state';
import { normalizeCheckoutIdempotencyKey } from './razorpay';
import { takeBillingRateLimit } from './rate-limit';

function testEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PAYMENTS_ENABLED: 'true',
    PAYMENTS_PROVIDER: 'razorpay',
    PAYMENTS_MODE: 'test',
    PAYMENTS_TEST_AMOUNT_OVERRIDE: 'true',
    PAYMENTS_TEST_AMOUNT_PAISE: '100',
    RAZORPAY_KEY_ID: 'rzp_test_public',
    RAZORPAY_KEY_SECRET: 'server-only-secret',
    RAZORPAY_WEBHOOK_SECRET: 'server-only-webhook-secret',
    ...overrides,
  };
}

describe('payment configuration safety', () => {
  it('forces every test checkout to exactly 100 paise', () => {
    const config = paymentConfig(testEnv());
    assert.equal(resolvePaymentAmountPaise(499_00, config), 100);
    assert.equal(resolvePaymentAmountPaise(999_00, config), 100);
  });

  it('refuses the test override in live mode unless explicitly allowed', () => {
    assert.throws(
      () => paymentConfig(testEnv({
        PAYMENTS_MODE: 'live',
        RAZORPAY_KEY_ID: 'rzp_live_public',
      })),
      PaymentConfigurationError,
    );
    const allowed = paymentConfig(testEnv({
      PAYMENTS_MODE: 'live',
      RAZORPAY_KEY_ID: 'rzp_live_public',
      PAYMENTS_ALLOW_LIVE_ONE_RUPEE_TEST: 'true',
    }));
    assert.equal(resolvePaymentAmountPaise(499_00, allowed), 100);
  });

  it('refuses test keys in live mode and live keys in test mode', () => {
    assert.throws(() => paymentConfig(testEnv({ RAZORPAY_KEY_ID: 'rzp_live_public' })), PaymentConfigurationError);
    assert.throws(() => paymentConfig(testEnv({
      PAYMENTS_MODE: 'live',
      PAYMENTS_TEST_AMOUNT_OVERRIDE: 'false',
      RAZORPAY_KEY_ID: 'rzp_test_public',
    })), PaymentConfigurationError);
  });

  it('keeps the real catalog price but makes the GST invoice total exactly ₹1', () => {
    const real = quoteInrCharge({
      usdCents: 2_000,
      usdToInr: 83,
      gstPercent: 18,
      sellerStateCode: '29',
      buyerStateCode: '27',
    });
    const test = retargetQuoteTotal(real, resolvePaymentAmountPaise(real.totalPaise, paymentConfig(testEnv())));
    assert.equal(test.displayAmountCents, 2_000);
    assert.equal(test.totalPaise, 100);
    assert.equal(test.taxablePaise + test.cgstPaise + test.sgstPaise + test.igstPaise, 100);
  });

  it('exposes only safe public payment settings', () => {
    const publicConfig = publicPaymentConfig(paymentConfig(testEnv()));
    assert.equal(publicConfig.mode, 'test');
    assert.equal('keySecret' in publicConfig, false);
    assert.equal('webhookSecret' in publicConfig, false);
    assert.equal(JSON.stringify(publicConfig).includes('server-only-secret'), false);
  });
});

describe('checkout request protection', () => {
  it('requires a bounded client idempotency token', () => {
    assert.equal(normalizeCheckoutIdempotencyKey('checkout_1234567890'), 'checkout_1234567890');
    assert.throws(() => normalizeCheckoutIdempotencyKey('short'));
    assert.throws(() => normalizeCheckoutIdempotencyKey('bad key with spaces'));
  });

  it('rate limits repeated order creation', () => {
    const base = { userId: 'rate-user', action: 'create_order' as const, limit: 2, windowMs: 60_000 };
    assert.equal(takeBillingRateLimit({ ...base, now: 1_000 }).allowed, true);
    assert.equal(takeBillingRateLimit({ ...base, now: 1_001 }).allowed, true);
    assert.equal(takeBillingRateLimit({ ...base, now: 1_002 }).allowed, false);
    assert.equal(takeBillingRateLimit({ ...base, now: 61_001 }).allowed, true);
  });
});

describe('payment state ordering', () => {
  it('does not let an old authorized event downgrade a captured payment', () => {
    assert.equal(canTransitionPaymentState('captured', 'authorized'), false);
    assert.equal(canTransitionPaymentState('captured', 'failed'), false);
    assert.equal(canTransitionPaymentState('captured', 'refund_pending'), true);
  });
});
