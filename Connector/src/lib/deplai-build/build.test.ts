import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnership, assertSource, type BuildScope, type BuildSession } from './contracts';
import { assertFailure, assertTransition } from './lifecycle';
import { DEFAULT_QUOTA, sandboxEnvironment, sandboxProvider, validateQuota, validateSandboxPolicy, type SandboxPolicy } from './sandbox';
import { createBuildRepository } from './repository';
import type { SqlExecutor } from '../db';

const scope: BuildScope = { session_id: 's1', project_id: 'p1', organization_id: 'o1', owner_user_id: 'u1' };
const policy: SandboxPolicy = { provider: 'gvisor', environment: 'production', trusted_development: false, quota: { ...DEFAULT_QUOTA }, environment_allowlist: ['APP_MODE'], network: { public_egress: 'deny', host: false, metadata: false, private_networks: false, sibling_previews: false } };

test('lifecycle accepts analysis, rejects skipping stages and all unproven readiness', () => {
  assert.doesNotThrow(() => assertTransition('DRAFT', 'ANALYZING'));
  assert.throws(() => assertTransition('ANALYZING', 'PREVIEW_READY'));
  assert.throws(() => assertTransition('PREVIEW_STARTING', 'PREVIEW_READY'), /verification/);
  assert.throws(() => assertTransition('VERIFYING', 'READY_TO_DEPLOY'), /verification/);
  for (const state of ['FAILED', 'CANCELLED', 'READY_TO_DEPLOY'] as const) assert.throws(() => assertTransition(state, 'ANALYZING'));
});
test('failure reasons are codes, not raw exception or credential text', () => {
  assert.doesNotThrow(() => assertFailure('FAILED', 'TIMEOUT'));
  assert.throws(() => assertFailure('FAILED', null));
  assert.throws(() => assertFailure('ANALYZING', 'TIMEOUT'));
});
test('ownership binds all four dimensions including sibling sessions', () => {
  for (const key of Object.keys(scope) as (keyof BuildScope)[]) assert.throws(() => assertOwnership(scope, { ...scope, [key]: 'another' }));
  assert.throws(() => assertOwnership(scope, { ...scope, project_id: '../outside' }));
});
test('imports require immutable SHA; new projects may have no source revision', () => {
  assertSource('NEW_PROJECT', null);
  assertSource('IMPORT_REPOSITORY', 'a'.repeat(40));
  for (const revision of [null, 'main', 'abc']) assert.throws(() => assertSource('IMPORT_REPOSITORY', revision));
});
test('quota rejects every missing, unbounded, zero, negative or excessive limit', () => {
  for (const key of Object.keys(DEFAULT_QUOTA)) {
    for (const value of [undefined, Infinity, NaN, 0, -1, 1e12]) assert.throws(() => validateQuota({ ...DEFAULT_QUOTA, [key]: value }));
  }
  assert.throws(() => validateQuota({ ...DEFAULT_QUOTA, lifetime_seconds: 10 }));
  assert.throws(() => validateQuota({ ...DEFAULT_QUOTA, pids: 1.5 }));
  assert.deepEqual(validateQuota(DEFAULT_QUOTA), DEFAULT_QUOTA);
});
test('production refuses local Docker and unsafe network controls', () => {
  assert.throws(() => validateSandboxPolicy({ ...policy, provider: 'local-docker', trusted_development: true }));
  assert.throws(() => validateSandboxPolicy({ ...policy, provider: 'firecracker' }));
  for (const key of ['host', 'metadata', 'private_networks', 'sibling_previews']) assert.throws(() => validateSandboxPolicy({ ...policy, network: { ...policy.network, [key]: true } }));
  validateSandboxPolicy({ ...policy, provider: 'local-docker', environment: 'development', trusted_development: true });
});
test('sandbox never inherits process environment and rejects unlisted values', () => {
  const before = process.env.APP_MODE;
  process.env.APP_MODE = 'host-only';
  try {
    assert.deepEqual(Object.keys(sandboxEnvironment(policy)), []);
    assert.equal(sandboxEnvironment(policy, { APP_MODE: 'preview' }).APP_MODE, 'preview');
    assert.throws(() => sandboxEnvironment(policy, { AWS_ACCESS_KEY_ID: 'not-a-real-key' }));
    assert.throws(() => sandboxEnvironment({ ...policy, environment_allowlist: ['NODE_OPTIONS'] }));
  } finally {
    if (before === undefined) delete process.env.APP_MODE; else process.env.APP_MODE = before;
  }
});
test('no provider can execute even an otherwise valid request', async () => {
  for (const id of ['gvisor', 'local-docker', 'firecracker'] as const) {
    await assert.rejects(sandboxProvider(id).provision({ scope, policy: { ...policy, provider: id }, revision: 'a'.repeat(40) }));
  }
});

function fixture() {
  let row = { ...scope, version: 0, state: 'DRAFT' } as BuildSession;
  let events: unknown[][] = [];
  let failEvent = false;
  let allow = true;
  const exec: SqlExecutor = async <T>(sql: string, params?: unknown[] | Record<string, unknown>): Promise<T> => {
    const p = params as unknown[];
    if (sql.startsWith('SELECT *')) return [structuredClone(row)] as T;
    if (sql.startsWith('UPDATE build_sessions')) { row = { ...row, state: p[0] as BuildSession['state'], version: row.version + 1 }; return {} as T; }
    if (sql.startsWith('INSERT INTO build_session_events')) { if (failEvent) throw new Error('event write failed'); events.push(p); return {} as T; }
    if (sql.startsWith('SELECT resource_id')) return [{ ...scope, session_id: 'sibling', resource_id: 'r1', kind: 'artifact' }] as T;
    throw new Error(`Unexpected test SQL: ${sql}`);
  };
  const deps = {
    authorize: async () => { if (!allow) throw new Error('Membership denied'); return { organizationId: 'o1' }; },
    transaction: async <T>(work: (e: SqlExecutor) => Promise<T>) => {
      const original = structuredClone(row); const oldEvents = structuredClone(events);
      try { return await work(exec); } catch (error) { row = original; events = oldEvents; throw error; }
    },
  };
  return { repo: createBuildRepository(deps), deps, row: () => row, events: () => events, failEvent: () => { failEvent = true; }, deny: () => { allow = false; } };
}
test('persistent transitions require owner, membership, matching organization and fresh version', async () => {
  const f = fixture();
  await assert.rejects(f.repo.get('other', scope));
  await assert.rejects(f.repo.get('u1', { ...scope, organization_id: 'other' }));
  await f.repo.transition('u1', scope, 0, 'ANALYZING');
  assert.equal(f.row().version, 1);
  assert.equal(f.events().length, 1);
  await assert.rejects(f.repo.transition('u1', scope, 0, 'PLANNING'), /Stale/);
  assert.equal(f.events().length, 1);
  f.deny();
  await assert.rejects(f.repo.get('u1', scope), /Membership/);
});
test('event failure rolls back state; a new repository instance reads persisted state', async () => {
  const f = fixture();
  await f.repo.transition('u1', scope, 0, 'ANALYZING');
  const reopened = createBuildRepository(f.deps);
  assert.equal((await reopened.get('u1', scope)).state, 'ANALYZING');
  f.failEvent();
  await assert.rejects(reopened.transition('u1', scope, 1, 'PLANNING'));
  assert.equal(f.row().state, 'ANALYZING');
  assert.equal(f.row().version, 1);
});
test('resource lookup rejects another session even if a data adapter returns it', async () => {
  await assert.rejects(fixture().repo.getResource('u1', scope, 'r1'), /access denied/);
});
