import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import type { Snapshot } from './snapshots';
import { validatePresentationChanges, type PresentationChange } from './presentation-policy';

type RunProposal = { run_id: string; prompt?: string; summary?: string; changes: PresentationChange[] };
export type UiuxPullRequestClient = {
  git: Pick<Octokit['git'], 'getRef' | 'getCommit' | 'getTree' | 'createTree' | 'createCommit' | 'createRef' | 'updateRef'>;
  pulls: Pick<Octokit['pulls'], 'list' | 'create'>;
};
export class UiuxPullRequestError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
function statusOf(error: unknown) { return (error as { status?: number })?.status; }
export function uiuxBlobSha(content: string) {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Applies a reviewed UI-only proposal to the currently reviewed branch. */
export async function applyUiuxChanges(snapshot: Snapshot, run: RunProposal, suppliedClient?: UiuxPullRequestClient): Promise<{ branch: string; commit: string }> {
  const { owner, repo, branch } = snapshot.project;
  if (snapshot.project.type !== 'github' || !owner || !repo || !branch || !snapshot.installation_uuid) throw new UiuxPullRequestError('Connect a GitHub repository to apply changes. Local projects can download a patch.', 400);
  if (!/^[a-f0-9]{40}$/i.test(snapshot.source_sha)) throw new UiuxPullRequestError('The source snapshot has no valid Git commit.', 400);
  const validation = validatePresentationChanges(run.changes);
  if (!validation.ok) throw new UiuxPullRequestError(validation.conflicts.join('\n'));
  for (const change of run.changes) {
    const original = snapshot.files.find(file => file.path === change.path);
    if (typeof change.before !== 'string' || typeof change.after !== 'string' || !original || original.content !== change.before || change.before === change.after) throw new UiuxPullRequestError(`${change.path}: proposal does not match the reviewed source snapshot.`);
  }
  let client = suppliedClient;
  if (!client) {
    const { githubService } = await import('@/lib/github');
    client = new Octokit({ auth: await githubService.getInstallationTokenForRemediation(snapshot.installation_uuid) });
  }
  const github = client;
  const repository = { owner, repo };
  const current = await github.git.getRef({ ...repository, ref: `heads/${branch}` });
  if (current.data.object.sha !== snapshot.source_sha) throw new UiuxPullRequestError('The repository branch advanced after this design task. Start a new task against the latest source before applying changes.');
  const sourceCommit = (await github.git.getCommit({ ...repository, commit_sha: snapshot.source_sha })).data;
  if (snapshot.tree_sha && sourceCommit.tree.sha !== snapshot.tree_sha) throw new UiuxPullRequestError('Source tree does not match the reviewed snapshot.');
  const sourceTree = (await github.git.getTree({ ...repository, tree_sha: sourceCommit.tree.sha, recursive: 'true' })).data;
  if (sourceTree.truncated) throw new UiuxPullRequestError('GitHub returned an incomplete repository tree. Create a PR instead, or retry applying changes.');
  const entries = run.changes.map(change => {
    const entry = sourceTree.tree.find(item => item.path === change.path);
    if (typeof change.before !== 'string' || typeof change.after !== 'string' || !entry || entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755') || entry.sha !== uiuxBlobSha(change.before)) throw new UiuxPullRequestError(`${change.path}: Git source differs from the reviewed baseline or is not a regular file.`);
    return { path: change.path, type: 'blob' as const, mode: entry.mode as '100644' | '100755', content: change.after };
  });
  const tree = await github.git.createTree({ ...repository, base_tree: sourceCommit.tree.sha, tree: entries });
  const commit = await github.git.createCommit({ ...repository, message: `UI/UX presentation update (${run.run_id})`, tree: tree.data.sha, parents: [snapshot.source_sha] });
  const finalRef = await github.git.getRef({ ...repository, ref: `heads/${branch}` });
  if (finalRef.data.object.sha !== snapshot.source_sha) throw new UiuxPullRequestError('The repository branch advanced while preparing this change. It was not applied.');
  try {
    await github.git.updateRef({ ...repository, ref: `heads/${branch}`, sha: commit.data.sha, force: false });
  } catch (error) {
    if (statusOf(error) === 422) throw new UiuxPullRequestError('GitHub rejected the branch update because it advanced. The change was not applied.');
    throw error;
  }
  return { branch, commit: commit.data.sha };
}

/** Publishes a reviewed proposal without writing to an existing branch or running repository code. */
export async function createUiuxPullRequest(snapshot: Snapshot, run: RunProposal, suppliedClient?: UiuxPullRequestClient): Promise<{ url: string; branch: string; existing?: boolean }> {
  const { owner, repo, branch: base } = snapshot.project;
  if (snapshot.project.type !== 'github' || !owner || !repo || !base || !snapshot.installation_uuid) throw new UiuxPullRequestError('Connect a GitHub repository to create a pull request. Local projects can download a patch.', 400);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(run.run_id)) throw new UiuxPullRequestError('Invalid UI/UX run identifier.', 400);
  if (!/^[a-f0-9]{40}$/i.test(snapshot.source_sha)) throw new UiuxPullRequestError('The source snapshot has no valid Git commit.', 400);
  const validation = validatePresentationChanges(run.changes);
  if (!validation.ok) throw new UiuxPullRequestError(validation.conflicts.join('\n'));
  for (const change of run.changes) {
    const original = snapshot.files.find(file => file.path === change.path);
    if (!original || original.content !== change.before) throw new UiuxPullRequestError(`${change.path}: proposal does not match the reviewed source snapshot.`);
    if (change.before === change.after) throw new UiuxPullRequestError(`${change.path}: proposal contains an unchanged file.`);
  }
  let client = suppliedClient;
  if (!client) {
    const { githubService } = await import('@/lib/github');
    const token = await githubService.getInstallationTokenForRemediation(snapshot.installation_uuid);
    client = new Octokit({ auth: token });
  }
  const github = client;
  const repository = { owner, repo };
  const branch = `deplai/uiux-${run.run_id}`;
  async function verifyBase() {
    const ref = await github.git.getRef({ ...repository, ref: `heads/${base}` });
    if (ref.data.object.sha !== snapshot.source_sha) throw new UiuxPullRequestError('The repository branch advanced after this design task. Start a new task against the latest source before creating a pull request.');
  }
  await verifyBase();
  const sourceCommit = (await github.git.getCommit({ ...repository, commit_sha: snapshot.source_sha })).data;
  if (snapshot.tree_sha && sourceCommit.tree.sha !== snapshot.tree_sha) throw new UiuxPullRequestError('Source tree does not match the reviewed snapshot.');
  const sourceTree = (await github.git.getTree({ ...repository, tree_sha: sourceCommit.tree.sha, recursive: 'true' })).data;
  const trees = new Map<string, typeof sourceTree>();
  async function findSourceEntry(name: string) {
    if (!sourceTree.truncated) return sourceTree.tree.find(item => item.path === name);
    // Verify only changed paths when GitHub truncates a large recursive tree.
    let treeSha = sourceCommit.tree.sha;
    const parts = name.split('/');
    for (let index = 0; index < parts.length; index++) {
      if (!trees.has(treeSha)) trees.set(treeSha, (await github.git.getTree({ ...repository, tree_sha: treeSha })).data);
      const tree = trees.get(treeSha)!;
      if (tree.truncated) throw new UiuxPullRequestError('GitHub returned an incomplete directory. Retry publication.');
      const entry = tree.tree.find(item => item.path === parts[index]);
      if (index === parts.length - 1) return entry;
      if (entry?.type !== 'tree' || !entry.sha) return undefined;
      treeSha = entry.sha;
    }
  }
  const entries = [];
  for (const change of run.changes) {
    const entry = await findSourceEntry(change.path);
    if (!entry || entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755') || entry.sha !== uiuxBlobSha(change.before!)) {
      throw new UiuxPullRequestError(`${change.path}: Git source differs from the reviewed baseline or is not a regular file.`);
    }
    entries.push({ path: change.path, type: 'blob' as const, mode: entry.mode as '100644' | '100755', content: change.after! });
  }
  // Reusing the immutable base tree preserves every unmodified file, including
  // files intentionally omitted from model context. Tree creation is content-addressed.
  const expectedTree = (await github.git.createTree({ ...repository, base_tree: sourceCommit.tree.sha, tree: entries })).data.sha;
  async function verifyBranch(): Promise<string | null> {
    let sha: string;
    try { sha = (await github.git.getRef({ ...repository, ref: `heads/${branch}` })).data.object.sha; }
    catch (error) { if (statusOf(error) === 404) return null; throw error; }
    const commit = (await github.git.getCommit({ ...repository, commit_sha: sha })).data;
    if (commit.tree.sha !== expectedTree || commit.parents.length !== 1 || commit.parents[0].sha !== snapshot.source_sha) {
      throw new UiuxPullRequestError('The proposed branch already exists with different changes. It will not be overwritten.');
    }
    return sha;
  }
  let proposalSha = await verifyBranch();
  if (!proposalSha) {
    const commit = await github.git.createCommit({ ...repository, message: `UI/UX presentation update (${run.run_id})`, tree: expectedTree, parents: [snapshot.source_sha] });
    await verifyBase();
    try { await github.git.createRef({ ...repository, ref: `refs/heads/${branch}`, sha: commit.data.sha }); }
    catch (error) { if (statusOf(error) !== 422) throw error; } // Concurrent retry must pass the same branch verification.
    proposalSha = await verifyBranch();
    if (!proposalSha) throw new UiuxPullRequestError('Could not create the proposal branch. Retry creating the pull request.');
  }
  async function existingPr() {
    const result = await github.pulls.list({ ...repository, head: `${owner}:${branch}`, base, state: 'all', per_page: 100 });
    const existing = result.data.find(pr => pr.head.sha === proposalSha && pr.head.ref === branch && pr.base.ref === base && pr.head.repo?.full_name.toLowerCase() === `${owner}/${repo}`.toLowerCase());
    return existing ? { url: existing.html_url, branch, existing: true as const } : null;
  }
  const existing = await existingPr();
  if (existing) return existing;
  await verifyBase();
  if (await verifyBranch() !== proposalSha) throw new UiuxPullRequestError('The proposal branch changed before publication. Retry to verify it again.');
  const quote = (text: string) => text.replace(/@/g, '@\u200b').split('\n').map(line => `> ${line}`).join('\n');
  const body = [
    'This draft proposes presentation changes for review.',
    run.prompt ? `Requested change:\n${quote(run.prompt.slice(0, 6000))}` : '',
    run.summary ? `Agent summary:\n${quote(run.summary.slice(0, 6000))}` : '',
    `Source commit: \`${snapshot.source_sha}\`\nRun: \`${run.run_id}\``,
    `Changed files:\n${run.changes.map(change => `- \`${change.path.replace(/`/g, '')}\``).join('\n')}`,
    'Validation: presentation policy and source snapshot checks passed. No repository build, application tests, or live visual preview were executed. Review accessibility, layout, and behavior before merging.',
  ].filter(Boolean).join('\n\n');
  try {
    const result = await github.pulls.create({ ...repository, base, head: branch, title: `UI/UX: ${snapshot.project.name.slice(0, 100)}`, body, draft: true, maintainer_can_modify: false });
    return { url: result.data.html_url, branch };
  } catch (error) {
    if (statusOf(error) === 422) { const retried = await existingPr(); if (retried) return retried; }
    throw error;
  }
}
