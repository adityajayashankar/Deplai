import test from 'node:test';
import assert from 'node:assert/strict';
import { profileRepository } from './profiler';
import { createHash } from 'node:crypto';
const files = (source: Record<string, string>) => Object.entries(source).map(([path, text]) => ({ path, bytes: Buffer.from(text), executable: false }));
const pkg = (dependencies: Record<string, string>) => JSON.stringify({ dependencies, scripts: { dev: 'vite --port 5173' } });
const fixtures: [string, Record<string, string>, string[]][] = [
  ['Next.js', { 'package.json': pkg({ next: '*', react: '*' }), 'app/page.tsx': 'export default function Page() {}' }, ['Next.js']],
  ['React/Vite', { 'package.json': pkg({ react: '*', vite: '*' }), 'yarn.lock': '' }, ['React', 'Vite']],
  ['Express/Nest', { 'package.json': pkg({ express: '*', '@nestjs/core': '*' }) }, ['Express', 'NestJS']],
  ['FastAPI', { 'requirements.txt': 'fastapi==1\nuvicorn==1\nsqlalchemy==2\nalembic==1', 'main.py': 'import fastapi' }, ['FastAPI', 'SQLAlchemy', 'Alembic']],
  ['Django', { 'pyproject.toml': '[project]\ndependencies = ["django>=5"]', 'manage.py': '# entry' }, ['Django']],
  ['Next/FastAPI monorepo', { 'apps/web/package.json': pkg({ next: '*' }), 'apps/api/requirements.txt': 'fastapi', 'pnpm-workspace.yaml': 'packages:\n - apps/*', 'turbo.json': '{}' }, ['Next.js', 'FastAPI', 'pnpm workspaces', 'Turborepo']],
  ['Redis worker', { 'package.json': pkg({ bullmq: '*', ioredis: '*' }), 'worker.ts': 'const key = process.env.WORKER_KEY;' }, ['BullMQ', 'Redis', 'WORKER_KEY']],
  ['Docker Compose', { 'Dockerfile': 'FROM node:22\nEXPOSE 3000\nCMD ["npm","start"]', 'compose.yaml': 'services:\n web:\n  ports:\n   - "8080:3000"\n  environment:\n   API_KEY: ${API_KEY}', '.github/workflows/ci.yml': 'name: CI' }, ['Docker Compose', 'Dockerfile', '3000', 'API_KEY', 'GitHub Actions']],
];
for (const [label, source, expected] of fixtures) test(`profile fixture: ${label}`, () => {
  const input = files(source); const before = input.map(f => Buffer.from(f.bytes));
  const result = profileRepository(input); const values = Object.values(result.detections).flat().map(d => d.value);
  for (const value of expected) assert.ok(values.includes(value), `Missing ${value}`);
  assert.deepEqual(result, profileRepository([...input].reverse()));
  input.forEach((f, i) => assert.deepEqual(f.bytes, before[i]));
  for (const d of Object.values(result.detections).flat()) if (d.value !== 'UNKNOWN') { assert.ok(d.source_path); assert.ok(d.pattern); assert.ok(d.confidence > 0 && d.confidence <= 1); }
});
test('unknowns are explicit; malformed or oversized manifests cannot imply detected frameworks', () => {
  for (const text of ['bad JSON', 'x'.repeat(262145)]) {
    const p = profileRepository(files({ 'package.json': text }));
    assert.equal(p.detections.frameworks[0].value, 'UNKNOWN'); assert.equal(p.skipped.length, 1);
  }
});
test('secrets and arbitrary command bodies never enter profile output', () => {
  const marker = 'private-fixture-value';
  const p = profileRepository(files({ 'package.json': JSON.stringify({ scripts: { dev: `TOKEN=${marker} next dev --port 4000`, postinstall: `echo ${marker}` } }), '.env.example': `API_TOKEN=${marker}`, 'main.py': `key = os.environ.get('API_TOKEN', '${marker}')` }));
  assert.equal(JSON.stringify(p).includes(marker), false);
  assert.equal(p.detections.probable_commands[0].value, 'npm run dev');
  assert.ok(p.detections.environment_keys.some(d => d.value === 'API_TOKEN'));
});
test('inherited object property filenames do not crash profiling; nearest lockfile informs command hints', () => {
  const p = profileRepository(files({ constructor: 'data', 'package.json': pkg({ react: '*' }), 'yarn.lock': '' }));
  assert.equal(p.detections.probable_commands[0].value, 'yarn run dev');
});
test('JVM and Rust configuration produces evidence without source execution', () => {
  const p = profileRepository(files({ 'pom.xml': '<artifactId>spring-boot-starter-web</artifactId>', 'Cargo.toml': '[dependencies]\naxum = "0.8"\nsqlx = "0.8"' }));
  assert.ok(p.detections.frameworks.some(d => d.value === 'Spring Boot'));
  assert.ok(p.detections.frameworks.some(d => d.value === 'axum'));
  assert.ok(p.detections.db_clients.some(d => d.value === 'sqlx'));
});
test('content fingerprint matches ingestion convention and changes when bytes change', () => {
  const input = files({ 'main.py': 'import fastapi' });
  const digest = createHash('sha256').update(JSON.stringify(['main.py', false, createHash('sha256').update(input[0].bytes).digest('hex')])).digest('hex');
  assert.equal(profileRepository(input).content_sha256, digest);
  assert.notEqual(profileRepository(files({ 'main.py': 'import django' })).content_sha256, digest);
});
