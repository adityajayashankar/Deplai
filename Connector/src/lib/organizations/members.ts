import 'server-only';

import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '@/lib/db';
import { createInvitationToken, evaluateInvitation, hashInvitationToken } from './invitations';
import {
  OrganizationError,
  requireOrganizationPermission,
  writeOrganizationAudit,
} from './store';
import { ORGANIZATION_ROLE_KEYS, type OrganizationRoleKey } from './permissions';

function roleId(roleKey: OrganizationRoleKey): string {
  return `builtin-${roleKey.toLowerCase().replaceAll('_', '-')}`;
}

function normalizeRoleKey(value: string): OrganizationRoleKey {
  const normalized = String(value || '').trim().toUpperCase() as OrganizationRoleKey;
  if (!ORGANIZATION_ROLE_KEYS.includes(normalized) || normalized === 'OWNER') {
    throw new OrganizationError('A valid non-owner role is required', 400, 'invalid_role');
  }
  return normalized;
}

export async function listOrganizationMembers(userId: string, organizationId: string) {
  await requireOrganizationPermission({ userId, organizationId, action: 'member.read' });
  const rows = await query<Array<{
    id: string;
    user_id: string;
    name: string | null;
    email: string;
    status: string;
    role_key: string;
    role_name: string;
    joined_at: string | Date | null;
    last_active_at: string | Date | null;
    team_count: number;
  }>>(
    `SELECT m.id, m.user_id, u.name, u.email, m.status,
            r.role_key, r.name AS role_name, m.joined_at, m.last_active_at,
            COUNT(DISTINCT tm.team_id) AS team_count
     FROM organization_memberships m
     JOIN users u ON u.id = m.user_id
     JOIN organization_roles r ON r.id = m.role_id
     LEFT JOIN organization_team_memberships tm ON tm.user_id = m.user_id
     WHERE m.organization_id = ? AND m.status <> 'REMOVED'
     GROUP BY m.id, m.user_id, u.name, u.email, m.status,
              r.role_key, r.name, m.joined_at, m.last_active_at
     ORDER BY (r.role_key = 'OWNER') DESC, u.name ASC, u.email ASC`,
    [organizationId],
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    avatarUrl: null,
    status: row.status,
    role: { key: row.role_key, name: row.role_name },
    joinedAt: row.joined_at,
    lastActiveAt: row.last_active_at,
    teamCount: Number(row.team_count || 0),
  }));
}

export async function updateOrganizationMember(input: {
  actorUserId: string;
  organizationId: string;
  memberId: string;
  roleKey?: string;
  status?: 'ACTIVE' | 'SUSPENDED';
}) {
  await requireOrganizationPermission({
    userId: input.actorUserId,
    organizationId: input.organizationId,
    action: input.roleKey ? 'member.role.update' : 'member.remove',
  });
  const rows = await query<Array<{ user_id: string; role_key: string; status: string }>>(
    `SELECT m.user_id, r.role_key, m.status
     FROM organization_memberships m JOIN organization_roles r ON r.id = m.role_id
     WHERE m.id = ? AND m.organization_id = ? LIMIT 1`,
    [input.memberId, input.organizationId],
  );
  const member = rows[0];
  if (!member) throw new OrganizationError('Member not found', 404, 'member_not_found');
  if (member.role_key === 'OWNER') {
    throw new OrganizationError('Transfer ownership before changing or suspending the owner', 409, 'owner_protected');
  }
  if (member.user_id === input.actorUserId && input.status === 'SUSPENDED') {
    throw new OrganizationError('You cannot suspend your own membership', 409, 'self_suspend_denied');
  }
  const nextRole = input.roleKey ? normalizeRoleKey(input.roleKey) : null;
  const nextStatus = input.status && ['ACTIVE', 'SUSPENDED'].includes(input.status) ? input.status : null;
  if (!nextRole && !nextStatus) throw new OrganizationError('No member change was provided');
  await query(
    `UPDATE organization_memberships
     SET role_id = COALESCE(?, role_id), status = COALESCE(?, status), updated_at = NOW()
     WHERE id = ? AND organization_id = ?`,
    [nextRole ? roleId(nextRole) : null, nextStatus, input.memberId, input.organizationId],
  );
  await writeOrganizationAudit({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: nextRole ? 'member.role_changed' : nextStatus === 'SUSPENDED' ? 'member.suspended' : 'member.reactivated',
    resourceType: 'membership',
    resourceId: input.memberId,
    metadata: { fromRole: member.role_key, toRole: nextRole, fromStatus: member.status, toStatus: nextStatus },
  });
}

