import type { AiPlatformError } from './errors';

// A single gateway call may wait at most 65 seconds across all retries.
// Quota/billing failures need user action; retrying those cannot help.
export function retryDelayMs(error: AiPlatformError, attempt: number, waitedMs: number): number | null {
  if (!error.retryable || attempt >= 2) return null;
  const retryAfter = Number(error.detail?.retryAfterSeconds);
  const delay = error.code === 'RATE_LIMIT'
    ? (Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter * 1000) + 100 : 15_000 * (attempt + 1))
    : Math.min(2000, 250 * 2 ** attempt);
  return delay + waitedMs <= 65_000 ? delay : null;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const result = Number.isFinite(seconds) ? seconds : (Date.parse(value) - now) / 1000;
  return Number.isFinite(result) && result > 0 ? Math.ceil(result) : undefined;
}

export function providerRetryHint(headers: Headers, now = Date.now()) {
  const retry = parseRetryAfter(headers.get('retry-after'), now);
  const rawReset = headers.get('x-ratelimit-reset');
  const numeric = rawReset ? Number(rawReset) : NaN;
  const resetMs = Number.isFinite(numeric)
    ? (numeric >= 1e12 ? numeric : numeric * 1000)
    : Date.parse(rawReset || '');
  const reset = Number.isFinite(resetMs) && resetMs > now ? Math.ceil((resetMs - now) / 1000) : undefined;
  return {
    retryAfterSeconds: retry || reset ? Math.max(retry || 0, reset || 0) : undefined,
    cooldownSource: retry || reset ? 'provider_hint' : 'local_backoff',
    rateLimitSource: 'provider',
  };
}

export function securityCooldown(error: AiPlatformError) {
  // Reservation failures must never refresh the cooldown that produced them.
  if (error.detail?.rateLimitSource === 'local' || !['RATE_LIMIT', 'QUOTA_EXCEEDED'].includes(error.code)) return null;
  const hint = Number(error.detail?.retryAfterSeconds);
  const validHint = Number.isFinite(hint) && hint > 0;
  return { seconds: validHint ? Math.ceil(hint) : 15,
    source: validHint ? 'provider_hint' : 'local_backoff' };
}
