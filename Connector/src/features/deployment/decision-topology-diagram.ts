import type { InfraConsultantDecision } from '@/features/deployment/state';

export type TopologyNodeCategory = 'networking' | 'compute' | 'data' | 'security' | 'observability';

export type TopologyNodeTier = 'internet' | 'public' | 'private';

export type DecisionDiagramNode = {
  id: string;
  label: string;
  x: number;
  y: number;
  color: string;
  category: TopologyNodeCategory;
  tier: TopologyNodeTier;
  details: string[];
};

export type DecisionDiagramEdge = {
  from: string;
  to: string;
  label: string;
};

export type DecisionDiagramModel = {
  awsRegion: string;
  components: string[];
  nodes: DecisionDiagramNode[];
  edges: DecisionDiagramEdge[];
  hasVpcBoundary: boolean;
  hasMultiAz: boolean;
  hasPrivateTier: boolean;
  canvasHeight: number;
};

export const TOPOLOGY_NODE_WIDTH = 140;

const TOPOLOGY_DISPLAY_NAMES: Record<string, string> = {
  ec2: 'EC2',
  ecs: 'ECS Fargate',
  rds: 'RDS',
  elasticache: 'ElastiCache',
  redis: 'ElastiCache',
  alb: 'Application Load Balancer',
  eip: 'Elastic IP',
  s3_cloudfront: 'S3 + CloudFront',
  cloudfront: 'CloudFront',
  vpc: 'VPC',
  waf: 'WAF',
  iam: 'IAM',
  'account-map': 'Account Map',
};

