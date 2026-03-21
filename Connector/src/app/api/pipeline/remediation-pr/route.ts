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

export async function POST(request: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await request.json().catch(() => ({})) as { project_id?: string };
    const projectId = String(body.project_id || '').trim();
    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    const rows = await query<ProjectRow[]>(
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
    const project = rows[0];

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    if (project.user_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (project.project_type !== 'github') {
      return NextResponse.json({ success: true, pr_url: null, reason: 'local_project' });
    }
    if (!project.repo_full_name || !project.installation_uuid) {
      return NextResponse.json({ success: true, pr_url: null, reason: 'missing_repo_metadata' });
    }

    const [owner, repo] = project.repo_full_name.split('/');
    if (!owner || !repo) {
      return NextResponse.json({ success: true, pr_url: null, reason: 'invalid_repo_name' });
    }

    const octokit = await githubService.getInstallationClient(project.installation_uuid);
    const response = await octokit.pulls.list({
      owner,
      repo,
      state: 'open',
      sort: 'created',
      direction: 'desc',
      per_page: 30,
    });

    const match = response.data.find(pr => {
      const title = String(pr.title || '').toLowerCase();
      const headRef = String(pr.head?.ref || '');
      return title.includes('automated remediation fixes') || headRef.startsWith('deplai-remediation-');
    });

    return NextResponse.json({
      success: true,
      pr_url: match?.html_url || null,
      pr_number: match?.number || null,
      total_open_prs: response.data.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to resolve remediation PR';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

