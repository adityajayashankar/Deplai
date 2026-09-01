import { query } from '@/lib/db';

export async function setProjectAdminStatus(input: {
  projectId: string;
  disabled: boolean;
  reason: string;
  adminId: string;
}): Promise<void> {
  const rows = await query<Array<{ id: string }>>(
    `SELECT id FROM projects WHERE id = ? LIMIT 1`,
    [input.projectId],
  );
  if (!rows[0]) throw new Error('Project not found');

  if (input.disabled) {
    await query(
      `INSERT INTO admin_project_controls (project_id, status, reason, disabled_by_admin_id)
       VALUES (?, 'DISABLED', ?, ?)
       ON DUPLICATE KEY UPDATE status = 'DISABLED', reason = VALUES(reason),
         disabled_by_admin_id = VALUES(disabled_by_admin_id), updated_at = CURRENT_TIMESTAMP`,
      [input.projectId, input.reason.slice(0, 255), input.adminId],
    );
    return;
  }

  await query(
    `UPDATE admin_project_controls SET status = 'ACTIVE', reason = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE project_id = ?`,
    [input.projectId],
  );
}

export async function getProjectAdminStatus(projectId: string): Promise<{ disabled: boolean; reason: string | null }> {
  const rows = await query<Array<{ status: string; reason: string | null }>>(
    `SELECT status, reason FROM admin_project_controls WHERE project_id = ? LIMIT 1`,
    [projectId],
  );
  const row = rows[0];
  return { disabled: row?.status === 'DISABLED', reason: row?.reason || null };
}

export async function listProjectsWithAdminStatus(input: {
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const limit = Math.min(Math.max(input.limit || 50, 1), 100);
  const offset = Math.max(input.offset || 0, 0);
  const params: unknown[] = [];
  let where = '1=1';
  if (input.search?.trim()) {
    where += ' AND (LOWER(p.name) LIKE ? OR p.id LIKE ? OR LOWER(u.email) LIKE ?)';
    const pattern = `%${input.search.trim().toLowerCase()}%`;
    params.push(pattern, pattern, pattern);
  }

  const rows = await query<Array<{
    id: string;
    name: string;
    project_type: string;
    owner_email: string;
    organization_name: string | null;
    created_at: Date | string;
    admin_status: string | null;
  }>>(
    `SELECT p.id, p.name, p.project_type, u.email AS owner_email, o.name AS organization_name, p.created_at,
            apc.status AS admin_status
     FROM projects p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN organizations o ON o.id = p.organization_id
     LEFT JOIN admin_project_controls apc ON apc.project_id = p.id
     WHERE ${where}
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    projectType: row.project_type,
    ownerEmail: row.owner_email,
    organizationName: row.organization_name,
    disabled: row.admin_status === 'DISABLED',
    createdAt: new Date(row.created_at).toISOString(),
  }));
}
