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
});
