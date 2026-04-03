import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';
import { githubService } from '@/lib/github';

type DbError = {
  code?: string;
  sqlMessage?: string;
  message?: string;
  stack?: string;
};

type LocalProjectRow = {
  id: string;
  name: string;
  project_type: string;
  local_path: string | null;
  file_count: number | null;
  size_bytes: number | null;
  created_at: Date | string;
};

type LegacyLocalProjectRow = {
  id: string;
  name: string;
  created_at: Date | string;
};

type GithubRepoRow = {
  id: string;
  full_name: string | null;
  default_branch: string | null;
  is_private: boolean | number;
  languages: unknown;
  last_synced_at: Date | string | null;
  created_at: Date | string;
  installation_id: string;
  account_login: string | null;
};

function isSchemaError(error: unknown): boolean {
  const dbError = error as DbError;
  return dbError?.code === 'ER_NO_SUCH_TABLE' || dbError?.code === 'ER_BAD_FIELD_ERROR';
}

function isConnectivityError(error: unknown): boolean {
  const dbError = error as DbError;
  return (
    dbError?.code === 'ECONNREFUSED' ||
    dbError?.code === 'ENOTFOUND' ||
    dbError?.code === 'ETIMEDOUT' ||
    dbError?.code === 'EHOSTUNREACH' ||
    dbError?.code === 'PROTOCOL_CONNECTION_LOST'
  );
}

