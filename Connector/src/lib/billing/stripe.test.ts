import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHmac } from 'node:crypto';
import { parseStripeEvent, verifyStripeSignature } from './stripe-signature';

describe('verifyStripeSignature', () => {
  it('accepts a valid t/v1 header and rejects tampering', () => {
    const secret = 'whsec_test';
    const body = '{"id":"evt_1","type":"invoice.paid","data":{"object":{}}}';
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    const header = `t=${timestamp},v1=${digest}`;
    assert.equal(verifyStripeSignature(body, header, secret), true);
    assert.equal(verifyStripeSignature(body + 'x', header, secret), false);
    assert.equal(verifyStripeSignature(body, header, 'other'), false);
  });

  it('parses a Stripe event envelope', () => {
    const event = parseStripeEvent('{"id":"evt_1","type":"invoice.paid","data":{"object":{"id":"in_1"}}}');
    assert.equal(event.id, 'evt_1');
    assert.equal(event.type, 'invoice.paid');
  });
});
