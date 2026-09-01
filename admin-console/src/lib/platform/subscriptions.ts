import { query } from '@/lib/db';
import { BILLING_PLANS } from '@/lib/platform/credit-catalog';

export async function getSubscriptionForOrganization(organizationId: string) {
  const rows = await query<Array<{
    id: string;
    user_id: string;
    plan_id: string;
    status: string;
    billing_cadence: string | null;
  }>>(
    `SELECT id, user_id, plan_id, status, billing_cadence
     FROM billing_subscriptions
     WHERE organization_id = ?
     ORDER BY updated_at DESC LIMIT 1`,
    [organizationId],
  );
  return rows[0] || null;
}

export async function updateOrganizationSubscription(input: {
  organizationId: string;
  planId?: string;
  status?: string;
  cadence?: 'monthly' | 'yearly';
}): Promise<void> {
  const sub = await getSubscriptionForOrganization(input.organizationId);
  if (!sub) throw new Error('No subscription found for organization');

  if (input.planId) {
    const allowed = BILLING_PLANS.some((plan) => plan.id === input.planId);
    if (!allowed) throw new Error('Unsupported plan id');
  }

  await query(
    `UPDATE billing_subscriptions
     SET plan_id = COALESCE(?, plan_id),
         status = COALESCE(?, status),
         billing_cadence = COALESCE(?, billing_cadence),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [input.planId || null, input.status || null, input.cadence || null, sub.id],
  );
}

export async function cancelOrganizationSubscription(organizationId: string): Promise<void> {
  const sub = await getSubscriptionForOrganization(organizationId);
  if (!sub) throw new Error('No subscription found for organization');
  await query(
    `UPDATE billing_subscriptions
     SET status = 'cancelled', plan_id = 'free', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [sub.id],
  );
}