function parseLanguages(value: unknown): Record<string, number> | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, number>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, number>;
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function GET() {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    try {
      await githubService.linkUserInstallation(user.id, user.login);
    } catch (linkError) {
      console.warn('Projects link bootstrap failed:', linkError);
    }

    // Claim personal installations that are still unowned after webhook-only onboarding.
    await query(
      `UPDATE github_installations
       SET user_id = ?
       WHERE user_id IS NULL
         AND account_type = 'User'
         AND LOWER(account_login) = LOWER(?)`,
      [user.id, user.login]
    );

    // Best-effort reconciliation so removed installations/repositories do not linger in UI.
    try {
      await githubService.syncInstallations(user.id);
    } catch (syncError) {
      console.warn('Projects sync before GET /api/projects failed:', syncError);
    }

    let localProjects: LocalProjectRow[] = [];
    try {
      localProjects = await query<LocalProjectRow[]>(
        `SELECT 
          id,
          name,
          project_type,
          local_path,
          file_count,
          size_bytes,
          created_at
         FROM projects
         WHERE user_id = ? AND project_type = 'local'
         ORDER BY created_at DESC`,
        [user.id]
      );
    } catch (localError: unknown) {
      const dbLocalError = localError as DbError;
      if (dbLocalError?.code === 'ER_BAD_FIELD_ERROR') {
        const legacyLocalProjects = await query<LegacyLocalProjectRow[]>(
          `SELECT 
            id,
            name,
            created_at
           FROM projects
           WHERE user_id = ?
           ORDER BY created_at DESC`,
          [user.id]
        );
        localProjects = legacyLocalProjects.map(project => ({
          id: project.id,
          name: project.name,
          project_type: 'local',
          local_path: null,
          file_count: null,
          size_bytes: null,
          created_at: project.created_at,
        }));
      } else if (dbLocalError?.code === 'ER_NO_SUCH_TABLE') {
        console.warn('No projects table found while listing /api/projects:', {
          code: dbLocalError?.code,
          message: dbLocalError?.sqlMessage || dbLocalError?.message,
        });
      } else {
        throw localError;
      }
    }

    let githubRepos: GithubRepoRow[] = [];
    try {
      // Primary ownership path: installation explicitly linked to this user.
      githubRepos = await query<GithubRepoRow[]>(
        `SELECT 
          r.id,
          r.full_name,
          r.default_branch,
          r.is_private,
          r.languages,
          r.last_synced_at,
          r.created_at,
          i.id as installation_id,
          i.account_login
         FROM github_repositories r
         JOIN github_installations i ON i.id = r.installation_id
         WHERE i.user_id = ? AND r.user_hidden = false
         ORDER BY r.full_name ASC`,
        [user.id]
      );

      // Fallback ownership path: legacy rows can miss github_installations.user_id.
      // In that case, include repos linked to projects owned by this user.
      if (githubRepos.length === 0) {
        githubRepos = await query<GithubRepoRow[]>(
          `SELECT DISTINCT
            r.id,
            r.full_name,
            r.default_branch,
            r.is_private,
            r.languages,
            r.last_synced_at,
            r.created_at,
            i.id as installation_id,
            i.account_login
           FROM github_repositories r
           JOIN github_installations i ON i.id = r.installation_id
           LEFT JOIN projects p ON p.repository_id = r.id
           WHERE (i.user_id = ? OR p.user_id = ?) AND r.user_hidden = false
           ORDER BY r.full_name ASC`,
          [user.id, user.id]
        );
      }

      // If still empty, attempt a one-time installation sync (helps when webhook
      // delivery lagged and repository rows were not yet created).
      if (githubRepos.length === 0) {
        try {
          await githubService.syncInstallations(user.id);
          githubRepos = await query<GithubRepoRow[]>(
            `SELECT DISTINCT
              r.id,
              r.full_name,
              r.default_branch,
              r.is_private,
              r.languages,
              r.last_synced_at,
              r.created_at,
              i.id as installation_id,
              i.account_login
             FROM github_repositories r
             JOIN github_installations i ON i.id = r.installation_id
             LEFT JOIN projects p ON p.repository_id = r.id
             WHERE (i.user_id = ? OR p.user_id = ?) AND r.user_hidden = false
             ORDER BY r.full_name ASC`,
            [user.id, user.id]
          );
        } catch (syncErr) {
          console.warn('GitHub installation sync in /api/projects failed:', syncErr);
        }
      }
    } catch (githubError: unknown) {
      const dbGithubError = githubError as DbError;
      // Backward-compatible fallback for older schemas that do not include `user_hidden`.
      if (dbGithubError?.code === 'ER_BAD_FIELD_ERROR') {
        try {
          githubRepos = await query<GithubRepoRow[]>(
            `SELECT DISTINCT
              r.id,
              r.full_name,
              r.default_branch,
              r.is_private,
              r.languages,
              r.last_synced_at,
              r.created_at,
              i.id as installation_id,
              i.account_login
             FROM github_repositories r
             JOIN github_installations i ON i.id = r.installation_id
             LEFT JOIN projects p ON p.repository_id = r.id
             WHERE (i.user_id = ? OR p.user_id = ?)
             ORDER BY r.full_name ASC`,
            [user.id, user.id]
          );
        } catch (fallbackError: unknown) {
          const dbFallbackError = fallbackError as DbError;
          if (!isSchemaError(fallbackError)) throw fallbackError;
          console.warn('Skipping GitHub repositories in /api/projects due to schema mismatch:', {
            code: dbFallbackError?.code,
            message: dbFallbackError?.sqlMessage || dbFallbackError?.message,
          });
        }
      } else if (dbGithubError?.code === 'ER_NO_SUCH_TABLE') {
        // Local-project-only deployments may not have GitHub tables yet.
        console.warn('Skipping GitHub repositories in /api/projects because GitHub tables are missing:', {
          code: dbGithubError?.code,
          message: dbGithubError?.sqlMessage || dbGithubError?.message,
        });
      } else {
        throw githubError;
      }
    }

    const formattedLocalProjects = localProjects.map(project => ({
      id: project.id,
      name: project.name,
      type: 'local',
      source: 'System',
      access: 'Local',
      fileCount: project.file_count,
      sizeBytes: project.size_bytes,
      createdAt: project.created_at,
      canDelete: true,
    }));

    const formattedGithubRepos = githubRepos.map(repo => {
      const fullName = repo.full_name ?? '';
      const [owner, repoName] = fullName.split('/');
      
      return {
        id: repo.id,
        name: fullName,
        owner,
        repo: repoName,
        type: 'github',
        source: repo.account_login || owner || 'GitHub',
        branch: repo.default_branch,
        access: repo.is_private ? 'Private' : 'Public',
        languages: parseLanguages(repo.languages),
        lastSyncedAt: repo.last_synced_at,
        createdAt: repo.created_at,
        installationId: repo.installation_id,
        canDelete: true,
      };
    });

    const allProjects = [...formattedLocalProjects, ...formattedGithubRepos];

    return NextResponse.json({
      projects: allProjects,
      stats: {
        localCount: formattedLocalProjects.length,
        githubCount: formattedGithubRepos.length,
        totalCount: allProjects.length,
      },
    });
  } catch (error: unknown) {
    const dbError = error as DbError;
    console.error('Error fetching projects:', {
      code: dbError?.code,
      message: dbError?.sqlMessage || dbError?.message,
      stack: dbError?.stack,
    });
    if (isConnectivityError(error)) {
      return NextResponse.json(
        { error: 'Database unavailable. Verify DB_HOST/DB_PORT and that MySQL is running.' },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: 'Failed to fetch projects' },
      { status: 500 }
    );
  }
}
