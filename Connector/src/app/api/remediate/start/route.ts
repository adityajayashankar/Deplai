import { DEFAULT_REMEDIATION_PLATFORM_MODEL } from '@/lib/ai-platform/remediation-platform-models';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders, formatAgenticFetchError } from '@/lib/agentic';
import { resolveAgenticBillingContext } from '@/lib/agentic-context';
import { query } from '@/lib/db';
import { githubService } from '@/lib/github';
import {
  findLatestSession,
  isReusableSecuritySession,
  resolveOrCreateSession,
  tryAppendSessionLogs,
} from '@/lib/sessions/store';

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

    const billing = await resolveAgenticBillingContext({ request, user });

    const {
      project_id,
      github_token,
    } = await request.json();
    const runtimeGithubToken =
      typeof github_token === 'string' && github_token.trim().length > 0
        ? github_token.trim()
        : null;
    // Incoming scope values from older clients are ignored; remediation never
    // expands beyond critical/high findings.
    const scope = 'major';
    let usedInstallationToken = false;

    if (!project_id) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    // The OpenRouter free router owns upstream model selection. Ignore a model
    // value sent by older browser sessions so remediation can never be routed
    // to a selected catalog model, BYOK credential, or paid fallback.
    const llmFields = {
      llm_provider: 'openrouter',
      llm_api_key: null,
      llm_model: DEFAULT_REMEDIATION_PLATFORM_MODEL,
      llm_access_mode: 'platform',
      llm_credential_id: null,
    };

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
          ...billing.fields,
          github_token: token,
          repository_url: `https://github.com/${owner}/${repo}`,
          ...llmFields,
          remediation_scope: scope,
        };
      } else {
        backendPayload = {
          project_id,
          project_name: project.name,
          project_type: 'local',
          ...billing.fields,
          ...llmFields,
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
        ...billing.fields,
        github_token: token,
        repository_url: `https://github.com/${owner}/${repo}`,
        ...llmFields,
        remediation_scope: scope,
      };
    }

    let response: Response;
    try {
      response = await fetch(`${AGENTIC_URL}/api/remediate/validate`, {
        method: 'POST',
        headers: agenticHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(backendPayload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (fetchError) {
      throw new Error(formatAgenticFetchError(fetchError));
    }

    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error || 'Backend request failed');
    }

    const data = await response.json();
    let workspaceSessionId: string | null = null;
    try {
      const repoLabel = String((backendPayload as { project_name?: string }).project_name || project_id);
      const latest = await findLatestSession({
        userId: user.id,
        projectId: String(project_id),
        service: 'security_agent',
      });
      const session = await resolveOrCreateSession(
        latest && isReusableSecuritySession(latest) ? latest.id : null,
        {
          userId: user.id,
          projectId: String(project_id),
          service: 'security_agent',
          title: latest?.title || `Security agent · ${repoLabel}`,
          repo: repoLabel,
          status: 'running',
          currentStage: 'remediate_run',
          triggeredBy: user.id,
        },
      );
      if (session) {
        await tryAppendSessionLogs(session.id, [{
          level: 'info',
          message: 'Remediation started.',
          stage: 'remediate_run',
        }]);
        workspaceSessionId = session.id;
      }
    } catch (sessionError) {
      console.error('[sessions] remediation start hook failed', sessionError);
    }
    return NextResponse.json({
      ...data,
      auth_mode: usedInstallationToken ? 'installation_token' : 'user_token',
      workspace_session_id: workspaceSessionId,
    });
  } catch (error: unknown) {
    console.error('Remediation start error:', error);
    const message = formatAgenticFetchError(error);
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
