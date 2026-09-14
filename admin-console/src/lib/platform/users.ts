import { query } from '@/lib/db';

export type UserListItem = {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  organizationCount: number;
  projectCount: number;
  planName: string | null;
  subscriptionStatus: string | null;
};

export type UserDetail = {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  authentication: {
    passwordConfigured: boolean;
    mfaEnabled: boolean;
    provider: string;
  };
  organizations: Array<{ id: string; name: string; role: string; status: string }>;
  projectCount: number;
  apiKey: { configured: boolean; prefix: string | null; lastUsedAt: string | null } | null;
};

export async function listUsers(input: {
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ users: UserListItem[]; total: number }> {
  const limit = Number.isFinite(input.limit) ? Math.min(Math.max(Math.floor(input.limit!), 1), 100) : 50;
  const offset = Number.isFinite(input.offset) ? Math.min(Math.max(Math.floor(input.offset!), 0), 1_000_000_000) : 0;
  const search = input.search?.trim().toLowerCase() || '';
  const params: unknown[] = [];
  let where = '1=1';
  if (search) {
    where += ' AND (LOWER(u.email) LIKE ? OR LOWER(u.name) LIKE ? OR u.id LIKE ?)';
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern);
  }

  const countRows = await query<Array<{ total: number }>>(
    `SELECT COUNT(*) AS total FROM users u WHERE ${where}`,
    params,
  );

  const rows = await query<Array<{
    id: string;
    email: string;
    name: string | null;
    created_at: Date | string;
    organization_count: number;
    project_count: number;
    plan_name: string | null;
    subscription_status: string | null;
  }>>(
    `SELECT u.id, u.email, u.name, u.created_at,
            (SELECT COUNT(*) FROM organization_memberships om WHERE om.user_id = u.id AND om.status = 'ACTIVE') AS organization_count,
            (SELECT COUNT(*) FROM projects p WHERE p.user_id = u.id) AS project_count,
            bp.display_name AS plan_name,
            bs.status AS subscription_status
     FROM users u
     LEFT JOIN billing_subscriptions bs ON bs.user_id = u.id
     LEFT JOIN billing_plans bp ON bp.id = bs.plan_id
     WHERE ${where}
     ORDER BY u.created_at DESC, u.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return {
    total: Number(countRows[0]?.total || 0),
    users: rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      createdAt: new Date(row.created_at).toISOString(),
      organizationCount: Number(row.organization_count || 0),
      projectCount: Number(row.project_count || 0),
      planName: row.plan_name,
      subscriptionStatus: row.subscription_status,
    })),
  };
}

export async function getUserDetail(userId: string): Promise<UserDetail | null> {
  const users = await query<Array<{ id: string; email: string; name: string | null; created_at: Date | string }>>(
    `SELECT id, email, name, created_at FROM users WHERE id = ? LIMIT 1`,
    [userId],
  );
  const user = users[0];
  if (!user) return null;

  const orgRows = await query<Array<{ id: string; name: string; role_key: string; status: string }>>(
    `SELECT o.id, o.name, r.role_key, om.status
     FROM organization_memberships om
     JOIN organizations o ON o.id = om.organization_id
     JOIN organization_roles r ON r.id = om.role_id
     WHERE om.user_id = ?
     ORDER BY o.name ASC`,
    [userId],
  );

  const projectCountRows = await query<Array<{ count: number }>>(
    `SELECT COUNT(*) AS count FROM projects WHERE user_id = ?`,
    [userId],
  );

  const apiKeyRows = await query<Array<{ token_prefix: string; last_used_at: Date | string | null }>>(
    `SELECT token_prefix, last_used_at FROM user_api_tokens WHERE user_id = ? LIMIT 1`,
    [userId],
  );

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: new Date(user.created_at).toISOString(),
    authentication: {
      passwordConfigured: false,
      mfaEnabled: false,
      provider: 'github',
    },
    organizations: orgRows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role_key,
      status: row.status,
    })),
    projectCount: Number(projectCountRows[0]?.count || 0),
    apiKey: apiKeyRows[0]
      ? {
          configured: true,
          prefix: apiKeyRows[0].token_prefix,
          lastUsedAt: apiKeyRows[0].last_used_at ? new Date(apiKeyRows[0].last_used_at).toISOString() : null,
        }
      : { configured: false, prefix: null, lastUsedAt: null },
  };
}

export async function revokeUserSessions(userId: string): Promise<number> {
  const result = await query<{ affectedRows?: number }>(
    `UPDATE workspace_sessions SET status = 'revoked', completed_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND status = 'running'`,
    [userId],
  );
  return Number((result as { affectedRows?: number }).affectedRows || 0);
}
