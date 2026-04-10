import { githubService } from './github';
import { resolveProjectMeta } from './project-meta';

export interface IacRepoFile {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
}

export interface RepoPersistenceResult {
  attempted: boolean;
  success: boolean;
  pr_url: string | null;
  branch?: string | null;
  reason?: string;
  error?: string;
  files_committed?: number;
}

function normalizeProjectPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function normalizeRepoWritePath(filePath: string): string {
  const normalized = normalizeProjectPath(filePath || '');
  if (!normalized || normalized.includes('..')) return '';
  return normalized;
}

function isPersistableIacFile(file: IacRepoFile): boolean {
  const safePath = normalizeRepoWritePath(file.path);
  if (!safePath) return false;
  if (safePath.startsWith('terraform/site/')) return false;
  return safePath.startsWith('terraform/') || safePath.startsWith('ansible/') || safePath === 'README.md';
}

export async function persistIacToRepoPr(
  userId: string,
  projectId: string,
  projectName: string,
  files: IacRepoFile[],
): Promise<RepoPersistenceResult> {
  const meta = await resolveProjectMeta(userId, projectId);
  if (!meta) {
    return { attempted: false, success: false, pr_url: null, reason: 'project_metadata_unavailable' };
  }
  if (meta.project_type !== 'github') {
    return { attempted: false, success: false, pr_url: null, reason: 'local_project' };
  }
  if (!meta.repo_full_name || !meta.installation_uuid) {
    return { attempted: false, success: false, pr_url: null, reason: 'missing_repo_metadata' };
  }

  const persistable = files.filter(isPersistableIacFile);
  if (persistable.length === 0) {
    return { attempted: false, success: false, pr_url: null, reason: 'no_persistable_iac_files' };
  }

  const [owner, repo] = meta.repo_full_name.split('/');
  if (!owner || !repo) {
    return { attempted: false, success: false, pr_url: null, reason: 'invalid_repo_name' };
  }

  try {
    const octokit = await githubService.getInstallationClient(meta.installation_uuid);
    const repoInfo = await octokit.repos.get({ owner, repo });
    const baseBranch = String(repoInfo.data.default_branch || 'main');

    const openPulls = await octokit.pulls.list({
      owner,
      repo,
      state: 'open',
      base: baseBranch,
      per_page: 100,
    });

    const existingPull = openPulls.data.find((pull) =>
      String(pull.head?.ref || '').startsWith('deplai/iac-structure-'),
    );
    if (existingPull?.html_url) {
      return {
        attempted: true,
        success: true,
        pr_url: existingPull.html_url,
        branch: String(existingPull.head?.ref || '') || null,
        reason: 'existing_open_pr',
      };
    }

    const baseRef = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`,
    });

    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
    let branch = `deplai/iac-structure-${timestamp}`;
    let branchCreated = false;
    let attempt = 0;
    while (!branchCreated && attempt < 4) {
      const suffix = attempt === 0 ? '' : `-${attempt}`;
      const candidate = `${branch}${suffix}`;
      try {
        await octokit.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${candidate}`,
          sha: baseRef.data.object.sha,
        });
        branch = candidate;
        branchCreated = true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err || '');
        if (!/Reference already exists/i.test(msg)) throw err;
        attempt += 1;
      }
    }
    if (!branchCreated) {
      return {
        attempted: true,
        success: false,
        pr_url: null,
        reason: 'branch_creation_failed',
        error: 'Could not allocate a unique branch name for IaC PR.',
      };
    }

    let committed = 0;
    for (const file of persistable) {
      const safePath = normalizeRepoWritePath(file.path);
      if (!safePath) continue;

      let existingSha: string | undefined;
      try {
        const existing = await octokit.repos.getContent({
          owner,
          repo,
          path: safePath,
          ref: branch,
        });
        if (!Array.isArray(existing.data) && existing.data.type === 'file') {
          existingSha = existing.data.sha;
        }
      } catch {
        existingSha = undefined;
      }

      const contentBase64 = file.encoding === 'base64'
        ? file.content
        : Buffer.from(file.content, 'utf-8').toString('base64');

      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: safePath,
        message: existingSha ? `chore(iac): update ${safePath}` : `feat(iac): add ${safePath}`,
        content: contentBase64,
        branch,
        ...(existingSha ? { sha: existingSha } : {}),
      });
      committed += 1;
    }

    if (committed === 0) {
      return {
        attempted: true,
        success: false,
        pr_url: null,
        branch,
        reason: 'no_changes_to_commit',
      };
    }

    const pr = await octokit.pulls.create({
      owner,
      repo,
      base: baseBranch,
      head: branch,
      title: `feat(iac): structured Terraform bundle for ${projectName}`,
      body: [
        'This PR was generated by DeplAI pipeline IaC stage.',
        '',
        'Highlights:',
        '- Structured Terraform layout (`providers.tf`, `backend.tf`, `main.tf`, `variables.tf`, `terraform.tfvars`, `outputs.tf`)',
        '- Modularized resources (`modules/`)',
        '- Environment overlays (`environments/dev`, `environments/prod`)',
        '- Free-tier-eligible defaults with production-aware hardening baseline',
      ].join('\n'),
      maintainer_can_modify: true,
    });

    return {
      attempted: true,
      success: true,
      pr_url: pr.data.html_url || null,
      branch,
      files_committed: committed,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to persist IaC as PR.';
    return {
      attempted: true,
      success: false,
      pr_url: null,
      reason: 'persist_failed',
      error: message,
    };
  }
}
