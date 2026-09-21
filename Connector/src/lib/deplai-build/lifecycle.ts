import { BUILD_STATES, type BuildState } from './contracts';

const transitions: Record<BuildState, readonly BuildState[]> = {
  DRAFT: ['ANALYZING', 'CANCELLED', 'FAILED'],
  ANALYZING: ['PLANNING', 'WAITING_FOR_USER', 'CANCELLED', 'FAILED'],
  PLANNING: ['BUILDING', 'WAITING_FOR_USER', 'CANCELLED', 'FAILED'],
  BUILDING: ['PREVIEW_STARTING', 'WAITING_FOR_USER', 'CANCELLED', 'FAILED'],
  PREVIEW_STARTING: ['PREVIEW_READY', 'WAITING_FOR_USER', 'CANCELLED', 'FAILED'],
  PREVIEW_READY: ['BUILDING', 'VERIFYING', 'WAITING_FOR_USER', 'CANCELLED', 'FAILED'],
  VERIFYING: ['READY_TO_DEPLOY', 'WAITING_FOR_USER', 'BUILDING', 'CANCELLED', 'FAILED'],
  WAITING_FOR_USER: ['ANALYZING', 'PLANNING', 'BUILDING', 'CANCELLED', 'FAILED'],
  READY_TO_DEPLOY: [], FAILED: [], CANCELLED: [],
};

/** Trusted orchestrator only. Evidence-producing preview/verifier phases are not installed yet. */
export function assertTransition(from: BuildState, to: BuildState): void {
  if (!BUILD_STATES.includes(from) || !BUILD_STATES.includes(to) || !transitions[from].includes(to)) throw new Error('Invalid Build state transition');
  // Fail closed rather than accepting model/browser supplied healthy=true evidence.
  if (to === 'PREVIEW_READY' || to === 'READY_TO_DEPLOY') throw new Error('Trusted readiness verification is not implemented');
}

export const FAILURE_CODES = ['ANALYSIS_FAILED', 'POLICY_DENIED', 'QUOTA_EXCEEDED', 'WORKER_FAILED', 'TIMEOUT', 'INTERNAL_ERROR'] as const;
export type FailureCode = typeof FAILURE_CODES[number];
export function assertFailure(to: BuildState, reason: FailureCode | null): void {
  if (to === 'FAILED' ? !FAILURE_CODES.includes(reason as FailureCode) : reason !== null) throw new Error('Invalid Build failure code');
}
