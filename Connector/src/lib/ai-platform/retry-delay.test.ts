import assert from 'node:assert/strict';
import test from 'node:test';
import { AiPlatformError } from './errors';
import { parseRetryAfter, retryDelayMs, providerRetryHint, securityCooldown } from './retry-delay';

test('unknown account limits use short backoff and local rejection cannot renew it', () => {
  for (const code of ['RATE_LIMIT', 'QUOTA_EXCEEDED'] as const) {
    assert.deepEqual(securityCooldown(new AiPlatformError(code, 'busy', { detail: { quotaScope: 'account' } })),
      { seconds: 15, source: 'local_backoff' });
  }
  assert.equal(securityCooldown(new AiPlatformError('RATE_LIMIT', 'local', {
    detail: { rateLimitSource: 'local', retryAfterSeconds: 3000 },
  })), null);
  assert.deepEqual(securityCooldown(new AiPlatformError('RATE_LIMIT', 'provider', {
    detail: { retryAfterSeconds: 3070 },
  })), { seconds: 3070, source: 'provider_hint' });
  assert.equal(securityCooldown(new AiPlatformError('AUTHENTICATION_ERROR', 'invalid')), null);
  assert.equal(securityCooldown(new AiPlatformError('RATE_LIMIT', 'invalid hint', {
    detail: { retryAfterSeconds: Infinity },
  }))?.seconds, 15);
});

test('provider reset timestamps and Retry-After preserve the longest valid wait', () => {
  const now = 1_800_000_000_000;
  for (const reset of [String((now + 90_000) / 1000), String(now + 90_000), new Date(now + 90_000).toUTCString()]) {
    assert.equal(providerRetryHint(new Headers({ 'x-ratelimit-reset': reset, 'retry-after': '15' }), now).retryAfterSeconds, 90);
  }
  assert.equal(providerRetryHint(new Headers({ 'x-ratelimit-reset': 'invalid' }), now).retryAfterSeconds, undefined);
  assert.equal(providerRetryHint(new Headers({ 'x-ratelimit-reset': String(now - 1000) }), now).retryAfterSeconds, undefined);
  assert.equal(providerRetryHint(new Headers(), now).cooldownSource, 'local_backoff');
});

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
