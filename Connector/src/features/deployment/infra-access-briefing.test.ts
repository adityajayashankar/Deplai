import assert from 'node:assert/strict';
import test from 'node:test';
import { extractDeploymentSummary, flattenDeployOutputs } from './state';
import {
  buildInfraAccessBriefing,
  emptyDeploymentSummary,
  firstProvisioned,
  isProvisionedValue,
  isSensitiveOutputKey,
} from './infra-access-briefing';

test('isProvisionedValue hides empty terraform placeholders', () => {
  assert.equal(isProvisionedValue('n/a'), false);
  assert.equal(isProvisionedValue(''), false);
  assert.equal(isProvisionedValue(null), false);
  assert.equal(isProvisionedValue('54.1.2.3'), true);
});

test('flattenDeployOutputs hydrates IaC pipeline output bags', () => {
  const flat = flattenDeployOutputs({
    service_type: 'ec2',
    deployed_at: '2026-08-27T00:00:00.000Z',
    outputs: [
      { key: 'app_url', value: 'http://1.2.3.4' },
      { key: 'elastic_ip', value: '1.2.3.4' },
      { key: 'rds_port', value: 5432 },
    ],
  });
  assert.equal(flat?.app_url, 'http://1.2.3.4');
  assert.equal(flat?.elastic_ip, '1.2.3.4');
  assert.equal(flat?.rds_port, 5432);
});

test('extractDeploymentSummary reads flattened IaC outputs and ports', () => {
  const summary = extractDeploymentSummary({
    success: true,
    mode: 'iac_pipeline',
    outputs: {
      service_type: 'ec2',
      deployed_at: '2026-08-27T00:00:00.000Z',
      outputs: [
        { key: 'app_url', value: 'http://1.2.3.4' },
        { key: 'elastic_ip', value: '1.2.3.4' },
        { key: 'ec2_instance_id', value: 'i-abc' },
        { key: 'ec2_instance_type', value: 't3.micro' },
        { key: 'rds_endpoint', value: 'db.internal:5432' },
        { key: 'rds_port', value: 5432 },
        { key: 'redis_endpoint', value: 'cache.internal' },
        { key: 'health_check_url', value: 'http://1.2.3.4/health' },
      ],
    },
  });
  assert.equal(summary.appUrl, 'http://1.2.3.4');
  assert.equal(summary.elasticIp, '1.2.3.4');
  assert.equal(summary.instanceId, 'i-abc');
  assert.equal(summary.rdsPort, '5432');
  assert.equal(summary.redisEndpoint, 'cache.internal');
  assert.equal(summary.healthCheckUrl, 'http://1.2.3.4/health');
});

test('buildInfraAccessBriefing prefers Elastic IP for SSH and omits n/a rows', () => {
  const briefing = buildInfraAccessBriefing({
    summary: {
      ...emptyDeploymentSummary(),
      appUrl: 'http://18.1.1.1',
      elasticIp: '18.1.1.1',
      publicIp: '3.3.3.3',
      instanceId: 'i-abc',
      instanceType: 't3.micro',
      instanceState: 'running',
      keyName: 'deplai-prod-key',
      vpcId: 'vpc-1',
      rdsEndpoint: 'n/a',
      albDns: 'n/a',
      cloudfrontUrl: 'n/a',
    },
    region: 'eu-north-1',
    planned: {
      plan: 'ec2',
      diskGb: 50,
      appPort: 3000,
      instanceType: 't3.micro',
    },
  });
  assert.equal(briefing.strategy, 'ec2');
  assert.equal(briefing.appUrl, 'http://18.1.1.1');
  assert.equal(briefing.sshHost, '18.1.1.1');
  assert.match(briefing.sshCommand || '', /ec2-user@18\.1\.1\.1/);
  assert.match(briefing.sshCommand || '', /deplai-prod-key\.pem/);
  assert.equal(briefing.diskGb, 50);
  assert.equal(briefing.appPort, 3000);
  assert.ok(briefing.access.every((row) => row.value !== 'n/a'));
  assert.ok(briefing.compute.some((row) => row.label === 'Root disk' && row.value === '50 GB gp3'));
  assert.equal(briefing.access.some((row) => row.label === 'Public IP'), true);
});

test('buildInfraAccessBriefing exposes RDS/Redis connect commands from private endpoints', () => {
  const briefing = buildInfraAccessBriefing({
    summary: {
      ...emptyDeploymentSummary(),
      appUrl: 'http://18.1.1.1',
      elasticIp: '18.1.1.1',
      instanceId: 'i-abc',
      rdsEndpoint: 'orders.xxxx.eu-north-1.rds.amazonaws.com:5432',
      rdsDatabaseName: 'app',
      redisEndpoint: 'cache.xxxx.cache.amazonaws.com',
      redisPort: '6379',
    },
    region: 'eu-north-1',
    planned: {
      plan: 'ec2',
      includeRds: true,
      includeRedis: true,
      rds: {
        engine: 'postgres',
        engine_version: '16',
        instance_class: 'db.t3.micro',
        allocated_storage: 20,
        multi_az: false,
        backup_retention_period: 7,
        master_username: 'app',
      },
      redis: { node_type: 'cache.t3.micro', engine_version: '7.0' },
    },
  });
  assert.match(briefing.rdsCommand || '', /host=orders\.xxxx\.eu-north-1\.rds\.amazonaws\.com/);
  assert.match(briefing.rdsCommand || '', /port=5432/);
  assert.equal(briefing.redisCommand, 'redis-cli -h cache.xxxx.cache.amazonaws.com -p 6379');
  assert.ok(briefing.data.some((row) => row.label === 'RDS endpoint'));
  assert.ok(!briefing.sshCommand || briefing.accessSteps.some((step) => /RDS/.test(step)));
});

test('ECS briefing skips SSH and surfaces cluster specs', () => {
  const briefing = buildInfraAccessBriefing({
    summary: {
      ...emptyDeploymentSummary(),
      appUrl: 'http://my-alb.eu-north-1.elb.amazonaws.com',
      albDns: 'my-alb.eu-north-1.elb.amazonaws.com',
      ecsCluster: 'deplai-prod',
      ecrRepositoryUrl: '123.dkr.ecr.eu-north-1.amazonaws.com/app',
      logGroup: '/ecs/deplai-prod',
    },
    planned: {
      plan: 'ecs',
      ecs: { cpu: 256, memory: 512, desired_count: 1 },
    },
    region: 'eu-north-1',
  });
  assert.equal(briefing.strategy, 'ecs');
  assert.equal(briefing.sshCommand, null);
  assert.ok(briefing.compute.some((row) => row.label === 'ECS cluster'));
  assert.ok(briefing.accessSteps.some((step) => /no SSH/i.test(step)));
});

test('firstProvisioned and sensitive-key helpers', () => {
  assert.equal(firstProvisioned('n/a', '', 'i-1'), 'i-1');
  assert.equal(isSensitiveOutputKey('generated_ec2_private_key_pem'), true);
  assert.equal(isSensitiveOutputKey('app_url'), false);
});

test('buildInfraAccessBriefing does not treat RDS 5432 as the app/container port', () => {
  const briefing = buildInfraAccessBriefing({
    summary: emptyDeploymentSummary(),
    region: 'eu-north-1',
    planned: { plan: 'ec2', appPort: 5432 },
    decision: {
      region: 'eu-north-1',
      components: ['ec2', 'rds'],
      stack_config: { ec2: { app_port: 5432 } },
    } as never,
  });
  assert.equal(briefing.appPort, 3000);
});