export async function removeOrganizationMember(input: {
  actorUserId: string;
  organizationId: string;
  memberId: string;
}) {
  await requireOrganizationPermission({
    userId: input.actorUserId,
    organizationId: input.organizationId,
    action: 'member.remove',
  });
  const rows = await query<Array<{ user_id: string; role_key: string }>>(
    `SELECT m.user_id, r.role_key
     FROM organization_memberships m JOIN organization_roles r ON r.id = m.role_id
     WHERE m.id = ? AND m.organization_id = ? LIMIT 1`,
    [input.memberId, input.organizationId],
  );
  const member = rows[0];
  if (!member) throw new OrganizationError('Member not found', 404, 'member_not_found');
  if (member.role_key === 'OWNER') throw new OrganizationError('The owner cannot be removed', 409, 'owner_protected');
  if (member.user_id === input.actorUserId) throw new OrganizationError('Use Leave organization for your own membership', 409, 'self_remove_denied');
  await withTransaction(async (exec) => {
    await exec(
      `DELETE tm FROM organization_team_memberships tm
       JOIN organization_teams t ON t.id = tm.team_id
       WHERE t.organization_id = ? AND tm.user_id = ?`,
      [input.organizationId, member.user_id],
    );
    await exec(
      `UPDATE organization_memberships SET status = 'REMOVED', updated_at = NOW()
       WHERE id = ? AND organization_id = ?`,
      [input.memberId, input.organizationId],
    );
    await writeOrganizationAudit({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'member.removed',
      resourceType: 'membership',
      resourceId: input.memberId,
      exec,
    });
  });
}

export async function listOrganizationInvitations(userId: string, organizationId: string) {
  await requireOrganizationPermission({ userId, organizationId, action: 'member.read' });
  const rows = await query<Array<{
    id: string;
    email: string;
    role_key: string;
    role_name: string;
    inviter_name: string | null;
    expires_at: string | Date;
    accepted_at: string | Date | null;
    revoked_at: string | Date | null;
    created_at: string | Date;
  }>>(
    `SELECT i.id, i.email, r.role_key, r.name AS role_name, u.name AS inviter_name,
            i.expires_at, i.accepted_at, i.revoked_at, i.created_at
     FROM organization_invitations i
     JOIN organization_roles r ON r.id = i.role_id
     LEFT JOIN users u ON u.id = i.invited_by_user_id
     WHERE i.organization_id = ?
     ORDER BY i.created_at DESC LIMIT 100`,
    [organizationId],
  );
  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: { key: row.role_key, name: row.role_name },
    invitedBy: row.inviter_name,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    status: row.revoked_at
      ? 'REVOKED'
      : row.accepted_at
        ? 'ACCEPTED'
        : new Date(row.expires_at).getTime() <= now
          ? 'EXPIRED'
          : 'PENDING',
  }));
}

export async function createOrganizationInvitation(input: {
  actorUserId: string;
  organizationId: string;
  email: string;
  roleKey: string;
}) {
  await requireOrganizationPermission({
    userId: input.actorUserId,
    organizationId: input.organizationId,
    action: 'member.invite',
  });
  const normalizedEmail = input.email.trim().toLowerCase();
  const normalizedRole = normalizeRoleKey(input.roleKey);
  const existing = await query<Array<{ id: string }>>(
    `SELECT m.id
     FROM organization_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = ? AND LOWER(u.email) = ? AND m.status = 'ACTIVE' LIMIT 1`,
    [input.organizationId, normalizedEmail],
  );
  if (existing[0]) throw new OrganizationError('This person is already an active member', 409, 'duplicate_member');
  const pending = await query<Array<{ id: string }>>(
    `SELECT id FROM organization_invitations
     WHERE organization_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL
       AND expires_at > NOW() LIMIT 1`,
    [input.organizationId, normalizedEmail],
  );
  if (pending[0]) throw new OrganizationError('A pending invitation already exists', 409, 'invitation_exists');

  const id = uuidv4();
  const { token, tokenHash } = createInvitationToken();
  await query(
    `INSERT INTO organization_invitations
     (id, organization_id, email, invited_by_user_id, role_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))`,
    [id, input.organizationId, normalizedEmail, input.actorUserId, roleId(normalizedRole), tokenHash],
  );
  await writeOrganizationAudit({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'member.invited',
    resourceType: 'invitation',
    resourceId: id,
    metadata: { email: normalizedEmail, role: normalizedRole },
  });
  return { id, token, expiresInSeconds: 7 * 24 * 60 * 60 };
}

