import { query } from '@/lib/db';

export type ProjectListItem = {
  id: string;
  name: string;
  projectType: string;
  ownerEmail: string;
  organizationName: string | null;
  createdAt: string;
};

export async function listProjects(input: {
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ projects: ProjectListItem[]; total: number }> {
  const limit = Math.min(Math.max(input.limit || 50, 1), 100);
  const offset = Math.max(input.offset || 0, 0);
  const search = input.search?.trim().toLowerCase() || '';
  const params: unknown[] = [];
  let where = '1=1';
  if (search) {
    where += ' AND (LOWER(p.name) LIKE ? OR p.id LIKE ? OR LOWER(u.email) LIKE ?)';
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern);
  }

  const countRows = await query<Array<{ total: number }>>(
    `SELECT COUNT(*) AS total
     FROM projects p
     JOIN users u ON u.id = p.user_id
     WHERE ${where}`,
    params,
  );

  const rows = await query<Array<{
    id: string;
    name: string;
    project_type: string;
    owner_email: string;
    organization_name: string | null;
    created_at: Date | string;
  }>>(
    `SELECT p.id, p.name, p.project_type, u.email AS owner_email, o.name AS organization_name, p.created_at
     FROM projects p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN organizations o ON o.id = p.organization_id
     WHERE ${where}
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return {
    total: Number(countRows[0]?.total || 0),
    projects: rows.map((row) => ({
      id: row.id,
      name: row.name,
      projectType: row.project_type,
      ownerEmail: row.owner_email,
      organizationName: row.organization_name,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}