export function topologyComponentLabel(component: string): string {
  const key = String(component || '').trim().toLowerCase();
  if (TOPOLOGY_DISPLAY_NAMES[key]) return TOPOLOGY_DISPLAY_NAMES[key];
  const value = String(component || '').trim();
  if (!value) return 'Component';
  return value
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toPositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function canonicalTopologyComponent(value: unknown): string {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const compact = raw.replace(/[\s\-]+/g, '_');
  if (compact === 'account_map' || compact === 'accountmap' || (compact.includes('account') && compact.includes('map'))) {
    return 'account-map';
  }
  if (compact === 's3_cloudfront' || compact === 'cloudfront' || compact === 's3cloudfront') {
    return 's3_cloudfront';
  }
  if (compact === 'elasticache' || compact === 'redis' || compact === 'cache') {
    return 'elasticache';
  }
  if (compact === 'rds' || compact.includes('postgres') || compact.includes('database')) {
    return 'rds';
  }
  if (compact === 'ecs' || compact.includes('fargate')) {
    return 'ecs';
  }
  if (compact === 'ec2' || compact === 'ec2_instance' || compact === 'ec2instance') {
    return 'ec2';
  }
  if (compact === 'alb' || compact.includes('load_balancer') || compact === 'application_load_balancer') {
    return 'alb';
  }
  if (compact === 'eip' || compact === 'elastic_ip' || compact === 'elasticip') {
    return 'eip';
  }
  if (compact.includes('vpc') || compact === 'networking' || compact.includes('network')) {
    return compact === 'networking' ? 'networking' : 'vpc';
  }
  return compact;
}

function normalizeDecisionComponents(decision: InfraConsultantDecision | null | undefined): string[] {
  if (!decision) return [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (value: unknown) => {
    const normalized = canonicalTopologyComponent(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    ordered.push(normalized);
  };

  if (Array.isArray(decision.components)) {
    for (const item of decision.components) push(item);
  }
  if (ordered.length === 0 && Array.isArray(decision.deploy_sequence)) {
    for (const item of decision.deploy_sequence) push(item);
  }
  if (ordered.length === 0 && decision.stack_config && typeof decision.stack_config === 'object') {
    for (const key of Object.keys(decision.stack_config as Record<string, unknown>)) push(key);
  }

  return ordered;
}

function normalizeDecisionSequence(decision: InfraConsultantDecision | null | undefined): string[] {
  if (!decision) return [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (value: unknown) => {
    const normalized = canonicalTopologyComponent(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    ordered.push(normalized);
  };

  if (Array.isArray(decision.deploy_sequence)) {
    for (const item of decision.deploy_sequence) push(item);
  }
  if (ordered.length === 0 && Array.isArray(decision.components)) {
    for (const item of decision.components) push(item);
  }
  if (ordered.length === 0 && decision.stack_config && typeof decision.stack_config === 'object') {
    for (const key of Object.keys(decision.stack_config as Record<string, unknown>)) push(key);
  }

  return ordered;
}

function decisionCategory(component: string): TopologyNodeCategory {
  const key = String(component || '').toLowerCase();
  if (
    key.includes('vpc')
    || key.includes('alb')
    || key.includes('eip')
    || key.includes('nat')
    || key.includes('subnet')
    || key.includes('igw')
    || key.includes('route')
  ) {
    return 'networking';
  }
  if (key.includes('ecs') || key.includes('ec2') || key.includes('lambda') || key.includes('compute')) return 'compute';
  if (key.includes('rds') || key.includes('redis') || key.includes('cache') || key.includes('db') || key.includes('s3') || key.includes('elasticache')) return 'data';
  if (key.includes('waf') || key.includes('iam') || key.includes('sg') || key.includes('security')) return 'security';
  return 'observability';
}

function decisionColor(category: TopologyNodeCategory): string {
  // Match deployment-workspace recessed tokens (--dw-info, --dw-warn, --dw-ok, etc.)
  if (category === 'networking') return '#58a6ff';
  if (category === 'compute') return '#d29922';
  if (category === 'data') return '#3fb950';
  if (category === 'security') return '#f85149';
  return '#8b949e';
}

export function componentDetails(component: string, stackConfig: Record<string, unknown>): string[] {
  const config = toRecord(stackConfig[component] || (component === 'ec2' ? stackConfig['ec2-instance'] : undefined));
  const key = String(component || '').toLowerCase();

  if (key === 'ecs' || key === 'ec2') {
    const parts: string[] = [];
    const instanceType = String(config.instance_type || '').trim();
    const appPort = toPositiveNumber(config.app_port);
    const desired = toPositiveNumber(config.desired_count);
    if (instanceType) parts.push(instanceType);
    if (appPort) parts.push(`port ${appPort}`);
    if (desired && desired > 1) parts.push(`${desired} instances`);
    return parts.slice(0, 2);
  }

  if (key === 'rds') {
    const parts: string[] = [];
    const engine = String(config.engine || '').trim();
    const instance = String(config.instance_class || '').trim();
    if (engine) parts.push(engine);
    if (instance) parts.push(instance);
    if (config.multi_az === true) parts.push('Multi-AZ');
    return parts.slice(0, 2);
  }

  if (key === 'elasticache' || key === 'redis') {
    const parts: string[] = [];
    const engine = String(config.engine || 'redis').trim();
    const nodeType = String(config.node_type || '').trim();
    if (engine) parts.push(engine);
    if (nodeType) parts.push(nodeType);
    return parts.slice(0, 2);
  }

  if (key === 'alb') {
    return ['HTTP / HTTPS'];
  }

  if (key === 'eip') {
    return ['Static public IP'];
  }

  if (key === 's3_cloudfront' || key === 'cloudfront') {
    return ['CDN delivery'];
  }

  return [];
}

export function getTopologyNodeHeight(node: DecisionDiagramNode): number {
  return 48 + Math.min(2, node.details.length) * 14;
}

function isBoundaryOnlyComponent(component: string): boolean {
  const key = String(component || '').toLowerCase();
  return key === 'vpc' || key === 'subnet' || key === 'public_subnet' || key === 'private_subnet';
}

function isPrivatePlacement(component: string): boolean {
  const key = String(component || '').toLowerCase();
  return key.includes('rds') || key.includes('redis') || key.includes('elasticache') || key.includes('db');
}

function edgeLabelFor(fromComponent: string, toComponent: string): string {
  const from = String(fromComponent || '').toLowerCase();
  const to = String(toComponent || '').toLowerCase();

  if (from === 'internet') {
    if (to === 'alb') return 'Inbound HTTP';
    if (to === 'eip') return 'Inbound TCP';
    if (to === 'ec2' || to === 'ecs') return 'Direct access';
    if (to === 's3_cloudfront') return 'HTTPS';
    return 'Traffic';
  }

  if (from === 'alb' && (to === 'ec2' || to === 'ecs')) return 'HTTP';
  if (from === 'eip' && (to === 'ec2' || to === 'ecs')) return 'TCP';
  if ((from === 'ec2' || from === 'ecs') && to === 'rds') return 'SQL';
  if ((from === 'ec2' || from === 'ecs') && (to === 'elasticache' || to === 'redis')) return 'Cache';
  if (from === 'rds' && to.includes('replica')) return 'Replication';

  return '';
}

function componentForNodeId(nodeId: string, entryNodeByComponent: Map<string, string>): string {
  for (const [component, id] of entryNodeByComponent.entries()) {
    if (id === nodeId) return component;
  }
  if (nodeId.startsWith('rds-')) return 'rds';
  return nodeId;
}

function buildMeaningfulEdges(
  components: string[],
  entryNodeByComponent: Map<string, string>,
): DecisionDiagramEdge[] {
  const edges: DecisionDiagramEdge[] = [];
  const id = (component: string) => entryNodeByComponent.get(component) || '';
  const has = (component: string) => Boolean(id(component));
  const push = (fromId: string, toId: string, fromComponent = '', toComponent = '') => {
    if (!fromId || !toId || fromId === toId) return;
    if (edges.some((item) => item.from === fromId && item.to === toId)) return;
    const label = edgeLabelFor(fromComponent, toComponent);
    edges.push({ from: fromId, to: toId, label });
  };

  const frontDoor = has('alb') ? 'alb' : has('eip') ? 'eip' : has('ec2') ? 'ec2' : has('ecs') ? 'ecs' : components[0] || '';
  if (frontDoor) push('internet', id(frontDoor), 'internet', frontDoor);

  if (has('alb') && has('ec2')) push(id('alb'), id('ec2'), 'alb', 'ec2');
  if (has('alb') && has('ecs')) push(id('alb'), id('ecs'), 'alb', 'ecs');
  if (!has('alb') && has('eip') && has('ec2')) push(id('eip'), id('ec2'), 'eip', 'ec2');
  if (!has('alb') && has('eip') && has('ecs')) push(id('eip'), id('ecs'), 'eip', 'ecs');
  if (has('ec2') && has('rds')) push(id('ec2'), id('rds'), 'ec2', 'rds');
  if (has('ecs') && has('rds')) push(id('ecs'), id('rds'), 'ecs', 'rds');
  if (has('ec2') && (has('elasticache') || has('redis'))) {
    push(id('ec2'), id('elasticache') || id('redis'), 'ec2', 'elasticache');
  }
  if (has('ecs') && (has('elasticache') || has('redis'))) {
    push(id('ecs'), id('elasticache') || id('redis'), 'ecs', 'elasticache');
  }

  if (edges.length <= 1) {
    const chain = components.map((component) => id(component)).filter(Boolean);
    if (chain[0]) push('internet', chain[0], 'internet', componentForNodeId(chain[0], entryNodeByComponent));
    for (let index = 1; index < chain.length; index += 1) {
      push(
        chain[index - 1],
        chain[index],
        componentForNodeId(chain[index - 1], entryNodeByComponent),
        componentForNodeId(chain[index], entryNodeByComponent),
      );
    }
  }

  return edges;
}

function centerRowStart(count: number, nodeWidth: number, gap: number, subnetLeft: number, subnetWidth: number): number {
  if (count <= 0) return subnetLeft;
  const totalWidth = count * nodeWidth + (count - 1) * gap;
  return subnetLeft + Math.max(0, (subnetWidth - totalWidth) / 2);
}

export function buildDecisionArchitectureDiagram(
  decision: InfraConsultantDecision | null | undefined,
  awsRegion: string,
  defaultRegion = 'eu-north-1',
): DecisionDiagramModel {
  const components = normalizeDecisionComponents(decision);
  const deploySequence = normalizeDecisionSequence(decision);
  const orderedComponents: string[] = [];
  const seen = new Set<string>();
  for (const component of [...deploySequence, ...components]) {
    if (!component || seen.has(component)) continue;
    seen.add(component);
    orderedComponents.push(component);
  }
  const stackConfig = decision?.stack_config && typeof decision.stack_config === 'object'
    ? decision.stack_config as Record<string, unknown>
    : {};
  const rds = stackConfig.rds && typeof stackConfig.rds === 'object' ? stackConfig.rds as Record<string, unknown> : {};
  const hasMultiAz = Boolean(rds.multi_az);
  const visibleComponents = orderedComponents.filter((component) => !isBoundaryOnlyComponent(component));
  const hasVpcBoundary = orderedComponents.includes('vpc') || visibleComponents.length > 0;
  const publicRank = (component: string) => {
    const key = String(component || '').toLowerCase();
    if (key === 'alb') return 0;
    if (key === 'eip') return 1;
    if (key === 'ec2' || key === 'ecs') return 2;
    if (key === 's3_cloudfront') return 3;
    return 4;
  };
  const publicComponents = visibleComponents
    .filter((component) => !isPrivatePlacement(component))
    .sort((left, right) => publicRank(left) - publicRank(right));
  const privateComponents = visibleComponents.filter((component) => isPrivatePlacement(component));
  const hasPrivateTier = privateComponents.length > 0;

  const SUBNET_LEFT = 220;
  const SUBNET_WIDTH = 680;
  const NODE_GAP = 24;
  const PUBLIC_ROW_Y = 156;
  const PRIVATE_ROW_Y = 348;
  const NODE_WIDTH = TOPOLOGY_NODE_WIDTH;

  const nodes: DecisionDiagramNode[] = [];
  const entryNodeByComponent = new Map<string, string>();
  const pushNode = (node: DecisionDiagramNode) => {
    if (!nodes.some((item) => item.id === node.id)) nodes.push(node);
  };

  const publicCount = publicComponents.reduce((count, component) => {
    if (component === 'rds' && hasMultiAz) return count + 2;
    return count + 1;
  }, 0);
  const privateCount = privateComponents.reduce((count, component) => {
    if (component === 'rds' && hasMultiAz) return count + 2;
    return count + 1;
  }, 0);

  const publicStartX = centerRowStart(publicCount, NODE_WIDTH, NODE_GAP, SUBNET_LEFT, SUBNET_WIDTH);
  const privateStartX = centerRowStart(privateCount, NODE_WIDTH, NODE_GAP, SUBNET_LEFT, SUBNET_WIDTH);
  const internetY = publicComponents.length > 0
    ? PUBLIC_ROW_Y + getTopologyNodeHeight({
      id: 'tmp',
      label: '',
      x: 0,
      y: 0,
      color: '',
      category: 'networking',
      tier: 'public',
      details: componentDetails(publicComponents[0], stackConfig),
    }) / 2 - 24
    : 210;

  pushNode({
    id: 'internet',
    label: 'Internet',
    x: 48,
    y: internetY,
    color: '#a1a1aa',
    category: 'networking',
    tier: 'internet',
    details: ['Public traffic'],
  });

  const placeRow = (items: string[], startY: number, tier: TopologyNodeTier, startX: number) => {
    let column = 0;
    for (const component of items) {
      const category = decisionCategory(component);
      const color = decisionColor(category);
      const label = topologyComponentLabel(component);
      const details = componentDetails(component, stackConfig);
      const x = startX + column * (NODE_WIDTH + NODE_GAP);
      const y = startY;

      if (component === 'rds' && hasMultiAz) {
        const primaryId = 'rds-primary';
        const replicaId = 'rds-replica';
        pushNode({ id: primaryId, label: 'RDS Primary', x, y, color, category, tier, details });
        pushNode({
          id: replicaId,
          label: 'RDS Standby',
          x: x + NODE_WIDTH + NODE_GAP,
          y,
          color,
          category,
          tier,
          details: ['Failover replica'],
        });
        entryNodeByComponent.set(component, primaryId);
        column += 2;
        continue;
      }

      if (entryNodeByComponent.has(component)) continue;

      const nodeId = component.replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();
      if (nodes.some((item) => item.id === nodeId)) {
        entryNodeByComponent.set(component, nodeId);
        continue;
      }
      pushNode({
        id: nodeId,
        label,
        x,
        y,
        color,
        category,
        tier,
        details,
      });
      entryNodeByComponent.set(component, nodeId);
      column += 1;
    }
  };

  placeRow(publicComponents, PUBLIC_ROW_Y, 'public', publicStartX);
  placeRow(privateComponents, PRIVATE_ROW_Y, 'private', privateStartX);

  const edges = buildMeaningfulEdges(visibleComponents, entryNodeByComponent);
  if (hasMultiAz && entryNodeByComponent.get('rds') === 'rds-primary') {
    edges.push({ from: 'rds-primary', to: 'rds-replica', label: 'Replication' });
  }

  const canvasHeight = hasPrivateTier ? 560 : 400;

  return {
    awsRegion: String(awsRegion || defaultRegion).trim() || defaultRegion,
    components: visibleComponents.length > 0 ? visibleComponents : orderedComponents,
    nodes,
    edges,
    hasVpcBoundary,
    hasMultiAz,
    hasPrivateTier,
    canvasHeight,
  };
}

export type TopologyNodePosition = {
  x: number;
  y: number;
  height: number;
  tier: TopologyNodeTier;
};

export function topologyNodePositions(nodes: DecisionDiagramNode[]): Map<string, TopologyNodePosition> {
  const map = new Map<string, TopologyNodePosition>();
  for (const node of nodes) {
    map.set(node.id, { x: node.x, y: node.y, height: getTopologyNodeHeight(node), tier: node.tier });
  }
  return map;
}

export function topologyEdgePath(
  from: TopologyNodePosition,
  to: TopologyNodePosition,
  nodeWidth = TOPOLOGY_NODE_WIDTH,
): { path: string; labelX: number; labelY: number } {
  const fromCenterX = from.x + nodeWidth / 2;
  const fromCenterY = from.y + from.height / 2;
  const toCenterX = to.x + nodeWidth / 2;
  const toCenterY = to.y + to.height / 2;

  const fromRight = { x: from.x + nodeWidth, y: fromCenterY };
  const fromBottom = { x: fromCenterX, y: from.y + from.height };
  const toLeft = { x: to.x, y: toCenterY };
  const toTop = { x: toCenterX, y: to.y };

  if (from.tier === 'internet' && to.tier === 'public') {
    const path = `M ${fromRight.x} ${fromRight.y} L ${toLeft.x} ${toLeft.y}`;
    return { path, labelX: (fromRight.x + toLeft.x) / 2, labelY: fromRight.y - 10 };
  }

  if (from.tier === 'public' && to.tier === 'private') {
    const bendY = fromBottom.y + (toTop.y - fromBottom.y) / 2;
    const path = `M ${fromBottom.x} ${fromBottom.y} L ${fromBottom.x} ${bendY} L ${toTop.x} ${bendY} L ${toTop.x} ${toTop.y}`;
    return { path, labelX: (fromBottom.x + toTop.x) / 2, labelY: bendY - 8 };
  }

  if (from.tier === 'public' && to.tier === 'public') {
    const path = `M ${fromRight.x} ${fromRight.y} L ${toLeft.x} ${toLeft.y}`;
    return { path, labelX: (fromRight.x + toLeft.x) / 2, labelY: fromRight.y - 10 };
  }

  if (from.tier === 'private' && to.tier === 'private') {
    const path = `M ${fromRight.x} ${fromRight.y} L ${toLeft.x} ${toLeft.y}`;
    return { path, labelX: (fromRight.x + toLeft.x) / 2, labelY: fromRight.y - 10 };
  }

  const path = `M ${fromCenterX} ${fromCenterY} L ${toCenterX} ${toCenterY}`;
  return { path, labelX: (fromCenterX + toCenterX) / 2, labelY: (fromCenterY + toCenterY) / 2 - 8 };
}

/** Human-readable traffic paths for the architecture side panel. */
export function describeTopologyFlows(model: DecisionDiagramModel): string[] {
  const labelById = new Map(model.nodes.map((node) => [node.id, node.label]));
  return model.edges
    .filter((edge) => String(edge.label || '').trim())
    .map((edge) => {
      const from = labelById.get(edge.from) || edge.from;
      const to = labelById.get(edge.to) || edge.to;
      return `${from} → ${to} · ${edge.label}`;
    });
}

/** Platform-aligned colors for the recessed topology canvas. */
export const TOPOLOGY_THEME = {
  canvas: '#0d1117',
  grid: 'rgba(255,255,255,0.035)',
  fg: '#e6edf3',
  fgSoft: '#c9d1d9',
  muted: '#8b949e',
  faint: '#484f58',
  border: '#000000',
  borderSoft: 'rgba(255,255,255,0.14)',
  accent: '#3fb950',
  nodeFill: '#161b22',
  nodeFillInternet: '#21262d',
} as const;
