import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { sessionOptions, SessionData } from './session';
import { query } from './db';

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

export async function hasWorkspaceAdminAccess(
  user: SessionData['user'] | null | undefined,
  providedSecret?: string | null
): Promise<boolean> {
  if (isAdminUser(user)) return true;

  const key = normalizeSecret(providedSecret);
  if (!key) return false;

  const configuredSecrets = [
    normalizeSecret(process.env.ADMIN_ACCESS_KEY),
    normalizeSecret(process.env.DEPLAI_SERVICE_KEY),
  ].filter(Boolean);

  for (const secret of configuredSecrets) {
    if (safeSecretEquals(key, secret)) {
      return true;
    }
  }

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
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions);

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
  } catch (error) {
    // Keep auth non-blocking if reconciliation fails; downstream handlers can surface DB issues.
    console.warn('Failed to reconcile authenticated user record:', error);
  }
}

export async function requireAuth(): Promise<
  { user: SessionData['user'] & {}; error?: never } | { user?: never; error: NextResponse }
> {
  const user = await getAuthenticatedUser();
  if (!user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  return { user };
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
): Promise<{ project: any; error?: never } | { project?: never; error: NextResponse }> {
  const [project] = await query<any[]>(
    `SELECT id, name, project_type, user_id
     FROM projects
     WHERE id = ?`,
    [projectId]
  );

  if (!project) {
    return { error: NextResponse.json({ error: 'Project not found' }, { status: 404 }) };
  }
  if (project.user_id !== userId) {
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
  projectId: string
): Promise<{ project: any; error?: never } | { project?: never; error: NextResponse }> {
  // Local projects are stored in the `projects` table
  const [localProject] = await query<any[]>(
    `SELECT id, name, project_type, user_id FROM projects WHERE id = ?`,
    [projectId]
  );
  if (localProject) {
    if (localProject.user_id !== userId) {
      return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
    return { project: localProject };
  }

  // GitHub repos are stored in `github_repositories` — ownership via installation
  const [githubRepo] = await query<any[]>(
    `SELECT r.id, r.full_name, i.user_id
     FROM github_repositories r
     JOIN github_installations i ON i.id = r.installation_id
     WHERE r.id = ?`,
    [projectId]
  );
  if (githubRepo) {
    if (githubRepo.user_id !== userId) {
      // Fallback path: legacy rows can have github_installations.user_id = NULL.
      // In that case, trust ownership through a linked project record.
      const [linkedProject] = await query<any[]>(
        `SELECT id, user_id FROM projects WHERE repository_id = ? LIMIT 1`,
        [projectId]
      );
      if (!linkedProject || linkedProject.user_id !== userId) {
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
  const [result] = await query<any[]>(
    `SELECT id FROM github_installations 
     WHERE id = ? AND user_id = ?`,
    [installationId, userId]
  );

  return !!result;
}

export async function verifyRepositoryOwnership(
  userId: string,
  owner: string,
  repo: string
): Promise<{ installationId: string; suspended: boolean } | null> {
  const [result] = await query<any[]>(
    `SELECT r.installation_id, i.id as installation_uuid, i.suspended_at
     FROM github_repositories r
     JOIN github_installations i ON i.id = r.installation_id
     WHERE r.full_name = ? AND i.user_id = ?`,
    [`${owner}/${repo}`, userId]
  );

  if (result) {
    return { installationId: result.installation_uuid, suspended: !!result.suspended_at };
  }

  // Fallback path: installation rows may exist without user_id populated.
  // Resolve ownership via any linked project owned by the user.
  const [fallback] = await query<any[]>(
    `SELECT r.installation_id, i.suspended_at
     FROM github_repositories r
     LEFT JOIN github_installations i ON i.id = r.installation_id
     JOIN projects p ON p.repository_id = r.id
     WHERE r.full_name = ? AND p.user_id = ?
     LIMIT 1`,
    [`${owner}/${repo}`, userId]
  );
  if (!fallback) return null;
  return { installationId: String(fallback.installation_id), suspended: !!fallback.suspended_at };
}
