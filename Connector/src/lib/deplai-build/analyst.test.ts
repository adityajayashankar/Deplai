import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRepository, sanitizeAnalystText, type AnalystInput, type AnalystGateway } from './analyst';
import { ANALYST_SECTIONS } from './analyst-schema';
import { profileRepository } from './profiler';
import { parseArtifact } from './artifacts';
import { createAnalystService } from './analyst-service';
import { buildAnalystModels } from '../ai-platform/build-analyst-policy';
import type { CanonicalModel } from '../ai-platform/types';

const model = 'z-ai/glm-5.3';
function input(): AnalystInput {
  const files = [
    { path: 'package.json', bytes: Buffer.from(JSON.stringify({ dependencies: { next: '16', react: '19' } })), executable: false },
    { path: 'api/main.py', bytes: Buffer.from('from fastapi import FastAPI\napp = FastAPI()\n'), executable: false },
    { path: 'private-not-selected.txt', bytes: Buffer.from('not supplied to model'), executable: false },
  ];
  return { model, files, source_revision: 'a'.repeat(40), expected_content_sha256: profileRepository(files).content_sha256, selected_paths: ['package.json', 'api/main.py'] };
}
function report() {
  const finding = (id: string, description: string, path: string) => ({ id, description, confidence: 0.8, evidence_paths: [path], uncertainty: 'Runtime behavior has not been verified.' });
  return {
    schema_version: 1,
    purpose: finding('purpose', 'Web application with a separate Python API; business purpose is unknown.', 'package.json'),
    sections: { ...Object.fromEntries(ANALYST_SECTIONS.map(key => [key, []])),
      frontend: [finding('web', 'Next.js React frontend.', 'package.json')],
      backend: [finding('api', 'FastAPI application process.', 'api/main.py')],
    },
    relationships: [{ from: 'web', to: 'api', description: 'Frontend and API coexist; their connection is not confirmed.', confidence: 0.4, evidence_paths: ['package.json', 'api/main.py'], uncertainty: 'No HTTP client configuration supplied.' }],
    unknowns: ['Database, authentication and runtime configuration were not supplied.'],
  };
}
const gateway = (value: unknown = report()): AnalystGateway => async () => ({ model, output: JSON.stringify(value) });

test('analyst generates reviewable canonical YAML from bounded evidence without modifying source', async () => {
  const source = input(); const before = source.files.map(f => f.bytes.toString('hex'));
  const result = await analyzeRepository(source, async request => {
    const context = JSON.parse(request.context);
    assert.deepEqual(context.files.map((f: { path: string }) => f.path), ['api/main.py', 'package.json']);
    assert.ok(!request.context.includes('not supplied to model'));
    assert.equal(context.coverage.partial_context, true);
    assert.equal(request.model, model); assert.match(request.system, /untrusted evidence/);
    return gateway()(request);
  });
  assert.equal(result.artifact_path, '.deplai/repository.yaml');
  assert.equal(parseArtifact('repository.yaml', result.yaml).analysis?.sections.frontend[0].id, 'web');
  assert.deepEqual(source.files.map(f => f.bytes.toString('hex')), before);
});

test('stale source and invalid model fail before inference', async () => {
  let calls = 0; const never: AnalystGateway = async () => { calls++; throw new Error('unexpected'); };
  await assert.rejects(analyzeRepository({ ...input(), expected_content_sha256: '0'.repeat(64) }, never), /stale/);
  await assert.rejects(analyzeRepository({ ...input(), model: 'different-model' }, never), /GLM-5.3/);
  assert.equal(calls, 0);
});

test('analyst rejects hallucinated citations, duplicate IDs, unsupported edges and certainty', async () => {
  const cited = report(); cited.purpose.evidence_paths = ['not-read.ts'];
  await assert.rejects(analyzeRepository(input(), gateway(cited)), /not supplied/);
  const duplicate = report(); duplicate.sections.frontend[0].id = 'purpose';
  await assert.rejects(analyzeRepository(input(), gateway(duplicate)), /Duplicate/);
  const edge = report(); edge.relationships[0].to = 'missing';
  await assert.rejects(analyzeRepository(input(), gateway(edge)), /unknown component/);
  const uncertain = report(); uncertain.purpose.confidence = 0.2; uncertain.purpose.uncertainty = '';
  await assert.rejects(analyzeRepository(input(), gateway(uncertain)), /uncertainty/);
  await assert.rejects(analyzeRepository(input(), gateway({ ...report(), unknowns: [] })), /acknowledge unknowns/);
});

test('invalid, substituted, secret-bearing and tool-like output never becomes an artifact', async () => {
  await assert.rejects(analyzeRepository(input(), async () => ({ model: 'other', output: '{}' })), /mismatch/);
  await assert.rejects(analyzeRepository(input(), async () => ({ model, output: 'not json' })), /malformed/);
  await assert.rejects(analyzeRepository(input(), gateway({ ...report(), edits: [] })), /schema/);
  const secret = report(); secret.purpose.description = 'mongodb://user:fixture-only@localhost/database';
  await assert.rejects(analyzeRepository(input(), gateway(secret)), /Unsafe/);
  await assert.rejects(analyzeRepository(input(), async () => { throw new Error('private-provider-detail'); }), /^Error: Repository analysis gateway failed; no artifact produced$/);
});

