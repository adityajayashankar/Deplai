import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commitSuccessfulDeployment,
  deploymentHasProvisionedInfrastructure,
  isApplyingDeployment,
  isAwaitingPlanConfirmation,
  isFailedDeployAttempt,
  isIacPipelineResult,
  isLiveDeployAttempt,
  isLiveManagedDeployment,
  isRealAwsInstanceId,
  iacRunIdFromResult,
  resolveRestoredDeployUiStage,
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
  assert.equal(
    isLiveManagedDeployment(snapshot({
      status: 'done',
      deployResult: { success: true, outputs: { alb_dns_name: 'ifca-alb.eu-north-1.elb.amazonaws.com' } },
    })),
    true,
  );
  assert.equal(
    isLiveManagedDeployment(snapshot({
      status: 'idle',
      deployResult: null,
      deploymentHistory: [{
        id: 'history-run-history',
        createdAt: new Date().toISOString(),
        status: 'done',
        region: 'eu-north-1',
        instanceId: 'n/a',
        cloudfrontUrl: 'n/a',
        deployResult: { success: true, run_id: 'run-history' },
      }],
    })),
    true,
  );
});

test('provisioned infrastructure is detected from ECS and ALB outputs', () => {
  assert.equal(deploymentHasProvisionedInfrastructure(null), false);
  assert.equal(deploymentHasProvisionedInfrastructure({ success: false }), false);
  assert.equal(
    deploymentHasProvisionedInfrastructure({ success: true, outputs: { ecs_cluster_name: 'ifca-cluster' } }),
    true,
  );
  assert.equal(
    deploymentHasProvisionedInfrastructure({ success: true, outputs: { alb_dns_name: 'ifca-alb.elb.amazonaws.com' } }),
    true,
  );
  assert.equal(
    deploymentHasProvisionedInfrastructure({ success: true, ec2: { instance_id: 'i-0abc123def' } }),
    true,
  );
});

test('refresh restores outputs stage for completed deployments', () => {
  const completed = snapshot({
    status: 'done',
    deployResult: { success: true, run_id: 'run-1' },
  });
  assert.equal(resolveRestoredDeployUiStage(completed, 'analysis'), 'outputs');
  assert.equal(resolveRestoredDeployUiStage(snapshot({ status: 'running' }), 'terraform'), 'deploy');
  assert.equal(resolveRestoredDeployUiStage(snapshot({ status: 'idle' }), 'terraform'), 'terraform');
});

test('expired preparation cannot restore credentials ahead of the pipeline', () => {
  const idle = snapshot({ status: 'idle' });
  assert.equal(resolveRestoredDeployUiStage(idle, 'aws_config', {
    hasAnalysis: false, hasApprovedPlan: false, hasTerraform: false,
  }), 'analysis');
  assert.equal(resolveRestoredDeployUiStage(idle, 'aws_config', {
    hasAnalysis: true, hasApprovedPlan: true, hasTerraform: false,
  }), 'terraform');
  assert.equal(resolveRestoredDeployUiStage(idle, 'aws_config', {
    hasAnalysis: true, hasApprovedPlan: true, hasTerraform: true,
  }), 'aws_config');
  assert.equal(resolveRestoredDeployUiStage(snapshot({ status: 'running' }), 'analysis', {
    hasAnalysis: false, hasApprovedPlan: false, hasTerraform: false,
  }), 'deploy');
});

test('successful deploy commits durable history and terminal state', () => {
  const base = snapshot({ status: 'running', progress: 80 });
  const committed = commitSuccessfulDeployment(base, {
    success: true,
    run_id: 'run-9',
    outputs: { alb_dns_name: 'ifca-alb.elb.amazonaws.com' },
  }, 'eu-north-1');
  assert.equal(committed.status, 'done');
  assert.equal(committed.progress, 100);
  assert.equal(committed.deployResult?.run_id, 'run-9');
  assert.equal(committed.deploymentHistory.length, 1);
  const again = commitSuccessfulDeployment(committed, committed.deployResult!, 'eu-north-1');
  assert.equal(again.deploymentHistory.length, 1);
});

test('failed apply is retryable even if the UI still looks in-progress', () => {
  assert.equal(isFailedDeployAttempt({ status: 'idle' }), false);
  assert.equal(isFailedDeployAttempt({ status: 'running', uiPhase: 'waiting_api' }), false);
  assert.equal(isFailedDeployAttempt({ status: 'error' }), true);
  assert.equal(isFailedDeployAttempt({ status: 'running', uiPhase: 'error' }), false);
  assert.equal(isFailedDeployAttempt({ status: 'running', result: { success: false, error: 'apply failed' } }), true);
  assert.equal(isFailedDeployAttempt({ status: 'done', result: { success: true } }), false);
  assert.equal(isFailedDeployAttempt({
    status: 'done',
    uiPhase: 'error',
    result: { success: true },
  }), false);
  assert.equal(isFailedDeployAttempt({
    status: 'error',
    uiPhase: 'error',
    result: {
      apply_accepted: true,
      error: 'Connector could not reach the deployment runtime service.',
    },
  }), false);
  assert.equal(isFailedDeployAttempt({
    status: 'error',
    result: { error: 'Connector could not reach the deployment runtime service.' },
  }), false);
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
