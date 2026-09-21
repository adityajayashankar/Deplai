import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactFixture, invalidArtifactFixture } from './artifact-fixtures';
import { ARTIFACT_NAMES, jsonSchemaFor, type ArtifactName } from './artifact-schemas';
import { parseArtifact, parseBundle, serializeBundle, validateBundle } from './artifacts';

for (const kind of ['frontend-only', 'next-postgres', 'react-fastapi-postgres', 'redis-worker', 'queue-based'] as const) {
  test(`valid fixture: ${kind} survives YAML/JSON round trip`, () => {
    const bundle = artifactFixture(kind); const files = serializeBundle(bundle);
    const input = Object.fromEntries(ARTIFACT_NAMES.map(name => [name, files[`.deplai/${name}`]])) as Record<ArtifactName, string>;
    assert.deepEqual(parseBundle(input), bundle);
    assert.ok(Object.hasOwn(files, '.deplai/verification/.gitkeep'));
  });
}
for (const [kind, reason] of [['dependency-cycle', /dependency cycle/], ['secret-reference', /undefined secret/], ['preview-route', /unknown route target/]] as const) {
  test(`invalid fixture: ${kind} reports its cause`, () => assert.throws(() => validateBundle(invalidArtifactFixture(kind)), reason));
}
test('every primary artifact rejects missing or future version', () => {
  for (const name of ARTIFACT_NAMES) for (const version of [undefined, 2, '1']) {
    const data = { ...artifactFixture('frontend-only')[name], schema_version: version };
    assert.throws(() => parseArtifact(name, JSON.stringify(data)), /schema_version/);
  }
});
test('reject duplicate IDs, missing dependencies, task cycles and unknown acceptance criteria', () => {
  const duplicate = artifactFixture('frontend-only'); duplicate['runtime.yaml'].services.push(structuredClone(duplicate['runtime.yaml'].services[0]));
  assert.throws(() => validateBundle(duplicate), /duplicate identifiers/);
  const missing = artifactFixture('frontend-only'); missing['runtime.yaml'].services[0].dependencies.push('missing');
  assert.throws(() => validateBundle(missing), /missing dependency/);
  const tasks = artifactFixture('frontend-only'); tasks['task-graph.json'].tasks[0].dependencies.push('task-main');
  assert.throws(() => validateBundle(tasks), /dependency cycle/);
  tasks['task-graph.json'].tasks[0].dependencies = []; tasks['task-graph.json'].tasks[0].acceptance_criteria = ['unknown'];
  assert.throws(() => validateBundle(tasks), /acceptance IDs/);
});
test('invalid ports, traversal, malformed commands and revision mismatch are rejected', () => {
  for (const port of [-1, 0, 65536, 3.5]) { const b = artifactFixture('frontend-only'); b['runtime.yaml'].services[0].port = port; assert.throws(() => validateBundle(b), /port/); }
  for (const directory of ['../escape', '/etc', 'C:\\host', 'app/../host']) { const b = artifactFixture('frontend-only'); b['runtime.yaml'].services[0].directory = directory; assert.throws(() => validateBundle(b), /directory/); }
  const b = artifactFixture('frontend-only'); b['runtime.yaml'].services[0].dev = [];
  assert.throws(() => validateBundle(b), /dev/);
  b['runtime.yaml'].services[0].dev = ['npm', 'start']; b['session.yaml'].active_preview_revision = 'b'.repeat(40);
  assert.throws(() => validateBundle(b), /revision/);
});
test('secret metadata accepts declared consumers but rejects raw value fields and mismatched scope', () => {
  const b = artifactFixture('next-postgres');
  b['secrets.schema.yaml'].secrets.push({ id: 'db-auth', name: 'Database auth', purpose: 'Connect to database', classification: 'GENERATED_PREVIEW', scope: 'session', consumers: ['web'], required: true, required_for_preview: true, required_for_deployment: false, configured: false });
  b['runtime.yaml'].services[0].secret_references.push('db-auth');
  assert.doesNotThrow(() => validateBundle(b));
  b['secrets.schema.yaml'].secrets[0].consumers = ['db'];
  assert.throws(() => validateBundle(b), /consumer/);
  const raw = { ...b['secrets.schema.yaml'], secrets: [{ ...b['secrets.schema.yaml'].secrets[0], value: 'sensitive-fixture-marker' }] };
  assert.throws(() => parseArtifact('secrets.schema.yaml', JSON.stringify(raw)), error => error instanceof Error && !error.message.includes('sensitive-fixture-marker'));
});
test('parsing rejects duplicate YAML/JSON keys, custom tags, aliases, unknown fields, oversized documents without echoing content', () => {
  for (const source of ['schema_version: 1\nschema_version: 1', 'schema_version: !!js/function function(){}', 'a: &a [*a]', '{"schema_version":1,"schema_version":1}', 'secret: sensitive-fixture-marker\n: [']) {
    assert.throws(() => parseArtifact('product.yaml', source), e => e instanceof Error && !e.message.includes('sensitive-fixture-marker'));
  }
  assert.throws(() => parseArtifact('product.yaml', 'a'.repeat(524289)), /512 KiB/);
  assert.throws(() => parseArtifact('task-graph.json', 'schema_version: 1\ntasks: []'), /malformed/);
  assert.throws(() => parseArtifact('product.yaml', '{"__proto__":{}}'), /forbidden/);
});
test('schema exports cover every primary file', () => {
  for (const name of ARTIFACT_NAMES) assert.equal(jsonSchemaFor(name).type, 'object');
});
