import 'server-only';

import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '@/lib/db';
import { OrganizationError, requireOrganizationPermission, writeOrganizationAudit } from './store';

export async function listOrganizationTeams(userId: string, organizationId: string) {
  await requireOrganizationPermission({ userId, organizationId, action: 'team.read' });
  const rows = await query<Array<{
    id: string;
    name: string;
    description: string | null;
    member_count: number;
    project_count: number;
    created_at: string | Date;
    updated_at: string | Date;
  }>>(
    `SELECT t.id, t.name, t.description, t.created_at, t.updated_at,
            COUNT(DISTINCT tm.user_id) AS member_count,
            COUNT(DISTINCT CASE WHEN ra.scope_type = 'PROJECT' THEN ra.scope_id END) AS project_count
     FROM organization_teams t
     LEFT JOIN organization_team_memberships tm ON tm.team_id = t.id
     LEFT JOIN organization_role_assignments ra
       ON ra.principal_type = 'TEAM' AND ra.principal_id = t.id
     WHERE t.organization_id = ?
     GROUP BY t.id, t.name, t.description, t.created_at, t.updated_at
     ORDER BY t.name ASC`,
    [organizationId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    memberCount: Number(row.member_count || 0),
    projectCount: Number(row.project_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function createOrganizationTeam(input: {
  actorUserId: string;
  organizationId: string;
  name: string;
  description?: string | null;
}) {
  await requireOrganizationPermission({ userId: input.actorUserId, organizationId: input.organizationId, action: 'team.create' });
  const id = uuidv4();
  await query(
    `INSERT INTO organization_teams (id, organization_id, name, description, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [id, input.organizationId, input.name, input.description || null, input.actorUserId],
  );
  await writeOrganizationAudit({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'team.created',
    resourceType: 'team',
    resourceId: id,
    metadata: { name: input.name },
  });
  return { id, name: input.name, description: input.description || null, memberCount: 0, projectCount: 0 };
}

async function getTeam(organizationId: string, teamId: string) {
  const rows = await query<Array<{ id: string; name: string; description: string | null }>>(
    `SELECT id, name, description FROM organization_teams WHERE id = ? AND organization_id = ? LIMIT 1`,
    [teamId, organizationId],
  );
  if (!rows[0]) throw new OrganizationError('Team not found', 404, 'team_not_found');
  return rows[0];
}

export async function getOrganizationTeam(userId: string, organizationId: string, teamId: string) {
  await requireOrganizationPermission({ userId, organizationId, action: 'team.read' });
  const team = await getTeam(organizationId, teamId);
  const members = await query<Array<{ member_id: string; user_id: string; name: string | null; email: string; role_key: string }>>(
    `SELECT m.id AS member_id, m.user_id, u.name, u.email, r.role_key
     FROM organization_team_memberships tm
     JOIN organization_memberships m
       ON m.organization_id = ? AND m.user_id = tm.user_id AND m.status = 'ACTIVE'
     JOIN users u ON u.id = tm.user_id
     JOIN organization_roles r ON r.id = m.role_id
     WHERE tm.team_id = ? ORDER BY u.name ASC, u.email ASC`,
    [organizationId, teamId],
  );
  return {
    ...team,
    members: members.map((member) => ({
      id: member.member_id,
      userId: member.user_id,
      name: member.name,
      email: member.email,
      roleKey: member.role_key,
    })),
  };
}

export async function updateOrganizationTeam(input: {
  actorUserId: string;
  organizationId: string;
  teamId: string;
  name: string;
  description?: string | null;
}) {
  await requireOrganizationPermission({ userId: input.actorUserId, organizationId: input.organizationId, action: 'team.update' });
  await getTeam(input.organizationId, input.teamId);
  await query(
    `UPDATE organization_teams SET name = ?, description = ?, updated_at = NOW()
     WHERE id = ? AND organization_id = ?`,
    [input.name, input.description || null, input.teamId, input.organizationId],
  );
  await writeOrganizationAudit({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'team.updated',
    resourceType: 'team',
    resourceId: input.teamId,
    metadata: { name: input.name },
  });
}

export async function deleteOrganizationTeam(input: { actorUserId: string; organizationId: string; teamId: string }) {
  await requireOrganizationPermission({ userId: input.actorUserId, organizationId: input.organizationId, action: 'team.delete' });
  await getTeam(input.organizationId, input.teamId);
  await withTransaction(async (exec) => {
    await exec(`DELETE FROM organization_role_assignments WHERE organization_id = ? AND principal_type = 'TEAM' AND principal_id = ?`, [input.organizationId, input.teamId]);
    await exec(`DELETE FROM organization_teams WHERE id = ? AND organization_id = ?`, [input.teamId, input.organizationId]);
    await writeOrganizationAudit({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'team.deleted',
      resourceType: 'team',
      resourceId: input.teamId,
      exec,
    });
  });
}

export async function setOrganizationTeamMember(input: {
  actorUserId: string;
  organizationId: string;
  teamId: string;
  memberId: string;
  present: boolean;
}) {
  await requireOrganizationPermission({ userId: input.actorUserId, organizationId: input.organizationId, action: 'team.member.manage' });
  await getTeam(input.organizationId, input.teamId);
  const rows = await query<Array<{ user_id: string }>>(
    `SELECT user_id FROM organization_memberships
     WHERE id = ? AND organization_id = ? AND status = 'ACTIVE' LIMIT 1`,
    [input.memberId, input.organizationId],
  );
  if (!rows[0]) throw new OrganizationError('Active member not found', 404, 'member_not_found');
  if (input.present) {
    await query(
      `INSERT IGNORE INTO organization_team_memberships (team_id, user_id, added_by)
       VALUES (?, ?, ?)`,
      [input.teamId, rows[0].user_id, input.actorUserId],
    );
  } else {
    await query(`DELETE FROM organization_team_memberships WHERE team_id = ? AND user_id = ?`, [input.teamId, rows[0].user_id]);
  }
  await writeOrganizationAudit({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: input.present ? 'team.member_added' : 'team.member_removed',
    resourceType: 'team',
    resourceId: input.teamId,
    metadata: { memberId: input.memberId },
  });
}
