import test from 'node:test';
import assert from 'node:assert/strict';
import { indexGitSource } from './git-source-index';

test('indexes repositories beyond former file and byte limits without downloading blobs', async () => {
  const files = await indexGitSource('root', async () => ({ tree: Array.from({ length: 5000 }, (_, index) => ({ path: `src/component-${index}.tsx`, mode: '100644', type: 'blob', size: 500_000, sha: String(index) })) }));
  assert.equal(files.length, 5000);
  assert.equal(files.at(-1)?.path, 'src/component-4999.tsx');
  assert.ok(files.every(file => file.loaded === false && file.content === ''));
});
test('walks complete subtrees when GitHub truncates the recursive index', async () => {
  const calls: [string, boolean][] = [];
  const files = await indexGitSource('root', async (sha, recursive) => {
    calls.push([sha, recursive]);
    if (recursive) return { truncated: true, tree: [{ path: 'ignored.tsx', type: 'blob', mode: '100644' }] };
    if (sha === 'root') return { tree: [{ path: 'src', type: 'tree', sha: 'nested' }] };
    return { tree: [{ path: 'page.tsx', type: 'blob', mode: '100644', sha: 'page' }, { path: '.env', type: 'blob', mode: '100644' }, { path: 'link.tsx', type: 'blob', mode: '120000' }] };
  });
  assert.deepEqual(files.map(file => file.path), ['src/page.tsx']);
  assert.deepEqual(calls, [['root', true], ['root', false], ['nested', false]]);
});
