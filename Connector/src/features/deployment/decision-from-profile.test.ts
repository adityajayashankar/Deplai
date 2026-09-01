import assert from 'node:assert/strict';
import test from 'node:test';
import {
  budgetCapFromAnswers,
  buildScriptedHistory,
  decisionFromDeploymentProfile,
  nextScriptedQuestionIndex,
  resolveScriptedQuestionCursor,
} from './decision-from-profile';

test('budgetCapFromAnswers parses chips and rejects junk', () => {
  assert.equal(budgetCapFromAnswers({ q_budget: '50' }), 50);
  assert.equal(budgetCapFromAnswers({ q_budget: '$250' }), 250);
  assert.equal(budgetCapFromAnswers({}), 100);
  assert.equal(budgetCapFromAnswers({ q_budget: '0' }), 100);
});

test('nextScriptedQuestionIndex walks unanswered keys including skips', () => {
  const questions = [{ id: 'q_environment' }, { id: 'q_budget' }, { id: 'q_domain' }];
  assert.equal(nextScriptedQuestionIndex(questions, {}), 0);
  assert.equal(nextScriptedQuestionIndex(questions, { q_environment: 'production' }), 1);
  assert.equal(nextScriptedQuestionIndex(questions, { q_environment: 'production', q_budget: '50', q_domain: '' }), 3);
});

test('resolveScriptedQuestionCursor lets the user reopen earlier questions', () => {
  assert.equal(resolveScriptedQuestionCursor(4, 1, null), 1);
  assert.equal(resolveScriptedQuestionCursor(4, 4, null), 4);
  assert.equal(resolveScriptedQuestionCursor(4, 4, 0), 0);
  assert.equal(resolveScriptedQuestionCursor(4, 4, 99), 4);
  assert.equal(resolveScriptedQuestionCursor(4, 2, -1), 0);
});

test('decisionFromDeploymentProfile maps EC2 + RDS from a completed profile', () => {
  const decision = decisionFromDeploymentProfile({
    awsRegion: 'eu-north-1',
    answers: { q_budget: '50', q_public_api: 'true', q_compute_strategy: 'ec2' },
    deploymentProfile: {
      document_kind: 'deployment_profile',
      environment: 'staging',
      compute: {
        strategy: 'ec2',
        services: [{ id: 'api', process_type: 'web', port: 3000, desired_count: 1 }],
      },
      networking: {
        vpc: 'new',
        layout: 'public_subnets',
        load_balancer: {},
        ports_exposed: [80, 443],
      },
      data_layer: [{ type: 'postgresql', instance_class: 'db.t3.small', storage_gb: 20, multi_az: false, backup_retention_days: 14 }],
    },
  });
  assert.ok(decision.components.includes('ec2'));
  assert.ok(decision.components.includes('rds'));
  assert.ok(decision.components.includes('eip'));
  assert.equal(decision.need_eip, true);
  assert.equal(decision.region, 'eu-north-1');
  assert.equal((decision.stack_config.rds as { engine?: string }).engine, 'postgres');
  assert.equal((decision.stack_config.ec2 as { app_port?: number }).app_port, 3000);
  assert.equal((decision.stack_config.ec2 as { instance_type?: string }).instance_type, undefined);
});

test('decisionFromDeploymentProfile ignores Postgres 5432 as the app port', () => {
  const decision = decisionFromDeploymentProfile({
    awsRegion: 'eu-north-1',
    answers: { q_budget: '50', q_public_api: 'true', q_compute_strategy: 'ec2' },
    deploymentProfile: {
      document_kind: 'deployment_profile',
      environment: 'staging',
      compute: {
        strategy: 'ec2',
        services: [{ id: 'db', process_type: 'worker', port: 5432 }],
      },
      networking: { vpc: 'new', layout: 'public_subnets', load_balancer: {}, ports_exposed: [80, 443] },
      data_layer: [{ type: 'postgresql' }],
    },
  });
  assert.equal((decision.stack_config.ec2 as { app_port?: number }).app_port, 3000);
});

test('decisionFromDeploymentProfile honors volume, EIP, and Redis answers', () => {
  const decision = decisionFromDeploymentProfile({
    awsRegion: 'eu-north-1',
    answers: {
      q_budget: '50',
      q_public_api: 'true',
      q_compute_strategy: 'ec2',
      q_root_volume: '100',
      q_elastic_ip: 'true',
      q_redis: '7.0',
    },
    deploymentProfile: {
      document_kind: 'deployment_profile',
      environment: 'staging',
      compute: {
        strategy: 'ec2',
        root_volume_gb: 100,
        services: [{ id: 'api', process_type: 'web', port: 3000, desired_count: 1 }],
      },
      networking: {
        vpc: 'new',
        layout: 'public_subnets',
        load_balancer: { type: 'alb', public: true },
        elastic_ip: { enabled: true, associate_with: 'ec2' },
        ports_exposed: [80, 443],
      },
      data_layer: [],
    },
  });
  assert.ok(decision.components.includes('eip'));
  assert.ok(!decision.components.includes('alb'));
  assert.ok(decision.components.includes('elasticache'));
  assert.equal(decision.need_eip, true);
  assert.equal(decision.need_alb, false);
  assert.equal((decision.stack_config.ec2 as { root_volume_size_gb?: number }).root_volume_size_gb, undefined);
  assert.equal((decision.stack_config.elasticache as { engine?: string }).engine, 'redis');
});

test('decisionFromDeploymentProfile skips EIP and Redis when the user says no', () => {
  const decision = decisionFromDeploymentProfile({
    awsRegion: 'eu-north-1',
    answers: {
      q_public_api: 'true',
      q_compute_strategy: 'ec2',
      q_load_balancer: 'alb',
      q_elastic_ip: 'false',
      q_redis: 'none',
    },
    deploymentProfile: {
      compute: {
        strategy: 'ec2',
        services: [{ id: 'api', process_type: 'web', port: 3000, desired_count: 1 }],
      },
      networking: {
        vpc: 'new',
        load_balancer: { type: 'alb', public: true },
        elastic_ip: {},
      },
      data_layer: [{ type: 'redis', engine_version: '7.0' }],
    },
  });
  assert.equal(decision.need_eip, false);
  assert.ok(decision.components.includes('alb'));
  assert.ok(!decision.components.includes('elasticache'));
});

test('buildScriptedHistory uses option labels', () => {
  const history = buildScriptedHistory(
    [
      { id: 'q_budget', question: 'Budget?', options: [{ value: '50', label: '$50 / mo' }] },
      { id: 'q_domain', question: 'Domain?' },
    ],
    { q_budget: '50' },
    1,
  );
  assert.equal(history[0]?.content, 'Budget?');
  assert.equal(history[1]?.content, '$50 / mo');
  assert.equal(history[2]?.content, 'Domain?');
});
