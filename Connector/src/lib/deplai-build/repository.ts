import { randomUUID } from 'node:crypto';
import type { SqlExecutor } from '../db';
import { assertIdentifier, assertOwnership, assertScope, assertSource, RESOURCE_KINDS, type BuildScope, type BuildSession, type BuildState, type ResourceKind, type SourceType } from './contracts';
import { assertFailure, assertTransition, type FailureCode } from './lifecycle';
import { DEFAULT_QUOTA, validateQuota } from './sandbox';

type Dependencies = {
  transaction: <T>(work: (exec: SqlExecutor) => Promise<T>) => Promise<T>;
  authorize: (actor: string, project: string, action: 'agent.read' | 'agent.run' | 'agent.cancel') => Promise<{ organizationId: string | null }>;
};
const scopeWhere = 'session_id = ? AND owner_user_id = ? AND organization_id = ? AND project_id = ?';
const scopeValues = (s: BuildScope) => [s.session_id, s.owner_user_id, s.organization_id, s.project_id];

/** Internal control-plane repository; never expose arbitrary transition calls as LLM tools. */
export function createBuildRepository(deps: Dependencies) {
  async function authorize(actor: string, scope: BuildScope, action: 'agent.read' | 'agent.run' | 'agent.cancel') {
    assertIdentifier(actor);
    assertScope(scope);
    if (actor !== scope.owner_user_id) throw new Error('Build resource access denied');
    const access = await deps.authorize(actor, scope.project_id, action);
    if (!access.organizationId || access.organizationId !== scope.organization_id) throw new Error('Build resource access denied');
  }
  async function locked(exec: SqlExecutor, scope: BuildScope): Promise<BuildSession> {
    const rows = await exec<BuildSession[]>(`SELECT * FROM build_sessions WHERE ${scopeWhere} FOR UPDATE`, scopeValues(scope));
    if (!rows[0]) throw new Error('Build session not found');
    assertOwnership(scope, rows[0]);
    return rows[0];
  }
  async function event(exec: SqlExecutor, sessionId: string, sequence: number, state: BuildState, reason: FailureCode | null = null) {
    await exec('INSERT INTO build_session_events (session_id, sequence, state, reason_code) VALUES (?, ?, ?, ?)', [sessionId, sequence, state, reason]);
  }
  return {
    async create(actor: string, input: { organization_id: string; project_id: string; source_type: SourceType; source_revision: string | null }): Promise<BuildScope> {
      const scope: BuildScope = { owner_user_id: actor, organization_id: input.organization_id, project_id: input.project_id, session_id: randomUUID() };
      await authorize(actor, scope, 'agent.run');
      assertSource(input.source_type, input.source_revision);
      const quota = validateQuota(DEFAULT_QUOTA);
      return deps.transaction(async exec => {
        // Recheck the project boundary under the write lock to reject stale organization scope.
        const projects = await exec<Array<{ organization_id: string }>>('SELECT organization_id FROM projects WHERE id = ? FOR UPDATE', [scope.project_id]);
        if (projects[0]?.organization_id !== scope.organization_id) throw new Error('Build resource access denied');
        const secretScope = randomUUID();
        await exec(`INSERT INTO build_sessions (session_id, owner_user_id, organization_id, project_id, source_type, source_revision, secret_scope_id, quota_profile_id, quota_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [...scopeValues(scope), input.source_type, input.source_revision, secretScope, 'build-default-v1', JSON.stringify(quota)]);
        await exec('INSERT INTO build_resources (resource_id, session_id, owner_user_id, organization_id, project_id, kind) VALUES (?, ?, ?, ?, ?, ?)', [secretScope, ...scopeValues(scope), 'secret_scope']);
        await event(exec, scope.session_id, 0, 'DRAFT');
        return scope;
      });
    },
    async get(actor: string, scope: BuildScope): Promise<BuildSession> {
      await authorize(actor, scope, 'agent.read');
      return deps.transaction(exec => locked(exec, scope));
    },
    async transition(actor: string, scope: BuildScope, expectedVersion: number, state: BuildState, reason: FailureCode | null = null): Promise<void> {
      await authorize(actor, scope, state === 'CANCELLED' ? 'agent.cancel' : 'agent.run');
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('Invalid Build version');
      assertFailure(state, reason);
      await deps.transaction(async exec => {
        const current = await locked(exec, scope);
        if (current.version !== expectedVersion) throw new Error('Stale Build session version');
        assertTransition(current.state, state);
        await exec(`UPDATE build_sessions SET state = ?, failure_reason = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP(3), last_activity_at = CURRENT_TIMESTAMP(3) WHERE ${scopeWhere}`, [state, reason, ...scopeValues(scope)]);
        await event(exec, scope.session_id, expectedVersion + 1, state, reason);
      });
    },
    async registerResource(actor: string, scope: BuildScope, kind: ResourceKind): Promise<string> {
      await authorize(actor, scope, 'agent.run');
      if (!RESOURCE_KINDS.includes(kind)) throw new Error('Invalid Build resource kind');
      return deps.transaction(async exec => {
        const current = await locked(exec, scope);
        if (['FAILED', 'CANCELLED', 'READY_TO_DEPLOY'].includes(current.state)) throw new Error('Build session is terminal');
        const id = randomUUID();
        await exec('INSERT INTO build_resources (resource_id, session_id, owner_user_id, organization_id, project_id, kind) VALUES (?, ?, ?, ?, ?, ?)', [id, ...scopeValues(scope), kind]);
        return id;
      });
    },
    /** Trusted worktree controller only. Revision is the verified worktree HEAD,
     * not a client-selected branch. Clears stale preview identity on every bind. */
    async bindPreviewWorktree(actor: string, scope: BuildScope, expectedVersion: number, worktreeId: string, revision: string): Promise<void> {
      await authorize(actor, scope, 'agent.run');
      assertIdentifier(worktreeId); assertSource('IMPORT_REPOSITORY', revision);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('Invalid Build version');
      await deps.transaction(async exec => {
        const current = await locked(exec, scope);
        if (current.version !== expectedVersion) throw new Error('Stale Build session version');
        if (!['BUILDING', 'PREVIEW_STARTING'].includes(current.state)) throw new Error('Build session cannot bind a preview worktree');
        const rows = await exec<Array<BuildScope & { kind: ResourceKind }>>(`SELECT resource_id, session_id, owner_user_id, organization_id, project_id, kind FROM build_resources WHERE resource_id = ? AND ${scopeWhere} FOR UPDATE`, [worktreeId, ...scopeValues(scope)]);
        if (!rows[0] || rows[0].kind !== 'worktree') throw new Error('Registered worktree required');
        assertOwnership(scope, rows[0]);
        await exec(`UPDATE build_sessions SET active_worktree_id = ?, active_preview_revision = ?, preview_id = NULL, version = version + 1, updated_at = CURRENT_TIMESTAMP(3), last_activity_at = CURRENT_TIMESTAMP(3) WHERE ${scopeWhere}`, [worktreeId, revision, ...scopeValues(scope)]);
        await event(exec, scope.session_id, expectedVersion + 1, current.state);
      });
    },
    async getResource(actor: string, scope: BuildScope, resourceId: string) {
      await authorize(actor, scope, 'agent.read');
      assertIdentifier(resourceId);
      return deps.transaction(async exec => {
        await locked(exec, scope);
        const rows = await exec<Array<BuildScope & { resource_id: string; kind: ResourceKind }>>(`SELECT resource_id, session_id, owner_user_id, organization_id, project_id, kind FROM build_resources WHERE resource_id = ? AND ${scopeWhere}`, [resourceId, ...scopeValues(scope)]);
        if (!rows[0]) throw new Error('Build resource not found');
        assertOwnership(scope, rows[0]);
        return rows[0];
      });
    },
  };
}
