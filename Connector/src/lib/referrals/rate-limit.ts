type RateBucket = { count: number; resetAt: number };

type GlobalReferralRateLimit = typeof globalThis & {
  __deplaiReferralRateLimits?: Map<string, RateBucket>;
};

const globalForReferrals = globalThis as GlobalReferralRateLimit;

function buckets(): Map<string, RateBucket> {
  if (!globalForReferrals.__deplaiReferralRateLimits) {
    globalForReferrals.__deplaiReferralRateLimits = new Map();
  }
  return globalForReferrals.__deplaiReferralRateLimits;
}

export type ReferralRateLimitAction = 'validate' | 'capture' | 'attribute';

export function takeReferralRateLimit(input: {
  key: string;
  action: ReferralRateLimitAction;
  limit?: number;
  windowMs?: number;
  now?: number;
}): { allowed: boolean; retryAfterSeconds: number } {
  const now = input.now ?? Date.now();
  const limit = Math.max(1, input.limit ?? defaultLimit(input.action));
  const windowMs = Math.max(1_000, input.windowMs ?? 60_000);
  const bucketKey = `${input.action}:${input.key}`;
  const store = buckets();
  const current = store.get(bucketKey);
  if (!current || current.resetAt <= now) {
    store.set(bucketKey, { count: 1, resetAt: now + windowMs });
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

function defaultLimit(action: ReferralRateLimitAction): number {
  switch (action) {
    case 'validate': return 30;
    case 'capture': return 20;
    case 'attribute': return 10;
    default: return 20;
  }
}

export function clientRateLimitKey(request: Request, userId?: string | null): string {
  if (userId) return `user:${userId}`;
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = request.headers.get('x-real-ip')?.trim();
  return `ip:${forwarded || realIp || 'unknown'}`;
}
