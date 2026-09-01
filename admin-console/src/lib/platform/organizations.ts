import { query } from '@/lib/db';

export type OrganizationListItem = {
  id: string;
  name: string;
  slug: string;
  status: string;
  ownerEmail: string | null;
  memberCount: number;
  createdAt: string;
};

export async function listOrganizations(input: {
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ organizations: OrganizationListItem[]; total: number }> {
  const limit = Math.min(Math.max(input.limit || 50, 1), 100);
  const offset = Math.max(input.offset || 0, 0);
  const search = input.search?.trim().toLowerCase() || '';
  const params: unknown[] = [];
  let where = '1=1';
  if (search) {
    where += ' AND (LOWER(o.name) LIKE ? OR LOWER(o.slug) LIKE ? OR o.id LIKE ?)';
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern);
  }

  const countRows = await query<Array<{ total: number }>>(
    `SELECT COUNT(*) AS total FROM organizations o WHERE ${where}`,
    params,
  );

  const rows = await query<Array<{
    id: string;
    name: string;
    slug: string;
    status: string;
    owner_email: string | null;
    member_count: number;
    created_at: Date | string;
  }>>(
    `SELECT o.id, o.name, o.slug, o.status, u.email AS owner_email, o.created_at,
            (SELECT COUNT(*) FROM organization_memberships om WHERE om.organization_id = o.id AND om.status = 'ACTIVE') AS member_count
     FROM organizations o
     LEFT JOIN users u ON u.id = o.owner_user_id
     WHERE ${where}
     ORDER BY o.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return {
    total: Number(countRows[0]?.total || 0),
    organizations: rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      ownerEmail: row.owner_email,
      memberCount: Number(row.member_count || 0),
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}
