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
