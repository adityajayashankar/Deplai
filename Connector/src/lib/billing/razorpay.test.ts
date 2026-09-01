import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { razorpayErrorMessage } from './razorpay';

describe('razorpayErrorMessage', () => {
  it('explains authentication failures instead of a generic checkout error', () => {
    assert.match(
      razorpayErrorMessage({ statusCode: 401, error: { description: 'Authentication failed' } }),
      /authentication failed/i,
    );
  });

  it('explains billing schema gaps instead of a generic provider error', () => {
    assert.match(
      razorpayErrorMessage({ code: 'ER_BAD_FIELD_ERROR', message: 'Unknown column idempotency_key' }),
      /migrate:billing/i,
    );
  });
});
