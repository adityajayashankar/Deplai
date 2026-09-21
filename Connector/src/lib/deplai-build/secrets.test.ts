import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { encryptSecret, decryptSecret } from '../ai-platform/crypto';
import { createSecretStore, type SecretDeclaration, type SecretRecord, type SecretAudit, type SecretTransaction } from './secrets';
import { assertOwnership, type BuildScope } from './contracts';
import { artifactFixture } from './artifact-fixtures';
import { serializeBundle } from './artifacts';

const scope: BuildScope = { owner_user_id: 'u1', organization_id: 'o1', project_id: 'p1', session_id: 's1' };
const declaration: SecretDeclaration = { id: 'app-secret', name: 'Application signing key', purpose: 'Sign application sessions', classification: 'USER_PROVIDED', scope: 'session', consumers: ['web'], required: true, required_for_preview: true, required_for_deployment: false, configured: false };
function fixture() {
  let rows = new Map<string, SecretRecord>(); let audit: SecretAudit[] = []; let failAudit = false;
  const vault = createSecretStore({
    authorize: async (actor, requested) => { assert.equal(actor, 'u1'); assertOwnership(scope, requested); },
    authorizeRuntime: async grant => { assertOwnership(scope, grant.scope); assert.equal(grant.preview_id, 'preview-one'); },
    encrypt: encryptSecret, decrypt: decryptSecret,
    transaction: async <T>(_scope: BuildScope, work: (tx: SecretTransaction) => Promise<T>) => {
      const before = structuredClone(rows); const beforeAudit = structuredClone(audit);
      try { return await work({ get: async ref => structuredClone(rows.get(ref) || null), list: async () => structuredClone([...rows.values()]), put: async row => { rows.set(row.metadata.reference, structuredClone(row)); }, remove: async ref => { rows.delete(ref); }, audit: async e => { if (failAudit) throw new Error('audit unavailable'); audit.push(e); } }); }
      catch (error) { rows = before; audit = beforeAudit; throw error; }
    },
  });
  return { ...vault, records: () => rows, audit: () => audit, failAudit: () => { failAudit = true; } };
}
test('vault exposes metadata only; encrypted persistence, exported artifacts and audit contain no secret', async () => {
  const value = randomBytes(32).toString('base64url'); const f = fixture();
  const m = await f.editor.createSecret('u1', scope, declaration, { value });
  assert.match(m.reference, /^secret:\/\/session\//);
  assert.equal('resolveForRuntime' in f.metadataReader, false);
  const publicData = await f.metadataReader.listRequiredSecrets('u1', scope);
  assert.equal(publicData[0].configured, true);
  assert.equal(JSON.stringify([...f.records().values()]).includes(value), false);
  assert.equal(JSON.stringify(f.audit()).includes(value), false);
  assert.equal(JSON.stringify(publicData).includes(value), false);
  const bundle = artifactFixture('frontend-only'); bundle['secrets.schema.yaml'].secrets = publicData; bundle['runtime.yaml'].services[0].secret_references = [m.reference];
  assert.equal(JSON.stringify(serializeBundle(bundle)).includes(value), false);
  const environment = await f.runtimeResolver.resolveForRuntime({ scope, preview_id: 'preview-one', consumer: 'web', bindings: { APP_SESSION_KEY: m.reference } });
  // Fixed test program, not user code. Child receives only its explicitly resolved environment.
  const child = spawnSync(process.execPath, ['-e', "process.stdout.write(require('node:crypto').createHash('sha256').update(process.env.APP_SESSION_KEY).digest('hex'))"], { env: { NODE_ENV: 'test', ...environment }, encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, createHash('sha256').update(value).digest('hex'));
  assert.equal(child.stdout.includes(value), false);
  assert.equal(JSON.stringify(f.audit()).includes(value), false);
  assert.equal(f.audit().at(-1)?.consumer, 'web');
});
test('unauthorized consumer, other owner, other session, unsafe env and deployment-only credentials are denied', async () => {
  const f = fixture(); const m = await f.editor.createSecret('u1', scope, declaration, { value: randomBytes(32).toString('hex') });
  await assert.rejects(f.metadataReader.getMetadata('u2', scope, m.reference));
  await assert.rejects(f.metadataReader.getMetadata('u1', { ...scope, session_id: 's2' }, m.reference));
  const grant = { scope, preview_id: 'preview-one', consumer: 'api', bindings: { APP_KEY: m.reference } };
  await assert.rejects(f.runtimeResolver.resolveForRuntime(grant));
  await assert.rejects(f.runtimeResolver.resolveForRuntime({ ...grant, consumer: 'web', bindings: { NODE_OPTIONS: m.reference } }));
  const d = await f.editor.createSecret('u1', scope, { ...declaration, id: 'deploy', classification: 'DEPLOYMENT_ONLY', required_for_preview: false }, { value: randomBytes(32).toString('hex') });
  await assert.rejects(f.runtimeResolver.resolveForRuntime({ ...grant, consumer: 'web', bindings: { APP_KEY: d.reference } }));
});
test('generated preview secrets are unique, preview-bound and never returned to editors', async () => {
  const f = fixture();
  const m = await f.editor.createSecret('u1', scope, { ...declaration, classification: 'GENERATED_PREVIEW' }, { preview_id: 'preview-one' });
  assert.equal(m.configured, true);
  const env = await f.runtimeResolver.resolveForRuntime({ scope, preview_id: 'preview-one', consumer: 'web', bindings: { APP_KEY: m.reference } });
  assert.ok(env.APP_KEY.length >= 43);
  assert.equal(JSON.stringify(m).includes(env.APP_KEY), false);
  await assert.rejects(f.runtimeResolver.resolveForRuntime({ scope, preview_id: 'preview-two', consumer: 'web', bindings: { APP_KEY: m.reference } }));
  await assert.rejects(f.editor.updateSecret('u1', scope, m.reference, 'replacement'));
  await assert.rejects(f.editor.createSecret('u1', scope, { ...declaration, classification: 'GENERATED_PREVIEW', required_for_deployment: true }, { preview_id: 'preview-one' }));
});
test('update/delete, integrity binding and mandatory audit commit are enforced', async () => {
  const f = fixture(); const m = await f.editor.createSecret('u1', scope, declaration);
  const grant = { scope, preview_id: 'preview-one', consumer: 'web', bindings: { APP_KEY: m.reference } };
  await assert.rejects(f.runtimeResolver.resolveForRuntime(grant));
  await f.editor.updateSecret('u1', scope, m.reference, randomBytes(32).toString('hex'));
  const other = await f.editor.createSecret('u1', scope, { ...declaration, id: 'other' }, { value: randomBytes(32).toString('hex') });
  f.records().get(m.reference)!.ciphertext = f.records().get(other.reference)!.ciphertext;
  await assert.rejects(f.runtimeResolver.resolveForRuntime(grant), /integrity/);
  await f.editor.deleteSecret('u1', scope, other.reference);
  await assert.rejects(f.metadataReader.getMetadata('u1', scope, other.reference));
  f.failAudit();
  await assert.rejects(f.editor.updateSecret('u1', scope, m.reference, randomBytes(32).toString('hex')));
  await assert.rejects(f.runtimeResolver.resolveForRuntime(grant));
});