test('source redaction removes common credential forms before model dispatch', async () => {
  const raw = 'const password = "fixture-secret-value";\nAPI_TOKEN=fixture-env-value\nconst url="mongodb://user:fixture-url-value@localhost/db";';
  const redacted = sanitizeAnalystText(raw);
  for (const value of ['fixture-secret-value', 'fixture-env-value', 'fixture-url-value']) assert.ok(!redacted.includes(value));
  const source = input(); source.files[1].bytes = Buffer.from(raw);
  source.expected_content_sha256 = profileRepository(source.files).content_sha256;
  await analyzeRepository(source, async request => {
    assert.ok(!request.context.includes('fixture-secret-value')); return gateway()(request);
  });
});

test('selection limits and environment content are rejected', async () => {
  await assert.rejects(analyzeRepository({ ...input(), selected_paths: [] }, gateway()), /Select/);
  await assert.rejects(analyzeRepository({ ...input(), selected_paths: ['.env.template'] }, gateway()), /metadata-only/);
  const source = input(); source.files[1].bytes = Buffer.alloc(8001, 65);
  source.expected_content_sha256 = profileRepository(source.files).content_sha256;
  await assert.rejects(analyzeRepository(source, gateway()), /too large/);
});

test('catalog restriction refuses absent or ambiguous GLM configuration', () => {
  const entry = { providerModelId: model } as CanonicalModel;
  assert.deepEqual(buildAnalystModels([entry, { providerModelId: 'other' } as CanonicalModel], model), [entry]);
  assert.throws(() => buildAnalystModels([], model), /verified catalog/);
  assert.throws(() => buildAnalystModels([entry, entry], model), /verified catalog/);
  assert.throws(() => buildAnalystModels([entry], 'other'), /GLM-5.3/);
});

test('worker report retains runtime relationships and evidence in YAML', async () => {
  const source = input();
  source.files.push({ path: 'worker.py', bytes: Buffer.from('from celery import Celery\nworker = Celery("tasks", broker="redis://cache:6379/0")\n'), executable: false });
  source.selected_paths.push('worker.py'); source.expected_content_sha256 = profileRepository(source.files).content_sha256;
  const value = report();
  const worker = { id: 'worker', description: 'Celery task worker.', evidence_paths: ['worker.py'], confidence: 0.9, uncertainty: 'Tasks were not inspected.' };
  const queue = { ...worker, id: 'queue', description: 'Redis is configured as the Celery broker.' };
  const sections = { ...value.sections, workers: [worker], queues: [queue] };
  const relationships = [{ from: 'worker', to: 'queue', description: 'Worker consumes broker messages.', evidence_paths: ['worker.py'], confidence: 0.8, uncertainty: 'Runtime reachability is unknown.' }];
  const result = await analyzeRepository(source, gateway({ ...value, sections, relationships }));
  assert.equal(result.repository.workers[0].id, 'worker');
  assert.equal(result.repository.analysis?.relationships[0].to, 'queue');
});

test('revoked access and incomplete provider responses do not return an artifact', async () => {
  const scope = { owner_user_id: 'user', organization_id: 'org', project_id: 'project', session_id: 'session' };
  for (const mode of ['revoked', 'truncated', 'fallback', 'tools']) {
    let checks = 0;
    const service = createAnalystService({ authorizeRun: async () => {
      if (++checks === 3 && mode === 'revoked') throw new Error('Access revoked');
    }, executeChat: async () => ({ model, output: JSON.stringify(report()),
      toolCalls: mode === 'tools' ? [{ name: 'edit_file', arguments: '{}' }] : [],
      finishReason: mode === 'truncated' ? 'length' : 'stop', fallback: { count: mode === 'fallback' ? 1 : 0 },
    }) });
    await assert.rejects(service('user', scope, input()), mode === 'revoked' ? /Access revoked/ : /gateway failed/);
  }
});

test('service checks ownership and trusted run approval before gateway dispatch', async () => {
  const scope = { owner_user_id: 'user', organization_id: 'org', project_id: 'project', session_id: 'session' };
  let calls = 0; let checks = 0;
  const service = createAnalystService({ authorizeRun: async () => { checks++; throw new Error('No paid consent'); }, executeChat: async () => { calls++; throw new Error('unexpected'); } });
  await assert.rejects(service('other', scope, input()), /access denied/);
  assert.equal(checks, 0);
  await assert.rejects(service('user', scope, input()), /No paid consent/); assert.equal(calls, 0);
  const approved = createAnalystService({ authorizeRun: async () => { checks++; }, executeChat: async (context, request) => {
    assert.equal(context.organizationId, 'org'); assert.equal(request.metadata?.stage, 'repository_analysis');
    assert.equal(request.tools, undefined); assert.equal(request.responseFormat?.type, 'json_schema');
    return { model, output: JSON.stringify(report()), toolCalls: [], finishReason: 'stop', fallback: { count: 0 } };
  } });
  await approved('user', scope, input()); assert.equal(checks, 4);
});
