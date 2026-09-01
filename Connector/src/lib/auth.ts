import { getIronSession } from 'iron-session';
import { cookies, headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { getSessionOptions, SessionData } from './session';
import { query } from './db';
import { OrganizationError, requireOrganizationPermission, requireProjectPermission } from './organizations/store';
import { resolveUserFromApiToken } from './profile/store';

type ProjectAccessRow = {
  id: string;
  name?: string;
  full_name?: string;
  project_type?: string;
  user_id: string;
  organization_id: string | null;
};

type InstallationAccessRow = {
  id: string;
  user_id: string | null;
  organization_id: string | null;
};

type RepositoryAccessRow = {
  installation_id: string;
  installation_uuid?: string;
  suspended_at: string | Date | null;
  project_id?: string;
  organization_id?: string | null;
};

function organizationAccessError(error: unknown): NextResponse {
  if (error instanceof OrganizationError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

function adminEmailSet(): Set<string> {
  const raw = [process.env.ADMIN_EMAILS, process.env.ADMIN_EMAIL]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join(',');

  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isAdminUser(user: SessionData['user'] | null | undefined): boolean {
  if (!user?.email) return false;
  const allowed = adminEmailSet();
  if (allowed.size === 0) return false;
  return allowed.has(user.email.trim().toLowerCase());
}

function normalizeSecret(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeSecretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function matchesConfiguredAdminUnlockKey(providedSecret?: string | null): boolean {
  const key = normalizeSecret(providedSecret);
  if (!key) return false;

  const adminKey = normalizeSecret(process.env.ADMIN_ACCESS_KEY);
  return Boolean(adminKey) && safeSecretEquals(key, adminKey);
}

export async function hasWorkspaceAdminAccess(
  user: SessionData['user'] | null | undefined,
  providedSecret?: string | null
): Promise<boolean> {
  if (isAdminUser(user)) return true;

  if (matchesConfiguredAdminUnlockKey(providedSecret)) {
    return true;
  }

  const key = normalizeSecret(providedSecret);
  if (!key) return false;

  // Allow workspace unlock with a platform-generated key saved in workspace settings.
  try {
    const rows = await query<Array<{ user_id: string }>>(
      `SELECT user_id
       FROM user_settings
       WHERE JSON_UNQUOTE(JSON_EXTRACT(data_json, '$.workspace.serviceKey')) = ?
       LIMIT 1`,
      [key]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function getAuthenticatedUser() {
  const cookieStore = await cookies();
  const session = await getIronSession<SessionData>(cookieStore, getSessionOptions());

  if (!session.isLoggedIn || !session.user) {
    return null;
  }

  await reconcileSessionUserRecord(session);

  return session.user;
}

async function reconcileSessionUserRecord(session: SessionData & { save: () => Promise<void> }) {
  const sessionUser = session.user;
  if (!sessionUser) return;

  const normalizedEmail = String(sessionUser.email || '').trim().toLowerCase();
  if (!normalizedEmail) return;

  try {
    const existing = await query<Array<{ id: string }>>(
      `SELECT id FROM users WHERE email = ? LIMIT 1`,
      [normalizedEmail]
    );

    if (existing[0]) {
      if (existing[0].id !== sessionUser.id) {
        session.user = { ...sessionUser, id: existing[0].id };
        await session.save();
      }
      return;
    }

    await query(
      `INSERT INTO users (id, email, name)
       VALUES (?, ?, ?)`,
      [
        sessionUser.id,
        normalizedEmail,
        String(sessionUser.name || sessionUser.login || 'GitHub User').trim(),
      ]
    );
    try {
      const { ensureUserBilling } = await import('@/lib/billing/credits');
      await ensureUserBilling(sessionUser.id);
    } catch (billingError) {
      console.warn('Failed to provision free-tier credits during user reconcile:', billingError);
    }
  } catch (error) {
    // Keep auth non-blocking if reconciliation fails; downstream handlers can surface DB issues.
    console.warn('Failed to reconcile authenticated user record:', error);
  }
}

export async function requireAuth(): Promise<
  { user: SessionData['user'] & {}; error?: never } | { user?: never; error: NextResponse }
> {
  const sessionUser = await getAuthenticatedUser();
  if (sessionUser) {
    return { user: sessionUser };
  }

  try {
    const headerStore = await headers();
    const bearer = headerStore.get('authorization')?.replace(/^Bearer\s+/i, '').trim() || '';
    const apiKey = headerStore.get('x-api-key')?.trim() || '';
    const candidate = bearer.startsWith('dpl_live_') ? bearer : apiKey.startsWith('dpl_live_') ? apiKey : '';
    if (candidate) {
      const apiUser = await resolveUserFromApiToken(candidate, headerStore.get('user-agent'));
      if (apiUser) {
        const login = apiUser.login || apiUser.email.split('@')[0] || 'api-user';
        return {
          user: {
            id: apiUser.id,
            githubId: 0,
            login,
            email: apiUser.email,
            name: apiUser.name,
            avatarUrl: apiUser.avatarUrl || '',
          },
        };
      }
    }
  } catch {
    /* headers() is unavailable outside a request context */
  }

  return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
}

export function requireServiceKey(request: Request): NextResponse | null {
  const configured = normalizeSecret(process.env.DEPLAI_SERVICE_KEY);
  if (!configured) {
    return NextResponse.json({ error: 'Service key not configured' }, { status: 503 });
  }

  const provided = normalizeSecret(
    request.headers.get('x-deplai-service-key')
    || request.headers.get('x-api-key')
    || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    || '',
  );
  if (!provided || !safeSecretEquals(provided, configured)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function requireAdmin(): Promise<
  { user: SessionData['user'] & {}; error?: never } | { user?: never; error: NextResponse }
> {
  const auth = await requireAuth();
  if (auth.error) return auth;

  if (!await hasWorkspaceAdminAccess(auth.user)) {
    return { error: NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 }) };
  }

  return auth;
}

export async function verifyLocalProjectAccess(
  userId: string,
  projectId: string
): Promise<{ project: ProjectAccessRow; error?: never } | { project?: never; error: NextResponse }> {
  const [project] = await query<ProjectAccessRow[]>(
    `SELECT id, name, project_type, user_id, organization_id
     FROM projects
     WHERE id = ?`,
    [projectId]
  );

  if (!project) {
    return { error: NextResponse.json({ error: 'Project not found' }, { status: 404 }) };
  }
  if (project.organization_id) {
    try {
      await requireProjectPermission({ userId, projectId, action: 'project.read' });
    } catch (error) {
      return { error: organizationAccessError(error) };
    }
  } else if (project.user_id !== userId) {
    return { error: NextResponse.json({ error: 'Forbidden: You do not own this project' }, { status: 403 }) };
  }
  if (project.project_type !== 'local') {
    return { error: NextResponse.json({ error: 'This endpoint is for local projects only' }, { status: 400 }) };
  }
  return { project };
}

/** Generic ownership check for any project type (local or github). */
export async function verifyProjectOwnership(
  userId: string,
  projectId: string,
  action: import('./organizations/permissions').PermissionKey = 'project.read',
): Promise<{ project: ProjectAccessRow; error?: never } | { project?: never; error: NextResponse }> {
  // Local projects are stored in the `projects` table
  const [localProject] = await query<ProjectAccessRow[]>(
    `SELECT id, name, project_type, user_id, organization_id FROM projects WHERE id = ?`,
    [projectId]
  );
  if (localProject) {
    if (localProject.organization_id) {
      try {
        await requireProjectPermission({ userId, projectId, action });
      } catch (error) {
        return { error: organizationAccessError(error) };
      }
    } else if (localProject.user_id !== userId) {
      return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
    return { project: localProject };
  }

  // GitHub repos are stored in `github_repositories` — ownership via installation
  const [githubRepo] = await query<ProjectAccessRow[]>(
    `SELECT r.id, r.full_name, i.user_id, i.organization_id
     FROM github_repositories r
     JOIN github_installations i ON i.id = r.installation_id
     WHERE r.id = ?`,
    [projectId]
  );
  if (githubRepo) {
    if (githubRepo.user_id !== userId) {
      // Fallback path: legacy rows can have github_installations.user_id = NULL.
      // In that case, trust ownership through a linked project record.
      const [linkedProject] = await query<ProjectAccessRow[]>(
        `SELECT id, user_id, organization_id FROM projects WHERE repository_id = ? LIMIT 1`,
        [projectId]
      );
      if (!linkedProject) {
        return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
      }
      if (linkedProject.organization_id) {
        try {
          await requireProjectPermission({ userId, projectId: linkedProject.id, action });
        } catch (error) {
          return { error: organizationAccessError(error) };
        }
      } else if (linkedProject.user_id !== userId) {
        return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
      }
    }
    return { project: githubRepo };
  }

  return { error: NextResponse.json({ error: 'Project not found' }, { status: 404 }) };
}

export async function verifyInstallationOwnership(
  userId: string,
  installationId: string
): Promise<boolean> {
  const [result] = await query<InstallationAccessRow[]>(
    `SELECT id, user_id, organization_id FROM github_installations WHERE id = ?`,
    [installationId]
  );
  if (!result) return false;
  if (result.user_id === userId) return true;
  if (!result.organization_id) return false;
  try {
    await requireOrganizationPermission({
      userId,
      organizationId: result.organization_id,
      action: 'repository.read',
    });
    return true;
  } catch {
    return false;
  }
}

export async function verifyRepositoryOwnership(
  userId: string,
  owner: string,
  repo: string
): Promise<{ installationId: string; suspended: boolean } | null> {
  const [result] = await query<RepositoryAccessRow[]>(
    `SELECT r.installation_id, i.id as installation_uuid, i.suspended_at
     FROM github_repositories r
     JOIN github_installations i ON i.id = r.installation_id
     WHERE r.full_name = ? AND i.user_id = ?`,
    [`${owner}/${repo}`, userId]
  );

  if (result) {
    return { installationId: String(result.installation_uuid || result.installation_id), suspended: !!result.suspended_at };
  }

  // Fallback path: installation rows may exist without user_id populated.
  // Resolve ownership via any linked project owned by the user.
  const [fallback] = await query<RepositoryAccessRow[]>(
    `SELECT r.installation_id, i.suspended_at, p.id AS project_id, p.organization_id
     FROM github_repositories r
     LEFT JOIN github_installations i ON i.id = r.installation_id
     JOIN projects p ON p.repository_id = r.id
     WHERE r.full_name = ? AND p.user_id = ?
     LIMIT 1`,
    [`${owner}/${repo}`, userId]
  );
  if (!fallback) {
    const [organizationRepo] = await query<RepositoryAccessRow[]>(
      `SELECT r.installation_id, i.suspended_at, p.id AS project_id, p.organization_id
       FROM github_repositories r
       LEFT JOIN github_installations i ON i.id = r.installation_id
       JOIN projects p ON p.repository_id = r.id
       WHERE r.full_name = ? AND p.organization_id IS NOT NULL
       LIMIT 1`,
      [`${owner}/${repo}`],
    );
    if (!organizationRepo) return null;
    if (!organizationRepo.project_id) return null;
    try {
      await requireProjectPermission({ userId, projectId: organizationRepo.project_id, action: 'repository.read' });
      return { installationId: String(organizationRepo.installation_id), suspended: !!organizationRepo.suspended_at };
    } catch {
      return null;
    }
  }
  return { installationId: String(fallback.installation_id), suspended: !!fallback.suspended_at };
}
