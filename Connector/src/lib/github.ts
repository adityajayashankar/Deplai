import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { query } from './db';
import { v4 as uuidv4 } from 'uuid';
import simpleGit from 'simple-git';
import { createPrivateKey } from 'crypto';
import fs from 'fs';
import path from 'path';
import { requireEnv } from './env';

interface GitHubConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
}

interface CachedToken {
  token: string;
  expiresAt: Date;
}

function normalizeGitHubPrivateKey(raw: string): string {
  const trimmed = String(raw || '').trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;

  let normalized = unquoted
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n');

  if (!normalized.includes('-----BEGIN')) {
    try {
      const decoded = Buffer.from(normalized, 'base64').toString('utf8').trim();
      if (decoded.includes('-----BEGIN')) {
        normalized = decoded.replace(/\r\n/g, '\n');
      }
    } catch {
      // Keep the original value when it is not valid base64.
    }
  }

  const pem = normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  try {
    return createPrivateKey({ key: pem, format: 'pem' }).export({
      type: 'pkcs8',
      format: 'pem',
    }).toString();
  } catch {
    return pem;
  }
}

export class GitHubService {
  private config: GitHubConfig;
  private app: Octokit;
  private tokenCache = new Map<string, CachedToken>();

  constructor(config: GitHubConfig) {
    this.config = config;

    this.app = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.appId,
        privateKey: normalizeGitHubPrivateKey(config.privateKey),
      },
    });
  }

  private async _createInstallationToken(
    installationId: string,
    permissions?: Record<string, string>,
  ): Promise<string> {
    const cacheKey = installationId + (permissions ? JSON.stringify(permissions) : '');
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > new Date()) {
      return cached.token;
    }

    const installations = await query<any[]>(
      'SELECT installation_id FROM github_installations WHERE id = ?',
      [installationId]
    );

    if (!installations?.length) {
      throw new Error('Installation not found');
    }

    let data;
    try {
      ({ data } = await this.app.apps.createInstallationAccessToken({
        installation_id: installations[0].installation_id,
        ...(permissions ? { permissions } : {}),
      }));
    } catch (err: any) {
      if (err.status === 403) {
        await query(
          `UPDATE github_installations SET suspended_at = NOW() WHERE id = ?`,
          [installationId]
        );
        throw new Error('GitHub App installation is suspended. Please unsuspend it from your GitHub settings.');
      }
      if (err.status === 422 && permissions) {
        // The app doesn't have the requested permissions — surface a clear message
        throw new Error(
          `GitHub App does not have the required permissions (${Object.entries(permissions).map(([k, v]) => `${k}:${v}`).join(', ')}). ` +
          'Go to your GitHub App settings → Permissions & Events → grant Contents: Read & write and Pull requests: Read & write, then ask users to re-authorize. ' +
          'Alternatively, provide a personal access token (PAT) in the GitHub Token field on the remediation screen.'
        );
      }
      throw err;
    }

    this.tokenCache.set(cacheKey, {
      token: data.token,
      expiresAt: new Date(data.expires_at),
    });

    return data.token;
  }

  async getInstallationToken(installationId: string): Promise<string> {
    return this._createInstallationToken(installationId);
  }

  /** Returns a token scoped for remediation (push + PR creation). */
  async getInstallationTokenForRemediation(installationId: string): Promise<string> {
    return this._createInstallationToken(installationId, {
      contents: 'write',
      pull_requests: 'write',
    });
  }

  async getInstallationClient(installationId: string): Promise<Octokit> {
    const token = await this.getInstallationToken(installationId);
    return new Octokit({ auth: token });
  }

  async getRepository(installationId: string, owner: string, repo: string) {
    const octokit = await this.getInstallationClient(installationId);
    const { data } = await octokit.repos.get({ owner, repo });
    
    const { data: languages } = await octokit.repos.listLanguages({ 
      owner, 
      repo 
    });

    return {
      id: data.id,
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      isPrivate: data.private,
      languages,
      size: data.size,
      pushedAt: data.pushed_at,
    };
  }

  async createWebhook(
    installationId: string,
    owner: string,
    repo: string,
    webhookUrl: string
  ): Promise<number> {
    const octokit = await this.getInstallationClient(installationId);
    
    const { data } = await octokit.repos.createWebhook({
      owner,
      repo,
      config: {
        url: webhookUrl,
        content_type: 'json',
        secret: this.config.webhookSecret,
        insecure_ssl: '0',
      },
      events: ['push', 'pull_request'],
      active: true,
    });

    return data.id;
  }

  private repoPath(owner: string, repo: string): string {
    return path.join(process.cwd(), 'tmp', 'repos', owner, repo);
  }

  private async withBranchFallback<T>(
    owner: string,
    repo: string,
    branch: string,
    operation: (branch: string) => Promise<T>
  ): Promise<T> {
    try {
      return await operation(branch);
    } catch (error: any) {
      const fallback = branch === 'main' ? 'master' : 'main';
      if (!error.message.includes('Remote branch') && !error.message.includes('couldn\'t find remote ref')) {
        throw error;
      }

      console.log(`Branch '${branch}' failed for ${owner}/${repo}, trying '${fallback}'...`);
      const result = await operation(fallback);

      await query(
        `UPDATE github_repositories SET default_branch = ? WHERE full_name = ?`,
        [fallback, `${owner}/${repo}`]
      );

      return result;
    }
  }

  private async updateRepoState(owner: string, repo: string, repoPath: string): Promise<void> {
    const git = simpleGit(repoPath);
    const commitSha = await git.revparse(['HEAD']);
    await query(
      `UPDATE github_repositories
       SET needs_refresh = false, last_cloned_at = NOW(), last_commit_sha = ?
       WHERE full_name = ?`,
      [commitSha, `${owner}/${repo}`]
    );
  }

  async cloneRepository(
    installationId: string,
    owner: string,
    repo: string,
    branch?: string
  ): Promise<string> {
    const token = await this.getInstallationToken(installationId);
    const repoDir = this.repoPath(owner, repo);

    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    if (fs.existsSync(repoDir)) {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }

    const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    const git = simpleGit();

    console.log(`Cloning ${owner}/${repo}...`);

    await this.withBranchFallback(owner, repo, branch || 'main', async (b) => {
      await git.clone(cloneUrl, repoDir, ['--depth', '1', '--single-branch', '--branch', b]);
      console.log(`Cloned ${owner}/${repo} (branch: ${b}) successfully`);
    });

    await this.updateRepoState(owner, repo, repoDir);
    return repoDir;
  }

  async pullRepository(installationId: string, owner: string, repo: string): Promise<string> {
    const repoDir = this.repoPath(owner, repo);

    if (!fs.existsSync(repoDir)) {
      throw new Error('Repository not cloned yet');
    }

    const token = await this.getInstallationToken(installationId);
    const git = simpleGit(repoDir);
    await git.remote(['set-url', 'origin', `https://x-access-token:${token}@github.com/${owner}/${repo}.git`]);

    const [repoData] = await query<any[]>(
      `SELECT default_branch FROM github_repositories WHERE full_name = ?`,
      [`${owner}/${repo}`]
    );
    const branch = repoData?.default_branch || 'main';

    console.log(`Pulling latest changes for ${owner}/${repo} (branch: ${branch})...`);

    await this.withBranchFallback(owner, repo, branch, async (b) => {
      await git.pull('origin', b);
      console.log(`Updated ${owner}/${repo} (branch: ${b}) successfully`);
    });

    await this.updateRepoState(owner, repo, repoDir);
    return repoDir;
  }

  async ensureRepoFresh(
    installationId: string,
    owner: string,
    repo: string
  ): Promise<string> {
    const repoPath = this.repoPath(owner, repo);

    const [repoData] = await query<any[]>(
      `SELECT needs_refresh, default_branch FROM github_repositories 
       WHERE full_name = ?`,
      [`${owner}/${repo}`]
    );

    if (!repoData) {
      throw new Error('Repository not found in database');
    }

    const needsRefresh = repoData.needs_refresh || !fs.existsSync(repoPath);

    if (!needsRefresh) return repoPath;

    if (!fs.existsSync(repoPath)) {
      return await this.cloneRepository(installationId, owner, repo, repoData.default_branch);
    }
    return await this.pullRepository(installationId, owner, repo);
  }

  async getDirectoryContents(
    installationId: string,
    owner: string,
    repo: string,
    dirPath: string = ''
  ): Promise<any[]> {
    const repoPath = await this.ensureRepoFresh(installationId, owner, repo);
    const fullPath = path.join(repoPath, dirPath);

    if (!fs.existsSync(fullPath)) {
      throw new Error('Path does not exist');
    }

    const items = fs.readdirSync(fullPath, { withFileTypes: true });

    return items
      .filter(item => !item.name.startsWith('.'))
      .map(item => ({
        name: item.name,
        path: path.join(dirPath, item.name).replace(/\\/g, '/'),
        type: item.isDirectory() ? 'dir' : 'file',
        size: item.isFile() ? fs.statSync(path.join(fullPath, item.name)).size : null,
      }))
      .sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'dir' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
  }

  async getFileContents(
    installationId: string,
    owner: string,
    repo: string,
    filePath: string
  ): Promise<string> {
    const repoPath = await this.ensureRepoFresh(installationId, owner, repo);
    const fullPath = path.join(repoPath, filePath);

    if (!fs.existsSync(fullPath)) {
      throw new Error('File does not exist');
    }

    if (fs.statSync(fullPath).isDirectory()) {
      throw new Error('Path is a directory, not a file');
    }

    return fs.readFileSync(fullPath, 'utf-8');
  }

  async forceRefresh(installationId: string, owner: string, repo: string): Promise<void> {
    await query(
      `UPDATE github_repositories
       SET needs_refresh = true
       WHERE full_name = ?`,
      [`${owner}/${repo}`]
    );

    await this.ensureRepoFresh(installationId, owner, repo);
  }

  /**
   * Best-effort linker for local/dev setups where GitHub webhooks may not reach this app.
   * It discovers the personal installation for the current GitHub login and binds it to user_id.
   */
  async linkUserInstallation(userId: string, githubLogin: string): Promise<boolean> {
    try {
      const { data } = await this.app.apps.getUserInstallation({ username: githubLogin });
      const installation = data;
      const accountLogin = installation.account?.login;
      const accountType = installation.account?.type || 'User';
      const installationId = installation.id;

      if (!accountLogin || !installationId) return false;

      await query(
        `INSERT INTO github_installations
         (id, installation_id, account_login, account_type, user_id, suspended_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           account_login = VALUES(account_login),
           account_type = VALUES(account_type),
           suspended_at = VALUES(suspended_at),
           metadata = VALUES(metadata),
           user_id = IF(user_id IS NULL OR user_id = VALUES(user_id), VALUES(user_id), user_id)`,
        [
          uuidv4(),
          installationId,
          accountLogin,
          accountType,
          userId,
          installation.suspended_at ? new Date(installation.suspended_at) : null,
          JSON.stringify({ installation }),
        ]
      );

      return true;
    } catch (err: any) {
      if (err?.status === 404) {
        return false;
      }
      console.warn(`Failed to link installation for ${githubLogin}:`, err?.message || err);
      return false;
    }
  }

  /**
   * Sync all installations for a user against the GitHub API.
   * Removes installations that no longer exist on GitHub,
   * prunes repos that were removed, and adds any new ones.
   */
  async syncInstallations(userId: string): Promise<{ removed: number; added: number }> {
    const installations = await query<any[]>(
      `SELECT id, installation_id, account_login
       FROM github_installations
       WHERE user_id = ?`,
      [userId]
    );

    let totalRemoved = 0;
    let totalAdded = 0;

    for (const inst of installations) {
      const alive = await this.isInstallationAlive(inst.installation_id);

      if (!alive) {
        // Installation was deleted or app was uninstalled — purge from DB
        const deleted = await query<any>(
          'DELETE FROM github_repositories WHERE installation_id = ?',
          [inst.id]
        );
        totalRemoved += deleted.affectedRows ?? 0;

        await query(
          'DELETE FROM github_installations WHERE id = ?',
          [inst.id]
        );
        this.tokenCache.delete(inst.id);
        console.log(`Sync: removed dead installation ${inst.account_login} (${inst.installation_id})`);
        continue;
      }

      // Installation is alive — reconcile repos
      const result = await this.syncReposForInstallation(inst.id, inst.installation_id);
      totalRemoved += result.removed;
      totalAdded += result.added;
    }

    return { removed: totalRemoved, added: totalAdded };
  }

  private async isInstallationAlive(githubInstallationId: number): Promise<boolean> {
    try {
      await this.app.apps.getInstallation({ installation_id: githubInstallationId });
      return true;
    } catch (err: any) {
      // 404 = deleted, 403 = app itself was deleted
      if (err.status === 404 || err.status === 403) {
        return false;
      }
      // Unknown error — assume alive to avoid accidental data loss
      console.error(`Sync: unexpected error checking installation ${githubInstallationId}:`, err.message);
      return true;
    }
  }

  private async syncReposForInstallation(
    internalId: string,
    githubInstallationId: number,
  ): Promise<{ removed: number; added: number }> {
    let token: string;
    try {
      token = await this.getInstallationToken(internalId);
    } catch {
      // Can't get token (suspended, etc.) — skip reconciliation
      return { removed: 0, added: 0 };
    }

    const octokit = new Octokit({ auth: token });

    // Fetch all repos the installation currently has access to
    let liveRepos: { id: number; full_name: string; private: boolean; default_branch: string }[];
    try {
      const pages = await octokit.paginate(
        octokit.apps.listReposAccessibleToInstallation,
        { per_page: 100 },
      );
      liveRepos = (pages as any[]).map((r: any) => ({
        id: r.id,
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch || 'main',
      }));
    } catch (err: any) {
      console.error(`Sync: failed to list repos for installation ${internalId}:`, err.message);
      return { removed: 0, added: 0 };
    }

    const liveRepoIds = new Set(liveRepos.map(r => r.id));

    // Get what we have in DB
    const dbRepos = await query<any[]>(
      'SELECT id, github_repo_id FROM github_repositories WHERE installation_id = ?',
      [internalId]
    );
    const dbRepoIds = new Set(dbRepos.map((r: any) => r.github_repo_id));

    // Remove repos that no longer exist on GitHub
    let removed = 0;
    for (const dbRepo of dbRepos) {
      if (!liveRepoIds.has(dbRepo.github_repo_id)) {
        await query('DELETE FROM github_repositories WHERE id = ?', [dbRepo.id]);
        removed++;
      }
    }

    // Add repos that exist on GitHub but not in DB (skip ones the user has explicitly hidden)
    const hiddenRepoIds = new Set(
      (await query<any[]>(
        'SELECT github_repo_id FROM github_repositories WHERE installation_id = ? AND user_hidden = true',
        [internalId]
      )).map((r: any) => r.github_repo_id)
    );

    let added = 0;
    for (const liveRepo of liveRepos) {
      if (!dbRepoIds.has(liveRepo.id) && !hiddenRepoIds.has(liveRepo.id)) {
        await query(
          `INSERT INTO github_repositories
           (id, installation_id, github_repo_id, full_name, is_private, default_branch)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
           full_name = VALUES(full_name),
           default_branch = VALUES(default_branch)`,
          [uuidv4(), internalId, liveRepo.id, liveRepo.full_name, liveRepo.private, liveRepo.default_branch]
        );
        added++;
      }
    }

    if (removed > 0 || added > 0) {
      console.log(`Sync: installation ${internalId}: removed ${removed}, added ${added} repos`);
    }

    return { removed, added };
  }

}

export const githubService = new GitHubService({
  appId: requireEnv('GITHUB_APP_ID'),
  privateKey: requireEnv('GITHUB_PRIVATE_KEY'),
  webhookSecret: requireEnv('GITHUB_WEBHOOK_SECRET'),
});
