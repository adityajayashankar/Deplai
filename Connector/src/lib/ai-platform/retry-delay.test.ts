import assert from 'node:assert/strict';
import test from 'node:test';
import { AiPlatformError } from './errors';
import { parseRetryAfter, retryDelayMs } from './retry-delay';

test('rate limit waits for the shared minute budget to reset', () => {
  const error = new AiPlatformError('RATE_LIMIT', 'busy', { detail: { retryAfterSeconds: 60 } });
  assert.equal(retryDelayMs(error, 0, 0), 60_100);
  assert.equal(retryDelayMs(error, 1, 60_100), null);
  assert.equal(retryDelayMs(error, 2, 0), null);
});

test('daily quota, authentication and invalid patches are not retried', () => {
  for (const code of ['QUOTA_EXCEEDED', 'AUTHENTICATION_ERROR', 'INVALID_REQUEST'] as const) {
    assert.equal(retryDelayMs(new AiPlatformError(code, 'blocked'), 0, 0), null);
  }
  assert.equal(retryDelayMs(new AiPlatformError('RATE_LIMIT', 'busy'), 0, 0), 15_000);
});

test('Retry-After accepts seconds and HTTP dates without shortening upstream waits', () => {
  assert.equal(parseRetryAfter('90'), 90);
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:01:00 GMT', 0), 60);
  assert.equal(parseRetryAfter('invalid'), undefined);
  assert.equal(retryDelayMs(new AiPlatformError('RATE_LIMIT', 'busy', { detail: { retryAfterSeconds: 90 } }), 0, 0), null);
});
