import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHmac } from 'node:crypto';
import {
  razorpayExpectedSignature,
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
} from './razorpay-signature';

describe('verifyRazorpayPaymentSignature', () => {
  it('accepts a standard checkout order signature', () => {
    const secret = 'test_secret';
    const orderId = 'order_1';
    const paymentId = 'pay_1';
    const signature = createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
    assert.equal(
      verifyRazorpayPaymentSignature({ orderId, paymentId, signature, secret }),
      true,
    );
    assert.equal(
      verifyRazorpayPaymentSignature({ orderId: 'order_tampered', paymentId, signature, secret }),
      false,
    );
  });

  it('accepts a subscription checkout signature', () => {
    const secret = 'test_secret';
    const paymentId = 'pay_1';
    const subscriptionId = 'sub_1';
    const signature = createHmac('sha256', secret).update(`${paymentId}|${subscriptionId}`).digest('hex');
    assert.equal(
      verifyRazorpayPaymentSignature({ paymentId, subscriptionId, signature, secret }),
      true,
    );
    assert.equal(
      verifyRazorpayPaymentSignature({
        paymentId,
        subscriptionId: 'sub_other',
        signature,
        secret,
      }),
      false,
    );
  });
});

describe('verifyRazorpayWebhookSignature', () => {
  it('accepts the raw-body HMAC and rejects tampering', () => {
    const secret = 'whsec';
    const body = '{"event":"subscription.charged"}';
    const header = razorpayExpectedSignature(body, secret);
    assert.equal(verifyRazorpayWebhookSignature(body, header, secret), true);
    assert.equal(verifyRazorpayWebhookSignature(`${body}x`, header, secret), false);
  });
});
