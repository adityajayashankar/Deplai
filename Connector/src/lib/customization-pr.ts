import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { githubService } from './github';
import { resolveProjectMeta } from './project-meta';
import {
  resolveCustomizationSnapshot,
  type CustomizationSnapshotFileChange,
  type CustomizationSnapshotSource,
} from './customization-snapshot';

export const MAX_CUSTOMIZATION_PR_FILES = 200;
export const MAX_CUSTOMIZATION_PR_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_CUSTOMIZATION_PR_TOTAL_BYTES = 25 * 1024 * 1024;

const GIT_BLOB_CONCURRENCY = 8;

export interface CustomizationPrResult {
  attempted: boolean;
  success: boolean;
  pr_url: string | null;
  branch: string | null;
  reason?: string;
  error?: string;
  files_committed?: number;
}

export interface PreparedSnapshotChange {
  path: string;
  status: CustomizationSnapshotFileChange['status'];
  baseSha256: string | null;
  content: Buffer | null;
  mode: '100644' | '100755' | '120000';
}

interface GitTreeEntry {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string | null;
  size?: number;
}

export class CustomizationPrError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = 'customization_pr_invalid') {
    super(message);
    this.name = 'CustomizationPrError';
    this.status = status;
    this.code = code;
  }
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function customizationBranchBase(snapshotId: string): string {
  const safeSnapshotId = snapshotId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!safeSnapshotId) {
    throw new CustomizationPrError('Snapshot ID cannot be used in a Git branch name.');
  }
  return `deplai/customization-${safeSnapshotId.slice(0, 64)}`;
}

