import 'server-only';

import { v4 as uuidv4 } from 'uuid';
import { query, withNamedLock, withTransaction, type SqlExecutor } from '@/lib/db';
import { authorizeResolved, type AuthorizationGrant, type AuthorizationResource } from './authorization';
import { sanitizeAuditMetadata } from './audit';
import {
  BUILTIN_ROLES,
  permissionsForRole,
  type OrganizationRoleKey,
  type PermissionKey,
} from './permissions';

export const ACTIVE_ORGANIZATION_COOKIE = 'deplai_active_org';

export class OrganizationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'organization_error',
  ) {
    super(message);
    this.name = 'OrganizationError';
  }
}

export type OrganizationSummary = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETED_PENDING';
  roleKey: string;
  roleName: string;
  memberId: string;
  isOwner: boolean;
  createdAt: string | Date;
};

type MembershipRow = {
  member_id: string;
  organization_id: string;
  membership_status: string;
  role_id: string;
  role_key: string;
  custom_permissions: string | null;
  organization_name: string;
  organization_slug: string;
  organization_status: string;
  owner_user_id: string;
};

type RoleAssignmentRow = {
  organization_id: string;
  scope_type: 'ORGANIZATION' | 'PROJECT' | 'ENVIRONMENT';
  scope_id: string | null;
  role_key: string;
  custom_permissions: string | null;
  principal_type: 'USER' | 'TEAM';
};

function builtinRoleId(roleKey: OrganizationRoleKey): string {
  return `builtin-${roleKey.toLowerCase().replaceAll('_', '-')}`;
}

