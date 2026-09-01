type RateBucket = { count: number; resetAt: number };

type GlobalBillingRateLimit = typeof globalThis & {
  __deplaiBillingRateLimits?: Map<string, RateBucket>;
};

const globalForBilling = globalThis as GlobalBillingRateLimit;

function buckets(): Map<string, RateBucket> {
  if (!globalForBilling.__deplaiBillingRateLimits) {
    globalForBilling.__deplaiBillingRateLimits = new Map();
  }
  return globalForBilling.__deplaiBillingRateLimits;
}

export function takeBillingRateLimit(input: {
  userId: string;
  action: 'create_order' | 'verify_payment';
  limit?: number;
  windowMs?: number;
  now?: number;
}): { allowed: boolean; retryAfterSeconds: number } {
  const now = input.now ?? Date.now();
  const limit = Math.max(1, input.limit ?? 10);
  const windowMs = Math.max(1_000, input.windowMs ?? 60_000);
  const key = `${input.action}:${input.userId}`;
  const store = buckets();
  const current = store.get(key);
  if (!current || current.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (current.count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }
  current.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}
