import test from 'node:test';
import assert from 'node:assert/strict';
import type { Snapshot } from './snapshots';
import { applyUiuxChanges, createUiuxPullRequest, uiuxBlobSha, type UiuxPullRequestClient } from './pull-request';

const source = 'a'.repeat(40);
const snapshot: Snapshot = { project: { id: 'p', name: 'example', type: 'github', owner: 'owner', repo: 'repo', branch: 'main' }, source_sha: source, tree_sha: 'base-tree', installation_uuid: 'installation', files: [{ path: 'src/style.css', content: '.card { color: black; }' }], warnings: [] };
const run = { run_id: 'run-123', prompt: 'Use warmer colors', changes: [{ path: 'src/style.css', before: snapshot.files[0].content, after: '.card { color: brown; }' }] };
function mock(options: { advanced?: boolean; hostile?: boolean; losePrResponse?: boolean; truncated?: boolean } = {}) {
  const writes: { kind: string; input: Record<string, unknown> }[] = [];
  let branchExists = Boolean(options.hostile);
  let prExists = false;
  const pr = { html_url: 'https://github.com/owner/repo/pull/1', head: { sha: 'proposal', ref: 'deplai/uiux-run-123', repo: { full_name: 'owner/repo' } }, base: { ref: 'main' } };
  const fake = {
    git: {
      getRef: async (input: { ref: string }) => { if (input.ref === 'heads/main') return { data: { object: { sha: options.advanced ? 'b'.repeat(40) : source } } }; if (!branchExists) throw { status: 404 }; return { data: { object: { sha: 'proposal' } } }; },
      getCommit: async (input: { commit_sha: string }) => ({ data: input.commit_sha === source ? { tree: { sha: 'base-tree' }, parents: [] } : { tree: { sha: options.hostile ? 'hostile-tree' : 'expected-tree' }, parents: [{ sha: source }] } }),
      getTree: async (input: { tree_sha: string; recursive?: string }) => ({ data: options.truncated && input.recursive ? { truncated: true, tree: [] } : options.truncated && input.tree_sha === 'base-tree' ? { truncated: false, tree: [{ path: 'src', type: 'tree', mode: '040000', sha: 'src-tree' }] } : { truncated: false, tree: [{ path: options.truncated ? 'style.css' : 'src/style.css', type: 'blob', mode: '100755', sha: uiuxBlobSha(snapshot.files[0].content) }] } }),
      createTree: async (input: Record<string, unknown>) => { writes.push({ kind: 'tree', input }); return { data: { sha: 'expected-tree' } }; },
      createCommit: async (input: Record<string, unknown>) => { writes.push({ kind: 'commit', input }); return { data: { sha: 'proposal' } }; },
      createRef: async (input: Record<string, unknown>) => { writes.push({ kind: 'ref', input }); branchExists = true; return { data: {} }; },
      updateRef: async (input: Record<string, unknown>) => { writes.push({ kind: 'update-ref', input }); return { data: {} }; },
    },
    pulls: {
      list: async () => ({ data: prExists ? [pr] : [] }),
      create: async (input: Record<string, unknown>) => { writes.push({ kind: 'pr', input }); prExists = true; if (options.losePrResponse) throw { status: 502 }; return { data: pr }; },
    },
  };
  return { client: fake as unknown as UiuxPullRequestClient, writes };
}
test('publishes one atomic draft preserving base tree, parent, and file modes; retries reuse PR', async () => {
  const { client, writes } = mock();
  const result = await createUiuxPullRequest(snapshot, run, client);
  assert.equal(result.url, 'https://github.com/owner/repo/pull/1');
  const tree = writes.find(write => write.kind === 'tree')!.input;
  assert.equal(tree.base_tree, 'base-tree');
  assert.equal((tree.tree as { mode: string }[])[0].mode, '100755');
  assert.deepEqual(writes.find(write => write.kind === 'commit')!.input.parents, [source]);
  assert.equal(writes.find(write => write.kind === 'pr')!.input.draft, true);
  assert.match(String(writes.find(write => write.kind === 'pr')!.input.body), /No repository build/);
  const retry = await createUiuxPullRequest(snapshot, run, client);
  assert.equal(retry.existing, true);
  assert.equal(writes.filter(write => write.kind === 'commit').length, 1);
  assert.equal(writes.filter(write => write.kind === 'ref').length, 1);
  assert.equal(writes.filter(write => write.kind === 'pr').length, 1);
});
test('applies one reviewed presentation commit to the unchanged base branch without force', async () => {
  const { client, writes } = mock();
  const result = await applyUiuxChanges(snapshot, run, client);
  assert.equal(result.branch, 'main');
  assert.equal(result.commit, 'proposal');
  const update = writes.find(write => write.kind === 'update-ref')!.input;
  assert.equal(update.ref, 'heads/main');
  assert.equal(update.force, false);
  assert.deepEqual(writes.find(write => write.kind === 'commit')!.input.parents, [source]);
  assert.equal(writes.some(write => write.kind === 'pr'), false);
});
test('rejects stale base before any writes', async () => {
  const { client, writes } = mock({ advanced: true });
  await assert.rejects(createUiuxPullRequest(snapshot, run, client), /branch advanced/);
  assert.equal(writes.length, 0);
});
test('publishes from a large truncated GitHub tree by verifying changed subtrees', async () => {
  const { client, writes } = mock({ truncated: true });
  assert.equal((await createUiuxPullRequest(snapshot, run, client)).url, 'https://github.com/owner/repo/pull/1');
  assert.equal(writes.filter(write => write.kind === 'pr').length, 1);
});
test('rejects forged baseline and protected edits before writes', async () => {
  const { client, writes } = mock();
  await assert.rejects(createUiuxPullRequest(snapshot, { ...run, changes: [{ ...run.changes[0], before: 'forged' }] }, client), /source snapshot/);
  await assert.rejects(createUiuxPullRequest(snapshot, { ...run, changes: [{ path: 'server/auth.ts', before: 'a', after: 'b' }] }, client), /outside the editable/);
  await assert.rejects(createUiuxPullRequest(snapshot, { ...run, changes: [run.changes[0], run.changes[0]] }, client), /duplicate/);
  assert.equal(writes.length, 0);
});
test('never overwrites a preexisting hostile proposal branch', async () => {
  const { client, writes } = mock({ hostile: true });
  await assert.rejects(createUiuxPullRequest(snapshot, run, client), /different changes/);
  assert.deepEqual(writes.map(write => write.kind), ['tree']);
});
test('recovers after GitHub created a PR but its response was lost', async () => {
  const { client, writes } = mock({ losePrResponse: true });
  await assert.rejects(createUiuxPullRequest(snapshot, run, client));
  assert.equal((await createUiuxPullRequest(snapshot, run, client)).existing, true);
  assert.equal(writes.filter(write => write.kind === 'pr').length, 1);
});
