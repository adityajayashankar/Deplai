import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership, verifyRepositoryOwnership } from '@/lib/auth';
import { githubService } from '@/lib/github';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { query } from '@/lib/db';

interface ScanValidateBody {
  project_id?: string;
  project_name?: string;
  project_type?: 'local' | 'github';
  scan_type?: 'all' | 'sast' | 'sca';
  owner?: string;
  repo?: string;
}

type ScanValidatePayload = {
  project_id: string;
  project_name: string;
  project_type: 'local' | 'github';
  scan_type: 'all' | 'sast' | 'sca';
  user_id: string;
  github_token?: string;
  repository_url?: string;
};

interface ProjectRow {
  id: string;
  project_type: 'local' | 'github';
  user_id: string;
  repo_full_name: string | null;
  installation_uuid: string | null;
  suspended_at: string | null;
}

interface GitHubRepoRow {
  id: string;
  full_name: string;
  installation_uuid: string;
  user_id: string | null;
  suspended_at: string | null;
}

export async function POST(request: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await request.json().catch(() => ({})) as ScanValidateBody;
    const resolvedProjectId = String(body.project_id || '').trim();
    const resolvedProjectName = String(body.project_name || '').trim();
    const resolvedProjectType: 'local' | 'github' = body.project_type === 'github' ? 'github' : 'local';
    const resolvedScanType: 'all' | 'sast' | 'sca' =
      body.scan_type === 'sast' || body.scan_type === 'sca' ? body.scan_type : 'all';

    if (!resolvedProjectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }
    if (!resolvedProjectName) {
      return NextResponse.json({ error: 'project_name is required' }, { status: 400 });
    }

    const backendPayload: ScanValidatePayload = {
      project_id: resolvedProjectId,
      project_name: resolvedProjectName,
      project_type: resolvedProjectType,
      scan_type: resolvedScanType,
      user_id: String(user.id),
    };

    if (resolvedProjectType === 'github') {
      const resolvedOwner = String(body.owner || '').trim();
      const resolvedRepo = String(body.repo || '').trim();

      let repoFullName: string | null = null;
      let installationUuid: string | null = null;
      let suspended = false;

      const projectRows = await query<ProjectRow[]>(
        `SELECT
          p.id,
          p.project_type,
          p.user_id,
          gr.full_name AS repo_full_name,
          gi.id AS installation_uuid,
          gi.suspended_at
        FROM projects p
        LEFT JOIN github_repositories gr ON p.repository_id = gr.id
        LEFT JOIN github_installations gi ON gr.installation_id = gi.id
        WHERE p.id = ?`,
        [resolvedProjectId],
      );
      const project = projectRows[0];

      if (project) {
        if (project.user_id !== user.id) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        if (project.project_type !== 'github') {
          return NextResponse.json({ error: 'Selected project is not a GitHub repository' }, { status: 400 });
        }
        repoFullName = project.repo_full_name;
        installationUuid = project.installation_uuid;
        suspended = Boolean(project.suspended_at);
      } else {
        const ghRepoRows = await query<GitHubRepoRow[]>(
          `SELECT
            r.id,
            r.full_name,
            i.id AS installation_uuid,
            i.user_id,
            i.suspended_at
          FROM github_repositories r
          JOIN github_installations i ON i.id = r.installation_id
          WHERE r.id = ?`,
          [resolvedProjectId],
        );
        const ghRepo = ghRepoRows[0];
        if (ghRepo) {
          // Installations can have NULL user_id on legacy rows; fallback to project ownership check.
          if (ghRepo.user_id && ghRepo.user_id !== user.id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
          }
          if (!ghRepo.user_id) {
            const ownershipByProject = await verifyProjectOwnership(user.id, resolvedProjectId);
            if ('error' in ownershipByProject) {
              return NextResponse.json({ error: 'Repository not found or access denied' }, { status: 403 });
            }
          }
          repoFullName = ghRepo.full_name;
          installationUuid = ghRepo.installation_uuid;
          suspended = Boolean(ghRepo.suspended_at);
        }
      }

      if ((!repoFullName || !installationUuid) && resolvedOwner && resolvedRepo) {
        const ownership = await verifyRepositoryOwnership(user.id, resolvedOwner, resolvedRepo);
        if (ownership) {
          repoFullName = `${resolvedOwner}/${resolvedRepo}`;
          installationUuid = ownership.installationId;
          suspended = ownership.suspended;
        }
      }

      if (!repoFullName || !installationUuid) {
        return NextResponse.json({ error: 'Repository not found or access denied' }, { status: 403 });
      }
      if (suspended) {
        return NextResponse.json(
          { error: 'GitHub App installation is suspended. Unsuspend before scanning.' },
          { status: 403 },
        );
      }

      try {
        const token = await githubService.getInstallationToken(installationUuid);
        backendPayload.github_token = token;
        backendPayload.repository_url = `https://github.com/${repoFullName}`;
      } catch (tokenError: unknown) {
        console.error('Failed to get GitHub token:', tokenError);
        return NextResponse.json(
          { error: 'Failed to authenticate with GitHub. The installation may be suspended or removed.' },
          { status: 403 },
        );
      }
    }

    const response = await fetch(`${AGENTIC_URL}/api/scan/validate`, {
      method: 'POST',
      headers: agenticHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(backendPayload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ error: 'Backend request failed' }));
      console.error('Scan validate backend error:', response.status, errorBody);
      return NextResponse.json(
        { error: errorBody?.error || errorBody?.detail || 'Backend scan validation failed' },
        { status: response.status },
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (routeError: unknown) {
    console.error('Scan validation error:', routeError);
    return NextResponse.json({ error: 'Failed to validate scan' }, { status: 500 });
  }
}
