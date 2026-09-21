export const BUILD_STATES = ['DRAFT', 'ANALYZING', 'PLANNING', 'BUILDING', 'PREVIEW_STARTING', 'PREVIEW_READY', 'VERIFYING', 'WAITING_FOR_USER', 'READY_TO_DEPLOY', 'FAILED', 'CANCELLED'] as const;
export type BuildState = typeof BUILD_STATES[number];
export type SourceType = 'NEW_PROJECT' | 'IMPORT_REPOSITORY';
export type BuildScope = { owner_user_id: string; organization_id: string; project_id: string; session_id: string };
export type BuildSession = BuildScope & {
  source_type: SourceType;
  source_revision: string | null;
  state: BuildState;
  active_worktree_id: string | null;
  active_preview_revision: string | null;
  preview_id: string | null;
  secret_scope_id: string;
  quota_profile_id: string;
  created_at: string | Date;
  updated_at: string | Date;
  last_activity_at: string | Date;
  failure_reason: string | null;
  version: number;
};
export const RESOURCE_KINDS = ['workspace', 'worktree', 'preview', 'database', 'cache', 'worker', 'secret_scope', 'log', 'artifact', 'browser'] as const;
export type ResourceKind = typeof RESOURCE_KINDS[number];

export function assertIdentifier(value: string): void {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error('Invalid Build identifier');
}
export function assertScope(scope: BuildScope): void {
  for (const key of ['owner_user_id', 'organization_id', 'project_id', 'session_id'] as const) assertIdentifier(scope[key]);
}
export function assertOwnership(expected: BuildScope, actual: BuildScope): void {
  assertScope(expected);
  assertScope(actual);
  if (expected.owner_user_id !== actual.owner_user_id || expected.organization_id !== actual.organization_id || expected.project_id !== actual.project_id || expected.session_id !== actual.session_id) throw new Error('Build resource access denied');
}
export function assertSource(type: SourceType, revision: string | null): void {
  if (type !== 'NEW_PROJECT' && type !== 'IMPORT_REPOSITORY') throw new Error('Invalid Build source type');
  if ((type === 'IMPORT_REPOSITORY' && !revision) || (revision !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))) throw new Error('An exact source revision is required');
}