export function validateSnapshotChangeCount(
  changedFileHashes: Record<string, CustomizationSnapshotFileChange>,
): Array<[string, CustomizationSnapshotFileChange]> {
  const entries = Object.entries(changedFileHashes);
  if (entries.length > MAX_CUSTOMIZATION_PR_FILES) {
    throw new CustomizationPrError(
      `Customization PRs support at most ${MAX_CUSTOMIZATION_PR_FILES} changed files; this snapshot has ${entries.length}.`,
      413,
      'too_many_files',
    );
  }
  return entries;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function prepareSnapshotChanges(
  snapshot: CustomizationSnapshotSource,
): Promise<PreparedSnapshotChange[]> {
  const entries = validateSnapshotChangeCount(snapshot.changed_file_hashes);
  let totalBytes = 0;

  return mapWithConcurrency(entries, GIT_BLOB_CONCURRENCY, async ([filePath, change]) => {
    if (change.status === 'deleted') {
      return {
        path: filePath,
        status: change.status,
        baseSha256: change.base_sha256,
        content: null,
        mode: '100644',
      };
    }

    const absolutePath = path.resolve(snapshot.snapshot_path, ...filePath.split('/'));
    if (!isWithin(snapshot.snapshot_path, absolutePath)) {
      throw new CustomizationPrError(`Snapshot path is unsafe: ${filePath}`, 409, 'unsafe_snapshot_path');
    }

    let fileStat;
    try {
      fileStat = await fs.lstat(absolutePath);
    } catch {
      throw new CustomizationPrError(
        `Snapshot file is missing: ${filePath}`,
        409,
        'snapshot_file_missing',
      );
    }

    let content: Buffer;
    let mode: PreparedSnapshotChange['mode'];
    let actualHash: string;
    if (fileStat.isSymbolicLink()) {
      const target = await fs.readlink(absolutePath);
      const resolvedTarget = path.resolve(path.dirname(absolutePath), target);
      if (path.isAbsolute(target) || !isWithin(snapshot.snapshot_path, resolvedTarget)) {
        throw new CustomizationPrError(
          `Snapshot symlink points outside the snapshot: ${filePath}`,
          409,
          'unsafe_snapshot_symlink',
        );
      }
      content = Buffer.from(target, 'utf8');
      actualHash = sha256(`symlink:${target}`);
      mode = '120000';
    } else if (fileStat.isFile()) {
      if (fileStat.size > MAX_CUSTOMIZATION_PR_FILE_BYTES) {
        throw new CustomizationPrError(
          `${filePath} exceeds the ${MAX_CUSTOMIZATION_PR_FILE_BYTES} byte per-file PR limit.`,
          413,
          'file_too_large',
        );
      }
      content = await fs.readFile(absolutePath);
      actualHash = sha256(content);
      mode = (fileStat.mode & 0o111) !== 0 ? '100755' : '100644';
    } else {
      throw new CustomizationPrError(
        `Snapshot change is not a file or safe symlink: ${filePath}`,
        409,
        'unsupported_snapshot_entry',
      );
    }

    if (content.byteLength > MAX_CUSTOMIZATION_PR_FILE_BYTES) {
      throw new CustomizationPrError(
        `${filePath} exceeds the ${MAX_CUSTOMIZATION_PR_FILE_BYTES} byte per-file PR limit.`,
        413,
        'file_too_large',
      );
    }
    totalBytes += content.byteLength;
    if (totalBytes > MAX_CUSTOMIZATION_PR_TOTAL_BYTES) {
      throw new CustomizationPrError(
        `Snapshot changes exceed the ${MAX_CUSTOMIZATION_PR_TOTAL_BYTES} byte total PR limit.`,
        413,
        'total_size_too_large',
      );
    }
    if (actualHash !== change.sha256) {
      throw new CustomizationPrError(
        `Snapshot integrity check failed for ${filePath}.`,
        409,
        'snapshot_hash_mismatch',
      );
    }

    return {
      path: filePath,
      status: change.status,
      baseSha256: change.base_sha256,
      content,
      mode,
    };
  });
}

function decodeGitBlob(content: string): Buffer {
  return Buffer.from(content.replace(/\s/g, ''), 'base64');
}

async function verifyDefaultBranchHasNotDrifted(params: {
  octokit: Awaited<ReturnType<typeof githubService.getInstallationClient>>;
  owner: string;
  repo: string;
  baseTreeSha: string;
  changes: PreparedSnapshotChange[];
}): Promise<void> {
  const treeResponse = await params.octokit.git.getTree({
    owner: params.owner,
    repo: params.repo,
    tree_sha: params.baseTreeSha,
    recursive: 'true',
  });
  if (treeResponse.data.truncated) {
    throw new CustomizationPrError(
      'The default branch tree is too large to validate customization changes safely.',
      409,
      'default_tree_too_large',
    );
  }

  const treeByPath = new Map<string, GitTreeEntry>();
  for (const entry of treeResponse.data.tree) {
    const entryPath = String(entry.path || '').trim();
    if (!entryPath) continue;
    treeByPath.set(entryPath, entry);
  }

  await mapWithConcurrency(params.changes, GIT_BLOB_CONCURRENCY, async (change) => {
    const baseEntry = treeByPath.get(change.path);
    if (change.status === 'added') {
      if (baseEntry) {
        throw new CustomizationPrError(
          `The default branch now contains ${change.path}; recreate the snapshot before opening a PR.`,
          409,
          'default_branch_drift',
        );
      }
      return;
    }

    if (!baseEntry?.sha || baseEntry.type !== 'blob') {
      throw new CustomizationPrError(
        `The default branch changed at ${change.path}; recreate the snapshot before opening a PR.`,
        409,
        'default_branch_drift',
      );
    }
    if (Number(baseEntry.size || 0) > MAX_CUSTOMIZATION_PR_FILE_BYTES) {
      throw new CustomizationPrError(
        `${change.path} exceeds the safe base-file verification limit.`,
        413,
        'base_file_too_large',
      );
    }

    const blob = await params.octokit.git.getBlob({
      owner: params.owner,
      repo: params.repo,
      file_sha: baseEntry.sha,
    });
    const raw = decodeGitBlob(blob.data.content);
    const currentHash = baseEntry.mode === '120000'
      ? sha256(`symlink:${raw.toString('utf8')}`)
      : sha256(raw);
    if (currentHash !== change.baseSha256) {
      throw new CustomizationPrError(
        `The default branch changed at ${change.path}; recreate the snapshot before opening a PR.`,
        409,
        'default_branch_drift',
      );
    }
  });
}

function isReferenceCollision(error: unknown): boolean {
  const candidate = error as { status?: number; message?: string };
  return candidate?.status === 422 && /reference already exists/i.test(String(candidate.message || ''));
}

export async function createCustomizationSnapshotPr(params: {
  userId: string;
  projectId: string;
  tenantId: string;
  snapshotId: string;
}): Promise<CustomizationPrResult> {
  const snapshot = await resolveCustomizationSnapshot(params);
  const meta = await resolveProjectMeta(params.userId, params.projectId);
  if (!meta) {
    return {
      attempted: false,
      success: false,
      pr_url: null,
      branch: null,
      reason: 'project_metadata_unavailable',
    };
  }
  if (meta.project_type !== 'github') {
    return {
      attempted: false,
      success: false,
      pr_url: null,
      branch: null,
      reason: 'local_project',
    };
  }
  if (!meta.repo_full_name || !meta.installation_uuid) {
    return {
      attempted: false,
      success: false,
      pr_url: null,
      branch: null,
      reason: 'missing_repo_metadata',
    };
  }

  const changes = await prepareSnapshotChanges(snapshot);
  if (changes.length === 0) {
    return {
      attempted: false,
      success: false,
      pr_url: null,
      branch: null,
      reason: 'no_snapshot_changes',
    };
  }

  const [owner, repo] = meta.repo_full_name.split('/');
  if (!owner || !repo) {
    return {
      attempted: false,
      success: false,
      pr_url: null,
      branch: null,
      reason: 'invalid_repo_name',
    };
  }

  let branch: string | null = null;
  try {
    const octokit = await githubService.getInstallationClient(meta.installation_uuid);
    const repository = await octokit.repos.get({ owner, repo });
    const baseBranch = String(repository.data.default_branch || '').trim();
    if (!baseBranch) {
      throw new CustomizationPrError(
        'The GitHub repository does not have a default branch.',
        409,
        'missing_default_branch',
      );
    }

    const baseRef = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`,
    });
    const baseCommitSha = baseRef.data.object.sha;
    const baseCommit = await octokit.git.getCommit({
      owner,
      repo,
      commit_sha: baseCommitSha,
    });
    await verifyDefaultBranchHasNotDrifted({
      octokit,
      owner,
      repo,
      baseTreeSha: baseCommit.data.tree.sha,
      changes,
    });

    const treeEntries = await mapWithConcurrency(changes, GIT_BLOB_CONCURRENCY, async (change) => {
      if (change.status === 'deleted') {
        return {
          path: change.path,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: null,
        };
      }
      const blob = await octokit.git.createBlob({
        owner,
        repo,
        content: change.content!.toString('base64'),
        encoding: 'base64',
      });
      return {
        path: change.path,
        mode: change.mode,
        type: 'blob' as const,
        sha: blob.data.sha,
      };
    });

    const tree = await octokit.git.createTree({
      owner,
      repo,
      base_tree: baseCommit.data.tree.sha,
      tree: treeEntries,
    });
    const commit = await octokit.git.createCommit({
      owner,
      repo,
      message: `feat: apply DeplAI customization ${snapshot.snapshot_id}`,
      tree: tree.data.sha,
      parents: [baseCommitSha],
    });

    const branchBase = customizationBranchBase(snapshot.snapshot_id);
    for (let attempt = 0; attempt < 5 && !branch; attempt += 1) {
      const candidate = attempt === 0 ? branchBase : `${branchBase}-${attempt}`;
      try {
        await octokit.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${candidate}`,
          sha: commit.data.sha,
        });
        branch = candidate;
      } catch (error) {
        if (!isReferenceCollision(error)) throw error;
      }
    }
    if (!branch) {
      throw new CustomizationPrError(
        'Could not allocate a unique customization branch name.',
        409,
        'branch_name_exhausted',
      );
    }

    const pull = await octokit.pulls.create({
      owner,
      repo,
      base: baseBranch,
      head: branch,
      title: `feat: apply DeplAI customization for ${repo}`,
      body: [
        'This pull request was generated from an immutable DeplAI customization snapshot.',
        '',
        `Snapshot: \`${snapshot.snapshot_id}\``,
        `Source tree: \`${snapshot.source_tree_hash}\``,
        `Changed files: ${changes.length}`,
        '',
        'Review and merge this PR independently of the security and deployment handoff.',
      ].join('\n'),
      maintainer_can_modify: true,
    });

    return {
      attempted: true,
      success: true,
      pr_url: pull.data.html_url || null,
      branch,
      files_committed: changes.length,
    };
  } catch (error) {
    if (error instanceof CustomizationPrError) throw error;
    return {
      attempted: true,
      success: false,
      pr_url: null,
      branch,
      reason: 'github_pr_failed',
      error: error instanceof Error ? error.message : 'GitHub PR creation failed.',
    };
  }
}
