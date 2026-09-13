import { registerSecurityBudget } from '@/lib/ai-platform/security-run-budget';
import { configuredRemediationModel, PAID_REMEDIATION_MODEL } from '@/lib/ai-platform/remediation-platform-models';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders, formatAgenticFetchError } from '@/lib/agentic';
import { resolveAgenticBillingContext } from '@/lib/agentic-context';
import { query } from '@/lib/db';
import { githubService } from '@/lib/github';
import { denyUnlessPlanFeature } from '@/lib/billing/plan-access-guard';
import {
  findLatestSession,
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

    const denied = await denyUnlessPlanFeature(request, user, 'security_automation');
    if (denied) return denied;

    const billing = await resolveAgenticBillingContext({ request, user });

    const {
      project_id,
      github_token,
      resume_publication,
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

    // Operator-selected remediation model; never trust a browser model override.
    // Paid execution additionally requires a scoped, capped run registration.
    const llmFields = {
      llm_provider: 'openrouter',
      llm_api_key: null,
      llm_model: configuredRemediationModel(),
      llm_access_mode: 'platform',
      llm_credential_id: null,
    };

    if (llmFields.llm_model === PAID_REMEDIATION_MODEL) {
      const cap = Number(process.env.SECURITY_REMEDIATION_MAX_USD);
      if (!Number.isFinite(cap) || cap <= 0 || cap > 2) {
        return NextResponse.json({ error: 'Paid remediation requires a positive spending cap of at most US$2 per run.' }, { status: 503 });
      }
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
        const token = runtimeGithubToken || await githubService.getInstallationTokenForRemediation(project.installation_uuid);
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
      const token = runtimeGithubToken || await githubService.getInstallationTokenForRemediation(ghRepo.installation_uuid);
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

    backendPayload = { ...backendPayload, resume_publication: resume_publication === true };
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
    if (llmFields.llm_model === PAID_REMEDIATION_MODEL && resume_publication !== true) {
      const cap = Number(process.env.SECURITY_REMEDIATION_MAX_USD);
      if (typeof data.run_id !== 'string' || !data.run_id) throw new Error('Missing remediation run identity');
      await registerSecurityBudget(data.run_id, user.id, true, billing.fields.organization_id, cap, PAID_REMEDIATION_MODEL);
    }
    let workspaceSessionId: string | null = null;
    try {
      const repoLabel = String((backendPayload as { project_name?: string }).project_name || project_id);
      const latest = await findLatestSession({
        userId: user.id,
        projectId: String(project_id),
        service: 'security_agent',
        externalId: String(data.run_id),
      });
      const session = await resolveOrCreateSession(
        latest?.id || null,
        {
          userId: user.id,
          projectId: String(project_id),
          service: 'security_agent',
          title: latest?.title || `Remediation - ${repoLabel}`,
          repo: repoLabel,
          status: 'running',
          currentStage: 'remediate_run',
          triggeredBy: user.id,
          organizationId: billing.fields.organization_id,
          externalId: String(data.run_id),
          metadata: { remediation_run_id: data.run_id, organization_id: billing.fields.organization_id, remediation_model: llmFields.llm_model, max_spend_usd: llmFields.llm_model === PAID_REMEDIATION_MODEL ? Number(process.env.SECURITY_REMEDIATION_MAX_USD) : 0, retention_days_minimum: 30 },
        },
      );
      if (!session) throw new Error('Could not create the remediation Session. Please retry.');
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
      return NextResponse.json({ error: 'Could not save the remediation Session. Please retry before starting the run.' }, { status: 503 });
    }
    return NextResponse.json({
      ...data,
      remediation_model: llmFields.llm_model,
      max_spend_usd: llmFields.llm_model === PAID_REMEDIATION_MODEL ? Number(process.env.SECURITY_REMEDIATION_MAX_USD) : 0,
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