function parsePermissionCsv(value: string | null): string[] {
  return String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

async function ensureBuiltinRoles(exec: SqlExecutor = query): Promise<void> {
  for (const [roleKey, name, description] of BUILTIN_ROLES) {
    await exec(
      `INSERT IGNORE INTO organization_roles
       (id, organization_id, role_key, name, description, is_builtin)
       VALUES (?, NULL, ?, ?, ?, 1)`,
      [builtinRoleId(roleKey), roleKey, name, description],
    );
  }
}

function personalOrganizationName(user: { name?: string; login?: string; email?: string }): string {
  const identity = String(user.name || user.login || user.email?.split('@')[0] || 'Personal').trim();
  return `${identity.slice(0, 96)} workspace`;
}

function personalOrganizationSlug(userId: string): string {
  return `personal-${userId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 24)}`;
}

export async function writeOrganizationAudit(input: {
  organizationId: string;
  actorUserId: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
  result?: 'SUCCESS' | 'DENIED' | 'FAILED';
  requestId?: string | null;
  ipAddress?: string | null;
  metadata?: unknown;
  exec?: SqlExecutor;
}): Promise<void> {
  const exec = input.exec || query;
  await exec(
    `INSERT INTO organization_audit_events
     (id, organization_id, actor_user_id, action, resource_type, resource_id,
      project_id, environment_id, result, request_id, ip_address, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(), input.organizationId, input.actorUserId, input.action.slice(0, 96),
      input.resourceType.slice(0, 64), input.resourceId || null, input.projectId || null,
      input.environmentId || null, input.result || 'SUCCESS', input.requestId || null,
      input.ipAddress || null, JSON.stringify(sanitizeAuditMetadata(input.metadata || {})),
    ],
  );
}

export async function ensurePersonalOrganization(user: {
  id: string;
  name?: string;
  login?: string;
  email?: string;
}): Promise<OrganizationSummary> {
  const existing = await listOrganizations(user.id);
  if (existing[0]) return existing[0];

  return withNamedLock(`personal-org:${user.id}`, 10, async () => {
    const afterLock = await listOrganizations(user.id);
    if (afterLock[0]) return afterLock[0];

    const organizationId = uuidv4();
    const memberId = uuidv4();
    const name = personalOrganizationName(user);
    const slug = personalOrganizationSlug(user.id);
    await withTransaction(async (exec) => {
      await ensureBuiltinRoles(exec);
      await exec(
        `INSERT INTO organizations (id, name, slug, owner_user_id, status)
         VALUES (?, ?, ?, ?, 'ACTIVE')`,
        [organizationId, name, slug, user.id],
      );
      await exec(
        `INSERT INTO organization_memberships
         (id, organization_id, user_id, role_id, status, joined_at, last_active_at)
         VALUES (?, ?, ?, ?, 'ACTIVE', NOW(), NOW())`,
        [memberId, organizationId, user.id, builtinRoleId('OWNER')],
      );
      await writeOrganizationAudit({
        organizationId,
        actorUserId: user.id,
        action: 'organization.created',
        resourceType: 'organization',
        resourceId: organizationId,
        metadata: { source: 'personal_workspace_provisioning' },
        exec,
      });
    });
    return {
      id: organizationId,
      name,
      slug,
      logoUrl: null,
      status: 'ACTIVE',
      roleKey: 'OWNER',
      roleName: 'Owner',
      memberId,
      isOwner: true,
      createdAt: new Date().toISOString(),
    };
  });
}

export async function listOrganizations(userId: string): Promise<OrganizationSummary[]> {
  const rows = await query<Array<{
    id: string;
    name: string;
    slug: string;
    logo_url: string | null;
    status: OrganizationSummary['status'];
    role_key: string;
    role_name: string;
    member_id: string;
    owner_user_id: string;
    created_at: string | Date;
  }>>(
    `SELECT o.id, o.name, o.slug, o.logo_url, o.status, r.role_key, r.name AS role_name,
            m.id AS member_id, o.owner_user_id, o.created_at
     FROM organization_memberships m
     JOIN organizations o ON o.id = m.organization_id
     JOIN organization_roles r ON r.id = m.role_id
     WHERE m.user_id = ? AND m.status = 'ACTIVE' AND o.status <> 'DELETED_PENDING'
     ORDER BY (o.owner_user_id = ?) DESC, o.name ASC`,
    [userId, userId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    logoUrl: row.logo_url,
    status: row.status,
    roleKey: row.role_key,
    roleName: row.role_name,
    memberId: row.member_id,
    isOwner: row.owner_user_id === userId,
    createdAt: row.created_at,
  }));
}

export async function resolveActiveOrganization(
  user: { id: string; name?: string; login?: string; email?: string },
  preferredOrganizationId?: string | null,
): Promise<OrganizationSummary> {
  let organizations = await listOrganizations(user.id);
  if (organizations.length === 0) {
    await ensurePersonalOrganization(user);
    organizations = await listOrganizations(user.id);
  }
  const preferred = organizations.find((organization) => organization.id === preferredOrganizationId);
  const active = preferred || organizations[0];
  if (!active) throw new OrganizationError('No active organization is available', 404, 'organization_not_found');
  return active;
}

async function membershipFor(userId: string, organizationId: string): Promise<MembershipRow | null> {
  const rows = await query<MembershipRow[]>(
    `SELECT m.id AS member_id, m.organization_id, m.status AS membership_status,
            m.role_id, r.role_key, GROUP_CONCAT(rp.permission_key) AS custom_permissions,
            o.name AS organization_name, o.slug AS organization_slug,
            o.status AS organization_status, o.owner_user_id
     FROM organization_memberships m
     JOIN organizations o ON o.id = m.organization_id
     JOIN organization_roles r ON r.id = m.role_id
     LEFT JOIN organization_role_permissions rp ON rp.role_id = r.id
     WHERE m.user_id = ? AND m.organization_id = ?
     GROUP BY m.id, m.organization_id, m.status, m.role_id, r.role_key,
              o.name, o.slug, o.status, o.owner_user_id
     LIMIT 1`,
    [userId, organizationId],
  );
  return rows[0] || null;
}

async function roleAssignmentsFor(userId: string, organizationId: string): Promise<AuthorizationGrant[]> {
  const rows = await query<RoleAssignmentRow[]>(
    `SELECT ra.organization_id, ra.scope_type, ra.scope_id, r.role_key,
            GROUP_CONCAT(DISTINCT rp.permission_key) AS custom_permissions,
            ra.principal_type
     FROM organization_role_assignments ra
     JOIN organization_roles r ON r.id = ra.role_id
     LEFT JOIN organization_role_permissions rp ON rp.role_id = r.id
     LEFT JOIN organization_team_memberships tm
       ON ra.principal_type = 'TEAM' AND tm.team_id = ra.principal_id AND tm.user_id = ?
     WHERE ra.organization_id = ?
       AND ((ra.principal_type = 'USER' AND ra.principal_id = ?)
         OR (ra.principal_type = 'TEAM' AND tm.user_id = ?))
     GROUP BY ra.id, ra.organization_id, ra.scope_type, ra.scope_id, r.role_key, ra.principal_type`,
    [userId, organizationId, userId, userId],
  );
  return rows.map((row) => ({
    organizationId: row.organization_id,
    roleKey: row.role_key,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    permissionKeys: parsePermissionCsv(row.custom_permissions),
    source: row.principal_type,
  }));
}

export async function requireOrganizationPermission(input: {
  userId: string;
  organizationId: string;
  action: PermissionKey;
  resource?: Omit<AuthorizationResource, 'organizationId'>;
}): Promise<{ membership: MembershipRow; organization: OrganizationSummary }> {
  const membership = await membershipFor(input.userId, input.organizationId);
  if (!membership || membership.membership_status !== 'ACTIVE' || membership.organization_status !== 'ACTIVE') {
    throw new OrganizationError('Organization not found', 404, 'organization_not_found');
  }
  const grants = await roleAssignmentsFor(input.userId, input.organizationId);
  const allowed = authorizeResolved({
    principalOrganizationId: membership.organization_id,
    membershipStatus: membership.membership_status,
    membershipRoleKey: membership.role_key,
    grants,
    action: input.action,
    resource: { organizationId: input.organizationId, ...(input.resource || {}) },
  });
  if (!allowed) throw new OrganizationError('Forbidden', 403, 'organization_permission_denied');
  return {
    membership,
    organization: {
      id: membership.organization_id,
      name: membership.organization_name,
      slug: membership.organization_slug,
      logoUrl: null,
      status: membership.organization_status as OrganizationSummary['status'],
      roleKey: membership.role_key,
      roleName: membership.role_key.replaceAll('_', ' '),
      memberId: membership.member_id,
      isOwner: membership.owner_user_id === input.userId,
      createdAt: '',
    },
  };
}

export async function createOrganization(input: {
  userId: string;
  name: string;
  slug: string;
}): Promise<OrganizationSummary> {
  const id = uuidv4();
  const memberId = uuidv4();
  await withTransaction(async (exec) => {
    await ensureBuiltinRoles(exec);
    await exec(
      `INSERT INTO organizations (id, name, slug, owner_user_id, status)
       VALUES (?, ?, ?, ?, 'ACTIVE')`,
      [id, input.name, input.slug, input.userId],
    );
    await exec(
      `INSERT INTO organization_memberships
       (id, organization_id, user_id, role_id, status, joined_at, last_active_at)
       VALUES (?, ?, ?, ?, 'ACTIVE', NOW(), NOW())`,
      [memberId, id, input.userId, builtinRoleId('OWNER')],
    );
    await writeOrganizationAudit({
      organizationId: id,
      actorUserId: input.userId,
      action: 'organization.created',
      resourceType: 'organization',
      resourceId: id,
      exec,
    });
  });
  return {
    id,
    name: input.name,
    slug: input.slug,
    logoUrl: null,
    status: 'ACTIVE',
    roleKey: 'OWNER',
    roleName: 'Owner',
    memberId,
    isOwner: true,
    createdAt: new Date().toISOString(),
  };
}

export async function updateOrganization(input: {
  userId: string;
  organizationId: string;
  name: string;
  slug: string;
}): Promise<void> {
  await requireOrganizationPermission({
    userId: input.userId,
    organizationId: input.organizationId,
    action: 'organization.update',
  });
  await query(
    `UPDATE organizations SET name = ?, slug = ?, updated_at = NOW()
     WHERE id = ? AND status = 'ACTIVE'`,
    [input.name, input.slug, input.organizationId],
  );
  await writeOrganizationAudit({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    action: 'organization.updated',
    resourceType: 'organization',
    resourceId: input.organizationId,
    metadata: { name: input.name, slug: input.slug },
  });
}

export async function scheduleOrganizationDeletion(userId: string, organizationId: string): Promise<void> {
  await requireOrganizationPermission({ userId, organizationId, action: 'organization.delete' });
  await query(
    `UPDATE organizations
     SET status = 'DELETED_PENDING', deleted_at = DATE_ADD(NOW(), INTERVAL 30 DAY), updated_at = NOW()
     WHERE id = ? AND owner_user_id = ?`,
    [organizationId, userId],
  );
  await writeOrganizationAudit({
    organizationId,
    actorUserId: userId,
    action: 'organization.deletion_scheduled',
    resourceType: 'organization',
    resourceId: organizationId,
  });
}

export async function requireProjectPermission(input: {
  userId: string;
  projectId: string;
  action: PermissionKey;
  environmentId?: string | null;
  environmentKind?: string | null;
}) {
  const rows = await query<Array<{
    id: string;
    name: string;
    project_type: string;
    user_id: string;
    organization_id: string | null;
  }>>(
    `SELECT id, name, project_type, user_id, organization_id FROM projects WHERE id = ? LIMIT 1`,
    [input.projectId],
  );
  const project = rows[0];
  if (!project) throw new OrganizationError('Project not found', 404, 'project_not_found');
  if (!project.organization_id) {
    if (project.user_id !== input.userId) throw new OrganizationError('Forbidden', 403, 'project_access_denied');
    return { project, organizationId: null };
  }
  await requireOrganizationPermission({
    userId: input.userId,
    organizationId: project.organization_id,
    action: input.action,
    resource: input.environmentId
      ? {
        scopeType: 'ENVIRONMENT',
        scopeId: input.environmentId,
        projectId: project.id,
        environmentKind: input.environmentKind,
      }
      : { scopeType: 'PROJECT', scopeId: project.id, projectId: project.id },
  });
  return { project, organizationId: project.organization_id };
}

export async function organizationOverview(userId: string, organizationId: string) {
  const { organization } = await requireOrganizationPermission({
    userId,
    organizationId,
    action: 'organization.read',
  });
  type OverviewMetrics = {
    member_count: number;
    team_count: number;
    project_count: number;
    deployment_count: number;
    scan_count: number;
    finding_count: number;
    cloud_account_count: number;
    ai_provider_count: number;
    plan_name: string | null;
    subscription_status: string | null;
  };
  const emptyMetrics: OverviewMetrics = {
    member_count: 0,
    team_count: 0,
    project_count: 0,
    deployment_count: 0,
    scan_count: 0,
    finding_count: 0,
    cloud_account_count: 0,
    ai_provider_count: 0,
    plan_name: null,
    subscription_status: null,
  };
  let metrics = emptyMetrics;
  try {
    const rows = await query<OverviewMetrics[]>(
      `SELECT
        (SELECT COUNT(*) FROM organization_memberships WHERE organization_id = ? AND status = 'ACTIVE') AS member_count,
        (SELECT COUNT(*) FROM organization_teams WHERE organization_id = ?) AS team_count,
        (SELECT COUNT(*) FROM projects WHERE organization_id = ?) AS project_count,
        (SELECT COUNT(*) FROM deploy_exec_deployments WHERE organization_id = ?) AS deployment_count,
        (SELECT COUNT(*) FROM dast_scans WHERE organization_id = ?) AS scan_count,
        (SELECT COALESCE(SUM(finding_count), 0) FROM dast_scans WHERE organization_id = ?) AS finding_count,
        (SELECT COUNT(*) FROM organization_cloud_accounts WHERE organization_id = ? AND status <> 'DISCONNECTED') AS cloud_account_count,
        (SELECT COUNT(*) FROM ai_provider_credentials WHERE organization_id = ? AND status <> 'REVOKED') AS ai_provider_count,
        (SELECT bp.name FROM billing_subscriptions bs JOIN billing_plans bp ON bp.id = bs.plan_id
         WHERE bs.organization_id = ? ORDER BY bs.updated_at DESC LIMIT 1) AS plan_name,
        (SELECT bs.status FROM billing_subscriptions bs WHERE bs.organization_id = ?
         ORDER BY bs.updated_at DESC LIMIT 1) AS subscription_status`,
      Array(10).fill(organizationId),
    );
    metrics = rows[0] || emptyMetrics;
  } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } }).code
      || (error as { cause?: { code?: string } }).cause?.code;
    if (code !== 'ER_NO_SUCH_TABLE' && code !== 'ER_BAD_FIELD_ERROR') throw error;
    // Optional product tables can lag the core organization schema during a rolling deploy.
    // Keep the organization usable while the migration catches those metrics up.
    console.warn('Organization overview metrics are temporarily unavailable during schema rollout', { code });
  }
  const activity = await listOrganizationAudit(userId, organizationId, { limit: 8 })
    .catch((error) => {
      if (error instanceof OrganizationError && error.status === 403) return { events: [], nextCursor: null };
      throw error;
    });
  return {
    organization,
    metrics,
    recentActivity: activity.events,
  };
}

export async function listOrganizationAudit(
  userId: string,
  organizationId: string,
  input: { limit?: number; cursor?: string | null; action?: string | null } = {},
) {
  await requireOrganizationPermission({ userId, organizationId, action: 'audit.read' });
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 30));
  const cursorDate = input.cursor ? new Date(input.cursor) : null;
  const validCursor = cursorDate && Number.isFinite(cursorDate.getTime()) ? cursorDate : null;
  const conditions = ['e.organization_id = ?'];
  const params: unknown[] = [organizationId];
  if (validCursor) {
    conditions.push('e.created_at < ?');
    params.push(validCursor);
  }
  if (input.action) {
    conditions.push('e.action = ?');
    params.push(input.action);
  }
  const queryLimit = limit + 1;
  const rows = await query<Array<{
    id: string;
    actor_user_id: string;
    actor_name: string | null;
    actor_email: string | null;
    action: string;
    resource_type: string;
    resource_id: string | null;
    result: string;
    metadata_json: unknown;
    created_at: string | Date;
  }>>(
    `SELECT e.id, e.actor_user_id, u.name AS actor_name, u.email AS actor_email,
            e.action, e.resource_type, e.resource_id, e.result, e.metadata_json, e.created_at
     FROM organization_audit_events e
     LEFT JOIN users u ON u.id = e.actor_user_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY e.created_at DESC
     LIMIT ${queryLimit}`,
    params,
  );
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit).map((row) => ({
    id: row.id,
    actor: { id: row.actor_user_id, name: row.actor_name, email: row.actor_email },
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    result: row.result,
    metadata: sanitizeAuditMetadata(row.metadata_json),
    createdAt: row.created_at,
  }));
  return {
    events: visible,
    nextCursor: hasMore ? String(visible.at(-1)?.createdAt || '') : null,
  };
}

export function roleCatalog() {
  return BUILTIN_ROLES.map(([key, name, description]) => ({
    id: builtinRoleId(key),
    key,
    name,
    description,
    isBuiltIn: true,
    permissions: permissionsForRole(key),
  }));
}
