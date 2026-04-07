import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';
import { githubService } from '@/lib/github';

interface ProjectRow {
  id: string;
  project_type: 'local' | 'github';
  user_id: string;
  repo_full_name: string | null;
  installation_uuid: string | null;
}

interface GitHubRepoRow {
  id: string;
  full_name: string;
  installation_uuid: string;
  user_id: string;
}

export async function POST(request: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await request.json().catch(() => ({})) as { project_id?: string };
    const projectId = String(body.project_id || '').trim();
    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    const projectRows = await query<ProjectRow[]>(
      `SELECT
        p.id,
        p.project_type,
        p.user_id,
        gr.full_name AS repo_full_name,
        gi.id AS installation_uuid
      FROM projects p
      LEFT JOIN github_repositories gr ON p.repository_id = gr.id
      LEFT JOIN github_installations gi ON gr.installation_id = gi.id
      WHERE p.id = ?`,
      [projectId],
    );
    const project = projectRows[0];

    let repoFullName: string | null = null;
    let installationUuid: string | null = null;

    if (project) {
      if (project.user_id !== user.id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      if (project.project_type !== 'github') {
        return NextResponse.json({ success: true, pr_url: null, reason: 'local_project' });
      }
      repoFullName = project.repo_full_name;
      installationUuid = project.installation_uuid;
    } else {
      const ghRepoRows = await query<GitHubRepoRow[]>(
        `SELECT
          r.id,
          r.full_name,
          i.id AS installation_uuid,
          i.user_id
        FROM github_repositories r
        JOIN github_installations i ON i.id = r.installation_id
        WHERE r.id = ?`,
        [projectId],
      );
      const ghRepo = ghRepoRows[0];
      if (!ghRepo) {
        return NextResponse.json({ success: true, pr_url: null, reason: 'project_not_found' });
      }
      if (ghRepo.user_id !== user.id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      repoFullName = ghRepo.full_name;
      installationUuid = ghRepo.installation_uuid;
    }

    if (!repoFullName || !installationUuid) {
      return NextResponse.json({ success: true, pr_url: null, reason: 'missing_repo_metadata' });
    }

    const [owner, repo] = repoFullName.split('/');
    if (!owner || !repo) {
      return NextResponse.json({ success: true, pr_url: null, reason: 'invalid_repo_name' });
    }

    try {
      const octokit = await githubService.getInstallationClient(installationUuid);
      const response = await octokit.pulls.list({
        owner,
        repo,
        state: 'open',
        sort: 'created',
        direction: 'desc',
        per_page: 30,
      });

      const projectPrefix = `deplai-remediation-${projectId.slice(0, 8)}-`;
      const match = response.data.find(pr => {
        const headRef = String(pr.head?.ref || '');
        // Only count PRs opened by remediation runs for this exact project id prefix.
        // This avoids showing a stale "Create PR" success state after switching repos.
        const newPrefix = `deplai/fix-${projectId.slice(0, 8)}-`;
        return headRef.startsWith(projectPrefix) || headRef.startsWith(newPrefix);
      });

      return NextResponse.json({
        success: true,
        pr_url: match?.html_url || null,
        pr_number: match?.number || null,
        total_open_prs: response.data.length,
      });
    } catch (githubErr: unknown) {
      const message = githubErr instanceof Error ? githubErr.message : 'GitHub PR lookup failed';
      return NextResponse.json({
        success: true,
        pr_url: null,
        pr_number: null,
        total_open_prs: 0,
        reason: 'github_lookup_failed',
        detail: message,
      });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to resolve remediation PR';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

