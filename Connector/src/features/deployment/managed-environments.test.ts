import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isApplyingDeployment,
  isAwaitingPlanConfirmation,
  isFailedDeployAttempt,
  isIacPipelineResult,
  isLiveDeployAttempt,
  isLiveManagedDeployment,
  isRealAwsInstanceId,
  iacRunIdFromResult,
  type DeployStateSnapshot,
} from './state';

function snapshot(partial: Partial<DeployStateSnapshot>): DeployStateSnapshot {
  return {
    status: 'idle',
    progress: 0,
    logs: [],
    deployResult: null,
    deploymentHistory: [],
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

test('live management requires a successful apply that has not been destroyed', () => {
  assert.equal(isLiveManagedDeployment(null), false);
  assert.equal(isLiveManagedDeployment(snapshot({ status: 'idle' })), false);
  assert.equal(isLiveManagedDeployment(snapshot({ status: 'running', deployResult: { success: true } })), false);
  assert.equal(isLiveManagedDeployment(snapshot({ status: 'error', deployResult: { success: false } })), false);
  assert.equal(
    isLiveManagedDeployment(snapshot({ status: 'done', deployResult: { success: false } })),
    false,
  );
  assert.equal(
    isLiveManagedDeployment(snapshot({ status: 'done', deployResult: { success: true, run_id: 'run-1' } })),
    true,
  );
  assert.equal(
    isLiveManagedDeployment(snapshot({ status: 'done', deployResult: { mode: 'iac_pipeline', run_id: 'run-2' } })),
    true,
  );
});

test('failed apply is retryable even if the UI still looks in-progress', () => {
  assert.equal(isFailedDeployAttempt({ status: 'idle' }), false);
  assert.equal(isFailedDeployAttempt({ status: 'running', uiPhase: 'waiting_api' }), false);
  assert.equal(isFailedDeployAttempt({ status: 'error' }), true);
  assert.equal(isFailedDeployAttempt({ status: 'running', uiPhase: 'error' }), true);
  assert.equal(isFailedDeployAttempt({ status: 'running', result: { success: false, error: 'apply failed' } }), true);
  assert.equal(isFailedDeployAttempt({ status: 'done', result: { success: true } }), false);
});

test('applying deploys are visible as in-progress, not as managed instances', () => {
  assert.equal(isApplyingDeployment(snapshot({ status: 'running' })), true);
  assert.equal(isApplyingDeployment(snapshot({ status: 'done', deployResult: { success: true } })), false);
  assert.equal(
    isApplyingDeployment(snapshot({
      status: 'running',
      deployResult: { success: true, status: 'awaiting_plan_confirmation', requires_plan_confirmation: true },
    })),
    false,
  );
});

test('plan confirmation is not treated as a live apply', () => {
  const planResult = {
    success: true,
    status: 'awaiting_plan_confirmation',
    requires_plan_confirmation: true,
  };
  assert.equal(isAwaitingPlanConfirmation({ uiPhase: 'awaiting_plan' }), true);
  assert.equal(isAwaitingPlanConfirmation({ requiresPlanConfirmation: true }), true);
  assert.equal(isAwaitingPlanConfirmation({ result: planResult }), true);
  assert.equal(isAwaitingPlanConfirmation({ uiPhase: 'waiting_api', result: { success: true } }), false);
  assert.equal(isLiveDeployAttempt({ status: 'running', uiPhase: 'waiting_api' }), true);
  assert.equal(isLiveDeployAttempt({
    status: 'running',
    uiPhase: 'awaiting_plan',
    requiresPlanConfirmation: true,
    result: planResult,
  }), false);
  assert.equal(isLiveDeployAttempt({
    status: 'idle',
    uiPhase: 'awaiting_plan',
    requiresPlanConfirmation: true,
    result: planResult,
  }), false);
  assert.equal(isLiveDeployAttempt({
    status: 'running',
    uiPhase: 'starting',
    requiresPlanConfirmation: false,
    result: planResult,
  }), true);
});

test('real instance ids reject placeholders used before apply', () => {
  assert.equal(isRealAwsInstanceId('i-0abc123def'), true);
  assert.equal(isRealAwsInstanceId('n/a'), false);
  assert.equal(isRealAwsInstanceId('project-abc'), false);
  assert.equal(isRealAwsInstanceId(''), false);
});

test('IaC pipeline identity comes from the apply result, not planning state', () => {
  assert.equal(isIacPipelineResult({ mode: 'iac_pipeline', run_id: 'r1' }), true);
  assert.equal(isIacPipelineResult({ mode: 'terraform' }), false);
  assert.equal(iacRunIdFromResult({ run_id: '  r-9  ' }), 'r-9');
  assert.equal(iacRunIdFromResult({ success: true }), null);
});
