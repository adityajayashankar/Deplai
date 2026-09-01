import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDecisionArchitectureDiagram,
  componentDetails,
  describeTopologyFlows,
  topologyComponentLabel,
  topologyEdgePath,
  topologyNodePositions,
} from './decision-topology-diagram';
import type { InfraConsultantDecision } from '@/features/deployment/state';

function sampleDecision(): InfraConsultantDecision {
  return {
    region: 'eu-north-1',
    components: ['vpc', 'eip', 'ec2', 'rds', 'elasticache'],
    deploy_sequence: ['vpc', 'eip', 'ec2', 'rds', 'elasticache'],
    stack_config: {
      ec2: { instance_type: 't3.small', app_port: 3000 },
      rds: { engine: 'postgres', instance_class: 'db.t3.micro' },
      elasticache: { engine: 'redis', node_type: 'cache.t3.micro' },
    },
    outputs_to_capture: [],
    consultant_notes: [],
    need_eip: true,
    need_alb: false,
  };
}

test('topologyComponentLabel uses AWS-friendly names for common services', () => {
  assert.equal(topologyComponentLabel('ec2'), 'EC2');
  assert.equal(topologyComponentLabel('elasticache'), 'ElastiCache');
  assert.equal(topologyComponentLabel('alb'), 'Application Load Balancer');
});

test('componentDetails is exported for planning summaries', () => {
  assert.deepEqual(
    componentDetails('ec2', { ec2: { instance_type: 't3.small', app_port: 3000 } }),
    ['t3.small', 'port 3000'],
  );
});

test('buildDecisionArchitectureDiagram places tiers with labeled edges', () => {
  const model = buildDecisionArchitectureDiagram(sampleDecision(), 'eu-north-1');
  assert.equal(model.hasPrivateTier, true);
  assert.equal(model.nodes.some((node) => node.id === 'internet'), true);
  assert.equal(model.nodes.some((node) => node.tier === 'public' && node.label === 'EC2'), true);
  assert.equal(model.nodes.some((node) => node.tier === 'private' && node.label === 'RDS'), true);

  const internetToEip = model.edges.find((edge) => edge.from === 'internet');
  assert.equal(internetToEip?.label, 'Inbound TCP');

  const ec2ToRds = model.edges.find((edge) => edge.from === 'ec2' && edge.to === 'rds');
  assert.equal(ec2ToRds?.label, 'SQL');
});

test('buildDecisionArchitectureDiagram centers nodes within subnet bounds', () => {
  const model = buildDecisionArchitectureDiagram(sampleDecision(), 'eu-north-1');
  const publicNodes = model.nodes.filter((node) => node.tier === 'public');
  const privateNodes = model.nodes.filter((node) => node.tier === 'private');
  assert.equal(publicNodes.length, 2);
  assert.equal(privateNodes.length, 2);
  assert.ok(publicNodes[0].x > 220);
  assert.ok(privateNodes[0].x > 220);
});

test('describeTopologyFlows returns labeled traffic paths', () => {
  const model = buildDecisionArchitectureDiagram(sampleDecision(), 'eu-north-1');
  const flows = describeTopologyFlows(model);
  assert.ok(flows.some((line) => line.includes('Elastic IP') && line.includes('EC2')));
  assert.ok(flows.some((line) => line.includes('EC2') && line.includes('RDS') && line.includes('SQL')));
});

test('topologyEdgePath routes cross-tier edges orthogonally', () => {
  const positions = topologyNodePositions([
    {
      id: 'ec2',
      label: 'EC2',
      x: 300,
      y: 156,
      color: '#d29922',
      category: 'compute',
      tier: 'public',
      details: [],
    },
    {
      id: 'rds',
      label: 'RDS',
      x: 300,
      y: 348,
      color: '#3fb950',
      category: 'data',
      tier: 'private',
      details: [],
    },
  ]);

  const from = positions.get('ec2');
  const to = positions.get('rds');
  assert.ok(from && to);

  const { path } = topologyEdgePath(from!, to!);
  assert.equal(path.includes('L'), true);
  assert.ok(path.split('L').length > 2);
});