export async function revokeOrganizationInvitation(input: {
  actorUserId: string;
  organizationId: string;
  invitationId: string;
}) {
  await requireOrganizationPermission({
    userId: input.actorUserId,
    organizationId: input.organizationId,
    action: 'member.invite',
  });
  const result = await query<{ affectedRows: number }>(
    `UPDATE organization_invitations SET revoked_at = NOW(), updated_at = NOW()
     WHERE id = ? AND organization_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
    [input.invitationId, input.organizationId],
  );
  if (!result.affectedRows) throw new OrganizationError('Pending invitation not found', 404, 'invitation_not_found');
  await writeOrganizationAudit({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'member.invitation_revoked',
    resourceType: 'invitation',
    resourceId: input.invitationId,
  });
}

export async function resendOrganizationInvitation(input: {
  actorUserId: string;
  organizationId: string;
  invitationId: string;
}) {
  await requireOrganizationPermission({
    userId: input.actorUserId,
    organizationId: input.organizationId,
    action: 'member.invite',
  });
  const { token, tokenHash } = createInvitationToken();
  const result = await query<{ affectedRows: number }>(
    `UPDATE organization_invitations
     SET token_hash = ?, expires_at = DATE_ADD(NOW(), INTERVAL 7 DAY), updated_at = NOW()
     WHERE id = ? AND organization_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
    [tokenHash, input.invitationId, input.organizationId],
  );
  if (!result.affectedRows) throw new OrganizationError('Pending invitation not found', 404, 'invitation_not_found');
  await writeOrganizationAudit({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'member.invitation_resent',
    resourceType: 'invitation',
    resourceId: input.invitationId,
  });
  return { token, expiresInSeconds: 7 * 24 * 60 * 60 };
}

export async function acceptOrganizationInvitation(input: {
  userId: string;
  userEmail: string;
  token: string;
}) {
  const tokenHash = hashInvitationToken(input.token);
  return withTransaction(async (exec) => {
    const rows = await exec<Array<{
      id: string;
      organization_id: string;
      email: string;
      role_id: string;
      token_hash: string;
      expires_at: string | Date;
      accepted_at: string | Date | null;
      revoked_at: string | Date | null;
    }>>(
      `SELECT id, organization_id, email, role_id, token_hash, expires_at, accepted_at, revoked_at
       FROM organization_invitations WHERE token_hash = ? LIMIT 1 FOR UPDATE`,
      [tokenHash],
    );
    const invitation = rows[0];
    if (!invitation) throw new OrganizationError('Invitation is invalid or expired', 404, 'invitation_not_found');
    const decision = evaluateInvitation({
      token: input.token,
      tokenHash: invitation.token_hash,
      invitedEmail: invitation.email,
      acceptingEmail: input.userEmail,
      expiresAt: invitation.expires_at,
      acceptedAt: invitation.accepted_at,
      revokedAt: invitation.revoked_at,
    });
    if (decision !== 'VALID') {
      const status = decision === 'WRONG_EMAIL' ? 403 : decision === 'TAMPERED' ? 404 : 409;
      throw new OrganizationError('Invitation is invalid or no longer available', status, `invitation_${decision.toLowerCase()}`);
    }
    const existing = await exec<Array<{ id: string; status: string }>>(
      `SELECT id, status FROM organization_memberships
       WHERE organization_id = ? AND user_id = ? LIMIT 1 FOR UPDATE`,
      [invitation.organization_id, input.userId],
    );
    if (existing[0]?.status === 'ACTIVE') throw new OrganizationError('You are already a member', 409, 'duplicate_member');
    if (existing[0]) {
      await exec(
        `UPDATE organization_memberships
         SET role_id = ?, status = 'ACTIVE', joined_at = NOW(), updated_at = NOW()
         WHERE id = ?`,
        [invitation.role_id, existing[0].id],
      );
    } else {
      await exec(
        `INSERT INTO organization_memberships
         (id, organization_id, user_id, role_id, status, joined_at, invited_by)
         VALUES (?, ?, ?, ?, 'ACTIVE', NOW(),
           (SELECT invited_by_user_id FROM organization_invitations WHERE id = ?))`,
        [uuidv4(), invitation.organization_id, input.userId, invitation.role_id, invitation.id],
      );
    }
    await exec(
      `UPDATE organization_invitations SET accepted_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [invitation.id],
    );
    await writeOrganizationAudit({
      organizationId: invitation.organization_id,
      actorUserId: input.userId,
      action: 'member.joined',
      resourceType: 'membership',
      resourceId: input.userId,
      exec,
    });
    return { organizationId: invitation.organization_id };
  });
}
