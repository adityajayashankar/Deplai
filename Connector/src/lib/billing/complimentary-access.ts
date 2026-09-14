import { query } from '@/lib/db';

// Separate from paid subscriptions: provider webhooks cannot overwrite owner grants.
export async function getComplimentaryAccess(organizationId: string, exec: typeof query = query) {
  try {
    const rows = await exec<Array<{ plan_id: string }>>(`SELECT plan_id FROM admin_plan_grants
      WHERE organization_id = ? AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`, [organizationId]);
    if (!rows[0] || !['free', 'starter_20', 'pro_50'].includes(rows[0].plan_id)) return null;
    return { planId: rows[0].plan_id, status: 'active', cadence: 'complimentary',
      razorpayCustomerId: null, razorpaySubscriptionId: null };
  } catch (error) {
    // Rollout compatible until the private admin migration has been applied.
    if ((error as { code?: string }).code === 'ER_NO_SUCH_TABLE') return null;
    throw error;
  }
}
