export function validateGrant(planId: unknown, expiresAt: unknown, now = Date.now()) {
  if (!['free', 'starter_20', 'pro_50'].includes(String(planId))) throw new Error('Choose Free, Starter or Pro');
  const expiry = expiresAt ? new Date(String(expiresAt)) : null;
  if (expiry && (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now)) throw new Error('Expiry must be a future date');
  return { planId: String(planId), expiresAt: expiry };
}
