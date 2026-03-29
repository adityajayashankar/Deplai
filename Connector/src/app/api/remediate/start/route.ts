import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { query } from '@/lib/db';
import { githubService } from '@/lib/github';

interface ProjectRow {
  id: string;
  name: string | null;
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
  user_id: string;
  suspended_at: string | null;
}

interface GitHubUserProfile {
  id: number;
  login: string;
}

async function validateGitHubTokenOwnership(githubToken: string, expectedLogin?: string | null): Promise<void> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error('Invalid GitHub token');
  }

  const profile = (await response.json()) as GitHubUserProfile;
  if (!profile?.login) {
    throw new Error('Invalid GitHub token profile');
  }

  if (expectedLogin && profile.login.toLowerCase() !== expectedLogin.toLowerCase()) {
    throw new Error('GitHub token does not belong to authenticated user');
  }
}

export async function POST(request: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const { project_id, cortex_context, github_token, llm_provider, llm_api_key, llm_model, remediation_scope } = await request.json();
    const runtimeGithubToken =
      typeof github_token === 'string' && github_token.trim().length > 0
        ? github_token.trim()
        : null;
    const scope = remediation_scope === 'major' ? 'major' : 'all';
    let usedInstallationToken = false;

    if (!project_id) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    const projectRows = await query<ProjectRow[]>(
      `SELECT
        p.id,
        p.name,
        p.project_type,
        p.user_id,
        gr.full_name AS repo_full_name,
        gi.id AS installation_uuid,
        gi.suspended_at
      FROM projects p
      LEFT JOIN github_repositories gr ON p.repository_id = gr.id
      LEFT JOIN github_installations gi ON gr.installation_id = gi.id
      WHERE p.id = ?`,
      [project_id]
    );
    const project = projectRows[0];

    let backendPayload: Record<string, unknown> | null = null;

    if (project) {
      if (project.user_id !== user.id) {
        return NextResponse.json({ error: 'Forbidden: You do not own this project' }, { status: 403 });
      }

      if (project.project_type === 'github') {
        if (!project.repo_full_name || !project.installation_uuid) {
          return NextResponse.json({ error: 'GitHub project metadata is incomplete' }, { status: 400 });
        }
        const token = runtimeGithubToken || await githubService.getInstallationToken(project.installation_uuid);
        usedInstallationToken = !runtimeGithubToken;
        if (runtimeGithubToken) {
          await validateGitHubTokenOwnership(runtimeGithubToken, user.login);
        }
        const [owner, repo] = project.repo_full_name.split('/');

        backendPayload = {
          project_id,
          project_name: project.name || repo,
          project_type: 'github',
          user_id: String(user.id),
          github_token: token,
          repository_url: `https://github.com/${owner}/${repo}`,
          cortex_context: cortex_context || null,
          llm_provider: llm_provider || null,
          llm_api_key: llm_api_key || null,
          llm_model: llm_model || null,
          remediation_scope: scope,
        };
      } else {
        backendPayload = {
          project_id,
          project_name: project.name,
          project_type: 'local',
          user_id: String(user.id),
          cortex_context: cortex_context || null,
          llm_provider: llm_provider || null,
          llm_api_key: llm_api_key || null,
          llm_model: llm_model || null,
          remediation_scope: scope,
        };
      }
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
        [project_id]
      );
      const ghRepo = ghRepoRows[0];

      if (!ghRepo) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }
      if (ghRepo.user_id !== user.id) {
        return NextResponse.json({ error: 'Forbidden: You do not own this repository' }, { status: 403 });
      }
      const token = runtimeGithubToken || await githubService.getInstallationToken(ghRepo.installation_uuid);
      usedInstallationToken = !runtimeGithubToken;
      if (runtimeGithubToken) {
        await validateGitHubTokenOwnership(runtimeGithubToken, user.login);
      }
      const [owner, repo] = ghRepo.full_name.split('/');

      backendPayload = {
        project_id,
        project_name: repo,
        project_type: 'github',
        user_id: String(user.id),
        github_token: token,
        repository_url: `https://github.com/${owner}/${repo}`,
        cortex_context: cortex_context || null,
        llm_provider: llm_provider || null,
        llm_api_key: llm_api_key || null,
        llm_model: llm_model || null,
        remediation_scope: scope,
      };
    }

    const response = await fetch(`${AGENTIC_URL}/api/remediate/validate`, {
      method: 'POST',
      headers: agenticHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(backendPayload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error || 'Backend request failed');
    }

    const data = await response.json();
    return NextResponse.json({
      ...data,
      auth_mode: usedInstallationToken ? 'installation_token' : 'user_token',
    });
  } catch (error: unknown) {
    console.error('Remediation start error:', error);
    const message = error instanceof Error ? error.message : 'Failed to start remediation';
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
