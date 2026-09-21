import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { readGit, readZip, repositoryMap, safeImportPath, validateGitSource, materializeImport, type GitReader } from './ingestion';
import { githubReader } from './github-ingestion';
import { createImportService } from './import-service';

const scope = { owner_user_id: 'u', organization_id: 'o', project_id: 'p', session_id: 's' };
const source = { url: 'https://github.com/example/application.git', ref: 'feature/one' };
function gitFixture(): { reader: GitReader; bytes: Buffer } {
  const bytes = Buffer.from('{"scripts":{"postinstall":"do-not-run"}}\r\n');
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  return { bytes, reader: { resolve: async s => { assert.equal(s.ref, 'feature/one'); return { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }; }, tree: async () => [{ path: 'apps/web/package.json', sha, type: 'blob', mode: '100644', size: bytes.length }], blob: async () => bytes } };
}
test('normal Git/ref import pins SHA and preserves bytes including scripts without executing them', async () => {
  const f = gitFixture(); const imported = await readGit(source, f.reader);
  assert.equal(imported.resolved.commit, 'a'.repeat(40)); assert.deepEqual(imported.files[0].bytes, f.bytes);
  const base = await mkdtemp(path.join(os.tmpdir(), 'build-import-test-'));
  try {
    const result = await materializeImport(base, scope, imported.files, { type: 'GIT', original: source, resolved: imported.resolved });
    assert.deepEqual(await readFile(path.join(base, result.importId, 'source/apps/web/package.json')), f.bytes);
    assert.equal(result.metadata.architecture_policy, 'PRESERVE_EXISTING'); assert.equal(result.metadata.ref, source.ref);
    assert.deepEqual(result.map.manifests, ['apps/web/package.json']);
    assert.equal(JSON.stringify(result).includes('do-not-run'), false);
  } finally { await rm(base, { recursive: true, force: true }); }
});
test('malformed URL, credential URL, alternate protocol and invalid ref are rejected', () => {
  for (const url of ['bad', 'file:///tmp/repo', 'https://127.0.0.1/a/b', 'https://token@github.com/a/b', 'https://github.com/a/b?token=x', 'ssh://github.com/a/b']) assert.throws(() => validateGitSource({ url, ref: 'main' }));
  for (const ref of ['--upload-pack=evil', 'main..other', 'main\ncmd', 'branch@{1}']) assert.throws(() => validateGitSource({ ...source, ref }));
});
test('ZIP monorepo produces deterministic names-only map and preserves original paths/bytes', () => {
  const zip = new AdmZip();
  for (const name of ['apps/web/package.json', 'apps/api/pyproject.toml', 'apps/api/migrations/01.sql', 'apps/web/src/index.ts', 'apps/web/tests/a.ts', '.github/workflows/test.yml', '.env.example', 'Dockerfile', 'pnpm-lock.yaml']) zip.addFile(name, Buffer.from('fixture\r\n'));
  const files = readZip(zip.toBuffer()); const map = repositoryMap(files);
  assert.equal(files.length, 9); assert.ok(files.every(f => f.bytes.equals(Buffer.from('fixture\r\n'))));
  assert.deepEqual(map.env_templates, ['.env.example']); assert.equal(map.manifests.length, 2);
  assert.deepEqual(map, repositoryMap([...files].reverse()));
});
test('invalid ZIP, traversal, symlink, credential files, collisions and expansion limits fail closed', () => {
  assert.throws(() => readZip(Buffer.from('invalid archive')));
  for (const name of ['../outside', '/absolute', 'C:/drive', 'a\\b', '.git/config', '.env', '.aws/credentials', 'a/CON', 'a/../b']) assert.throws(() => safeImportPath(name));
  const link = new AdmZip(); link.addFile('link', Buffer.from('../outside')).attr = (0o120777 << 16) >>> 0; assert.throws(() => readZip(link.toBuffer()), /links/);
  const traversal = new AdmZip(); traversal.addFile('xx/file', Buffer.from('test'));
  const raw = traversal.toBuffer(); for (let i = 0; i < raw.length - 7; i++) if (raw.subarray(i, i + 7).toString() === 'xx/file') raw.write('../file', i);
  assert.throws(() => readZip(raw), /Unsafe/);
  const duplicate = new AdmZip(); duplicate.addFile('A.txt', Buffer.from('a')); duplicate.addFile('a.txt', Buffer.from('b')); assert.throws(() => readZip(duplicate.toBuffer()), /colliding/);
  const bomb = new AdmZip(); bomb.addFile('large.txt', Buffer.alloc(8 * 1024 * 1024 + 1)); assert.throws(() => readZip(bomb.toBuffer()), /size/);
});
test('Git symlink/submodule and mismatched blob bytes are rejected', async () => {
  const f = gitFixture();
  for (const mode of ['120000', '160000']) await assert.rejects(readGit(source, { ...f.reader, tree: async () => [{ path: 'link', sha: 'c'.repeat(40), mode, type: 'blob', size: 1 }] }), /symlinks/);
  await assert.rejects(readGit(source, { ...f.reader, blob: async () => Buffer.from('wrong') }), /integrity/);
});
test('large reasonable repository maps 5000 files without exposing contents', () => {
  const files = Array.from({ length: 5000 }, (_, i) => ({ path: `packages/p${i}/src/index.ts`, bytes: Buffer.from('private source'), executable: false }));
  const map = repositoryMap(files); assert.equal(map.likely_code_roots.length, 5001); assert.equal(JSON.stringify(map).includes('private source'), false);
});
test('session owner gate runs before repository transport', async () => {
  let called = false;
  const service = createImportService({ privateRoot: '.', authorizeSession: async () => { throw new Error('denied'); }, authorizedGitReader: async () => { called = true; return gitFixture().reader; } });
  await assert.rejects(service.importGit('other', scope, source)); await assert.rejects(service.importGit('u', scope, source)); assert.equal(called, false);
});
test('private storage rejects a symlink base', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'build-link-test-')); const link = `${base}-link`;
  try {
    await symlink(base, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(materializeImport(link, scope, [{ path: 'a', bytes: Buffer.from('a'), executable: false }], { type: 'ZIP', archive: Buffer.from('fixture') }), /private directories/);
  } finally { await rm(link, { force: true, recursive: true }); await rm(base, { force: true, recursive: true }); }
});
test('GitHub reader pins endpoints, disallows redirects and rejects truncated trees without leaking credentials', async () => {
  const requests: string[] = [];
  const reader = githubReader(source, 'test-only-token', async (url, options) => {
    requests.push(String(url)); assert.equal(options?.redirect, 'error');
    return Response.json(requests.length === 1 ? { sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } } : { sha: 'b'.repeat(40), truncated: true, tree: [] });
  });
  const resolved = await reader.resolve(source); assert.ok(requests[0].endsWith('/commits/feature%2Fone'));
  await assert.rejects(reader.tree(source, resolved), /Incomplete/);
  await assert.rejects(reader.resolve({ ...source, url: 'https://github.com/other/repo' }), /different source/);
});
