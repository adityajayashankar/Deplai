import { query } from '@/lib/db';
import { getOrganizationCreditBalance } from '@/lib/platform/credits';

export type OrganizationDetail = {
  id: string;
  name: string;
  slug: string;
  status: string;
  ownerEmail: string | null;
  ownerUserId: string;
  memberCount: number;
  projectCount: number;
  createdAt: string;
  credits: {
    available: number;
    reserved: number;
    balance: number;
    status: string;
  } | null;
  subscription: {
    planId: string;
    planName: string | null;
    status: string;
    cadence: string | null;
    userEmail: string | null;
  } | null;
};

export async function getOrganizationDetail(organizationId: string): Promise<OrganizationDetail | null> {
  const rows = await query<Array<{
    id: string;
    name: string;
    slug: string;
    status: string;
    owner_user_id: string;
    owner_email: string | null;
    created_at: Date | string;
  }>>(
    `SELECT o.id, o.name, o.slug, o.status, o.owner_user_id, u.email AS owner_email, o.created_at
     FROM organizations o
     LEFT JOIN users u ON u.id = o.owner_user_id
     WHERE o.id = ? LIMIT 1`,
    [organizationId],
  );
  const org = rows[0];
  if (!org) return null;

  const [memberCount, projectCount, subRows] = await Promise.all([
    query<Array<{ count: number }>>(
      `SELECT COUNT(*) AS count FROM organization_memberships WHERE organization_id = ? AND status = 'ACTIVE'`,
      [organizationId],
    ),
    query<Array<{ count: number }>>(
      `SELECT COUNT(*) AS count FROM projects WHERE organization_id = ?`,
      [organizationId],
    ),
    query<Array<{
      plan_id: string;
      status: string;
      billing_cadence: string | null;
      user_email: string | null;
      display_name: string | null;
    }>>(
      `SELECT bs.plan_id, bs.status, bs.billing_cadence, u.email AS user_email, bp.display_name
       FROM billing_subscriptions bs
       LEFT JOIN users u ON u.id = bs.user_id
       LEFT JOIN billing_plans bp ON bp.id = bs.plan_id
       WHERE bs.organization_id = ?
       ORDER BY bs.updated_at DESC LIMIT 1`,
      [organizationId],
    ),
  ]);

  let credits: OrganizationDetail['credits'] = null;
  try {
    const balance = await getOrganizationCreditBalance(organizationId);
    credits = {
      available: Number(balance.availableUnits) / 1_000_000,
      reserved: Number(balance.reservedUnits) / 1_000_000,
      balance: Number(balance.balanceUnits) / 1_000_000,
      status: balance.status,
    };
  } catch {
    credits = null;
  }

  const sub = subRows[0];
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    status: org.status,
    ownerEmail: org.owner_email,
    ownerUserId: org.owner_user_id,
    memberCount: Number(memberCount[0]?.count || 0),
    projectCount: Number(projectCount[0]?.count || 0),
    createdAt: new Date(org.created_at).toISOString(),
    credits,
    subscription: sub
      ? {
          planId: sub.plan_id,
          planName: sub.display_name,
          status: sub.status,
          cadence: sub.billing_cadence,
          userEmail: sub.user_email,
        }
      : null,
  };
}

export async function setOrganizationStatus(
  organizationId: string,
  status: 'ACTIVE' | 'SUSPENDED',
): Promise<void> {
  const rows = await query<Array<{ id: string }>>(
    `SELECT id FROM organizations WHERE id = ? LIMIT 1`,
    [organizationId],
  );
  if (!rows[0]) throw new Error('Organization not found');
  await query(`UPDATE organizations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [status, organizationId]);
}

export async function resolveOrganizationId(input: {
  organizationId?: string;
  userId?: string;
}): Promise<string> {
  if (input.organizationId) return input.organizationId;
  if (!input.userId) throw new Error('organizationId or userId is required');

  const memberRows = await query<Array<{ organization_id: string }>>(
    `SELECT organization_id FROM organization_memberships
     WHERE user_id = ? AND status = 'ACTIVE'
     ORDER BY joined_at ASC LIMIT 1`,
    [input.userId],
  );
  if (memberRows[0]) return memberRows[0].organization_id;

  const owned = await query<Array<{ id: string }>>(
    `SELECT id FROM organizations WHERE owner_user_id = ? AND status <> 'DELETED_PENDING' ORDER BY created_at ASC LIMIT 1`,
    [input.userId],
  );
  if (owned[0]) return owned[0].id;
  throw new Error('No active organization found for user');
}
