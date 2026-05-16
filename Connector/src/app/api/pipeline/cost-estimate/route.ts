import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';

const HOURS_PER_MONTH = 730;
const PRICING_BASE_URL = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws';
const CACHE_TTL_MS = 10 * 60 * 1000;

type PricingBlob = {
  products?: Record<string, { attributes?: Record<string, string> }>;
  terms?: {
    OnDemand?: Record<string, Record<string, { priceDimensions?: Record<string, { pricePerUnit?: Record<string, string> }> }>>;
  };
};

type DecisionCostLineItem = {
  component: string;
  label: string;
  hourly_usd: number;
  monthly_usd: number;
  note: string;
  source: 'pricing_api' | 'fallback';
};

type DecisionCostEstimateResponse = {
  success: boolean;
  currency: string;
  source: 'pricing_api' | 'fallback';
  based_on_decision: boolean;
  fallback_reason?: string;
  line_items: DecisionCostLineItem[];
  subtotal_monthly_usd: number;
  variance_note: string;
  optimization_tips: string[];
  error?: string;
};

const pricingCache = new Map<string, { ts: number; payload: PricingBlob }>();

const REGION_LOCATION_MAP: Record<string, string> = {
  'eu-north-1': 'EU (Stockholm)',
  'eu-west-1': 'EU (Ireland)',
  'eu-west-2': 'EU (London)',
  'eu-west-3': 'EU (Paris)',
  'eu-central-1': 'EU (Frankfurt)',
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-1': 'US West (N. California)',
  'us-west-2': 'US West (Oregon)',
  'ap-south-1': 'Asia Pacific (Mumbai)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
};

const FALLBACK: Record<string, number> = {
  account_map_hourly: 0.001,
  vpc_nat_hourly: 0.062,
  vpc_baseline_hourly: 0.006,
  ec2_t3_micro_hourly: 0.0104,
  ec2_t3_small_hourly: 0.0208,
  ec2_t3_medium_hourly: 0.0416,
  ec2_t3_large_hourly: 0.0832,
  fargate_vcpu_hourly: 0.04656,
  fargate_gb_hourly: 0.00511,
  rds_db_t3_micro_hourly: 0.026,
  rds_db_t3_small_hourly: 0.052,
  rds_db_t3_medium_hourly: 0.104,
  redis_cache_t3_micro_hourly: 0.021,
  redis_cache_t3_small_hourly: 0.042,
  cloudfront_s3_blended_hourly: 0.028,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function canonicalComponentId(value: unknown): string {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const compact = raw.replace(/[\s\-]+/g, '_');
  if (compact === 'account_map' || compact === 'accountmap' || (compact.includes('account') && compact.includes('map'))) {
    return 'account-map';
  }
  if (compact === 'ec2' || compact === 'ec2_instance' || compact === 'ec2instance' || compact.includes('ec2')) {
    return 'ec2-instance';
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
  if (compact.includes('vpc') || compact.includes('network')) {
    return 'vpc';
  }
  return compact;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function toPositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundHourly(value: number): number {
  return Math.round(value * 10000) / 10000;
}

async function fetchPricingBlob(serviceCode: string, region: string): Promise<PricingBlob | null> {
  const cacheKey = `${serviceCode}:${region}`;
  const cached = pricingCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.payload;
  }

  const urls = [
    `${PRICING_BASE_URL}/${serviceCode}/current/${region}/index.json`,
    `${PRICING_BASE_URL}/${serviceCode}/current/index.json`,
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) continue;
      const json = await response.json().catch(() => ({}));
      const payload = asRecord(json) as PricingBlob;
      if (payload.products && payload.terms?.OnDemand) {
        pricingCache.set(cacheKey, { ts: Date.now(), payload });
        return payload;
      }
    } catch {
      // fall through to fallback table
    }
  }

  return null;
}

function extractOnDemandHourly(
  payload: PricingBlob,
  predicate: (attrs: Record<string, string>) => boolean,
): number | null {
  const products = payload.products || {};
  const onDemand = payload.terms?.OnDemand || {};

  for (const [sku, product] of Object.entries(products)) {
    const attrs = product?.attributes || {};
    if (!predicate(attrs)) continue;

    const termByCode = onDemand[sku] || {};
    for (const term of Object.values(termByCode)) {
      const dimensions = term?.priceDimensions || {};
      for (const dimension of Object.values(dimensions)) {
        const usd = Number(dimension?.pricePerUnit?.USD || 0);
        if (Number.isFinite(usd) && usd > 0) return usd;
      }
    }
  }

  return null;
}

function normalizeDecisionStackConfig(decision: Record<string, unknown>): Record<string, unknown> {
  const stackConfig = asRecord(decision.stack_config);
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stackConfig)) {
    const component = canonicalComponentId(key);
    if (!component) continue;
    normalized[component] = asRecord(value);
  }
  return normalized;
}

function normalizeDecisionComponents(decision: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (value: unknown) => {
    const component = canonicalComponentId(value);
    if (!component || seen.has(component)) return;
    seen.add(component);
    ordered.push(component);
  };

  for (const component of stringList(decision.components)) push(component);
  if (ordered.length === 0) {
    for (const component of stringList(decision.deploy_sequence)) push(component);
  }
  if (ordered.length === 0) {
    for (const component of Object.keys(asRecord(decision.stack_config))) push(component);
  }

  return ordered;
}

function fallbackRdsHourly(instanceClass: string): { hourly: number; fallbackReason?: string; nearestType?: string } {
  const key = instanceClass.toLowerCase();
  if (key.includes('db.t3.micro')) return { hourly: FALLBACK.rds_db_t3_micro_hourly };
  if (key.includes('db.t3.small')) return { hourly: FALLBACK.rds_db_t3_small_hourly };
  if (key.includes('db.t3.medium')) return { hourly: FALLBACK.rds_db_t3_medium_hourly };
  if (key.includes('db.t3.')) {
    return {
      hourly: FALLBACK.rds_db_t3_medium_hourly,
      nearestType: 'db.t3.medium',
      fallbackReason: `RDS class ${instanceClass} is not in static table; nearest fallback db.t3.medium was used.`,
    };
  }
  return {
    hourly: FALLBACK.rds_db_t3_medium_hourly,
    nearestType: 'db.t3.medium',
    fallbackReason: `RDS class ${instanceClass} is not in static table; fallback db.t3.medium was used.`,
  };
}

function fallbackRedisHourly(nodeType: string): { hourly: number; fallbackReason?: string; nearestType?: string } {
  const key = nodeType.toLowerCase();
  if (key.includes('cache.t3.micro')) return { hourly: FALLBACK.redis_cache_t3_micro_hourly };
  if (key.includes('cache.t3.small')) return { hourly: FALLBACK.redis_cache_t3_small_hourly };
  if (key.includes('cache.t3.')) {
    return {
      hourly: FALLBACK.redis_cache_t3_small_hourly,
      nearestType: 'cache.t3.small',
      fallbackReason: `ElastiCache node type ${nodeType} is not in static table; nearest fallback cache.t3.small was used.`,
    };
  }
  return {
    hourly: FALLBACK.redis_cache_t3_small_hourly,
    nearestType: 'cache.t3.small',
    fallbackReason: `ElastiCache node type ${nodeType} is not in static table; fallback cache.t3.small was used.`,
  };
}

function fallbackEc2Hourly(instanceType: string): { hourly: number; fallbackReason?: string; nearestType?: string } {
  const key = instanceType.toLowerCase();
  if (key.includes('t3.micro')) return { hourly: FALLBACK.ec2_t3_micro_hourly };
  if (key.includes('t3.small')) return { hourly: FALLBACK.ec2_t3_small_hourly };
  if (key.includes('t3.medium')) return { hourly: FALLBACK.ec2_t3_medium_hourly };
  if (key.includes('t3.large')) return { hourly: FALLBACK.ec2_t3_large_hourly };
  if (key.includes('t3.')) {
    return {
      hourly: FALLBACK.ec2_t3_medium_hourly,
      nearestType: 't3.medium',
      fallbackReason: `EC2 instance type ${instanceType} is not in static table; nearest fallback t3.medium was used.`,
    };
  }
  return {
    hourly: FALLBACK.ec2_t3_micro_hourly,
    nearestType: 't3.micro',
    fallbackReason: `EC2 instance type ${instanceType} is not in static table; fallback t3.micro was used.`,
  };
}

function buildOptimizationTips(params: {
  components: string[];
  stackConfig: Record<string, unknown>;
}): string[] {
  const tips: string[] = [];
  const ecs = asRecord(params.stackConfig.ecs);
  const rds = asRecord(params.stackConfig.rds);
  const vpc = asRecord(params.stackConfig.vpc);

  if (params.components.includes('ecs')) {
    const desired = toPositiveNumber(ecs.desired_count, 1);
    if (desired > 1) tips.push('Reduce ECS desired_count to 1 in testing windows to lower compute spend.');
    if (toPositiveNumber(ecs.cpu, 512) > 512) tips.push('For smoke tests, reduce ECS task CPU/memory to the smallest stable size.');
  }

  if (params.components.includes('rds')) {
    if (Boolean(rds.multi_az)) tips.push('Disable Multi-AZ for non-production testing to cut database cost.');
    if (toPositiveNumber(rds.backup_retention_period, 7) > 1) tips.push('Lower backup retention period for temporary testing environments.');
  }

  if (params.components.includes('vpc') && Boolean(vpc.nat_gateway_enabled)) {
    tips.push('If private egress is not required, disable NAT gateway to reduce networking charges.');
  }

  if (tips.length < 2) {
    tips.push('Schedule automated shutdown for test stacks outside working hours.');
  }
  if (tips.length < 3) {
    tips.push('Use smallest free-tier compatible instance classes whenever possible.');
  }

  return tips.slice(0, 3);
}

async function estimateDecisionCost(params: {
  decision: Record<string, unknown>;
  awsRegion: string;
}): Promise<DecisionCostEstimateResponse> {
  const components = normalizeDecisionComponents(params.decision);
  const stackConfig = normalizeDecisionStackConfig(params.decision);
  const basedOnDecision = components.some((component) => Object.keys(asRecord(stackConfig[component])).length > 0);
  const location = REGION_LOCATION_MAP[params.awsRegion] || '';
  const lineItems: DecisionCostLineItem[] = [];
  let pricingApiHits = 0;
  const fallbackReasons: string[] = [];

  const pushItem = (item: {
    component: string;
    label: string;
    hourly: number;
    note: string;
    source: 'pricing_api' | 'fallback';
  }) => {
    const safeHourly = Math.max(0.0001, item.hourly);
    lineItems.push({
      component: item.component,
      label: item.label,
      hourly_usd: roundHourly(safeHourly),
      monthly_usd: roundMoney(safeHourly * HOURS_PER_MONTH),
      note: item.note,
      source: item.source,
    });
    if (item.source === 'pricing_api') pricingApiHits += 1;
  };

  for (const component of components) {
    if (component === 'account-map') {
      pushItem({
        component,
        label: 'account-map',
        hourly: FALLBACK.account_map_hourly,
        note: 'Control-plane baseline estimate for Atmos account-map orchestration.',
        source: 'fallback',
      });
      continue;
    }

    if (component === 'ec2-instance') {
      const ec2Cfg = asRecord(stackConfig['ec2-instance'] || stackConfig.ec2);
      const instanceType = String(ec2Cfg.instance_type || 't3.micro').trim().toLowerCase();

      let ec2Rate: number | null = null;
      const ec2Payload = await fetchPricingBlob('AmazonEC2', params.awsRegion);
      if (ec2Payload && location) {
        ec2Rate = extractOnDemandHourly(ec2Payload, (attrs) => {
          const tenancy = String(attrs.tenancy || '').toLowerCase();
          const operatingSystem = String(attrs.operatingSystem || '').toLowerCase();
          const preInstalledSw = String(attrs.preInstalledSw || '').toLowerCase();
          return String(attrs.location || '') === location
            && String(attrs.instanceType || '').toLowerCase() === instanceType
            && tenancy === 'shared'
            && (operatingSystem.includes('linux') || !operatingSystem)
            && (preInstalledSw === 'na' || !preInstalledSw);
        });
      }

      const fallback = fallbackEc2Hourly(instanceType);
      if (!ec2Rate && fallback.fallbackReason) fallbackReasons.push(fallback.fallbackReason);
      pushItem({
        component,
        label: 'ec2-instance',
        hourly: ec2Rate || fallback.hourly,
        note: `${instanceType}${fallback.nearestType ? `, nearest=${fallback.nearestType}` : ''}`,
        source: ec2Rate ? 'pricing_api' : 'fallback',
      });
      continue;
    }

    if (component === 'vpc') {
      const vpcCfg = asRecord(stackConfig.vpc);
      const natEnabled = Boolean(vpcCfg.nat_gateway_enabled);
      let natHourly: number | null = null;
      const vpcPayload = await fetchPricingBlob('AmazonVPC', params.awsRegion);
      if (vpcPayload && location) {
        natHourly = extractOnDemandHourly(vpcPayload, (attrs) => {
          const usage = String(attrs.usagetype || '').toLowerCase();
          return String(attrs.location || '') === location && usage.includes('natgateway') && usage.includes('hours');
        });
      }
      const hourly = natEnabled
        ? (natHourly || FALLBACK.vpc_nat_hourly)
        : FALLBACK.vpc_baseline_hourly;
      if (natEnabled && !natHourly) {
        fallbackReasons.push('NAT gateway pricing API did not return a regional hourly match; static NAT fallback rate was used.');
      }
      pushItem({
        component,
        label: 'vpc/networking',
        hourly,
        note: natEnabled ? 'Includes one NAT gateway hourly estimate.' : 'Baseline VPC routing and networking estimate.',
        source: natHourly ? 'pricing_api' : 'fallback',
      });
      continue;
    }

    if (component === 'ecs') {
      const ecsCfg = asRecord(stackConfig.ecs);
      const desired = toPositiveNumber(ecsCfg.desired_count, 1);
      const cpu = toPositiveNumber(ecsCfg.cpu, 512);
      const memory = toPositiveNumber(ecsCfg.memory, 1024);
      const vcpu = cpu / 1024;
      const memGb = memory / 1024;

      let vcpuRate: number | null = null;
      let memRate: number | null = null;
      const ecsPayload = await fetchPricingBlob('AmazonECS', params.awsRegion);
      if (ecsPayload && location) {
        vcpuRate = extractOnDemandHourly(ecsPayload, (attrs) => {
          const usage = String(attrs.usagetype || '').toLowerCase();
          return String(attrs.location || '') === location && usage.includes('fargate') && usage.includes('vcpu');
        });
        memRate = extractOnDemandHourly(ecsPayload, (attrs) => {
          const usage = String(attrs.usagetype || '').toLowerCase();
          return String(attrs.location || '') === location && usage.includes('fargate') && usage.includes('gb');
        });
      }
      const hourly = desired * ((vcpuRate || FALLBACK.fargate_vcpu_hourly) * vcpu + (memRate || FALLBACK.fargate_gb_hourly) * memGb);
      if (!vcpuRate || !memRate) {
        fallbackReasons.push('Fargate CPU and memory pricing were partially unavailable from AWS Pricing API; static ECS fallback rates were used.');
      }
      pushItem({
        component,
        label: 'ecs_fargate',
        hourly,
        note: `desired=${desired}, cpu=${cpu}, memory=${memory}MB`,
        source: vcpuRate && memRate ? 'pricing_api' : 'fallback',
      });
      continue;
    }

    if (component === 'rds') {
      const rdsCfg = asRecord(stackConfig.rds);
      const instanceClass = String(rdsCfg.instance_class || 'db.t3.micro');
      const engine = String(rdsCfg.engine || 'postgres');
      const multiAz = Boolean(rdsCfg.multi_az);

      let rdsRate: number | null = null;
      const rdsPayload = await fetchPricingBlob('AmazonRDS', params.awsRegion);
      if (rdsPayload && location) {
        rdsRate = extractOnDemandHourly(rdsPayload, (attrs) => {
          const dbEngine = String(attrs.databaseEngine || '').toLowerCase();
          const deployment = String(attrs.deploymentOption || '').toLowerCase();
          return String(attrs.location || '') === location
            && String(attrs.instanceType || '').toLowerCase() === instanceClass.toLowerCase()
            && (!engine || dbEngine.includes(engine.toLowerCase()))
            && (multiAz ? deployment.includes('multi-az') : !deployment.includes('multi-az'));
        });
      }
      const fallback = fallbackRdsHourly(instanceClass);
      const hourly = (rdsRate || fallback.hourly) * (multiAz ? 2 : 1);
      if (!rdsRate && fallback.fallbackReason) fallbackReasons.push(fallback.fallbackReason);
      pushItem({
        component,
        label: 'rds',
        hourly,
        note: `${instanceClass}${multiAz ? ' (multi-az)' : ''}${fallback.nearestType ? `, nearest=${fallback.nearestType}` : ''}`,
        source: rdsRate ? 'pricing_api' : 'fallback',
      });
      continue;
    }

    if (component === 'elasticache') {
      const cacheCfg = asRecord(stackConfig.elasticache);
      const nodeType = String(cacheCfg.node_type || 'cache.t3.micro');

      let cacheRate: number | null = null;
      const cachePayload = await fetchPricingBlob('AmazonElastiCache', params.awsRegion);
      if (cachePayload && location) {
        cacheRate = extractOnDemandHourly(cachePayload, (attrs) => {
          return String(attrs.location || '') === location
            && String(attrs.instanceType || '').toLowerCase() === nodeType.toLowerCase();
        });
      }

      const fallback = fallbackRedisHourly(nodeType);
      if (!cacheRate && fallback.fallbackReason) fallbackReasons.push(fallback.fallbackReason);
      pushItem({
        component,
        label: 'elasticache',
        hourly: cacheRate || fallback.hourly,
        note: `${nodeType}${fallback.nearestType ? `, nearest=${fallback.nearestType}` : ''}`,
        source: cacheRate ? 'pricing_api' : 'fallback',
      });
      continue;
    }

    if (component === 's3_cloudfront') {
      pushItem({
        component,
        label: 's3_cloudfront',
        hourly: FALLBACK.cloudfront_s3_blended_hourly,
        note: 'Blended estimate for light static hosting and CDN transfer.',
        source: 'fallback',
      });
      continue;
    }

    pushItem({
      component,
      label: component,
      hourly: 0.001,
      note: 'Unknown component mapped to minimal placeholder estimate.',
      source: 'fallback',
    });
    fallbackReasons.push(`Component ${component} is not recognized by the estimator; placeholder fallback pricing was used.`);
  }

  const subtotal = roundMoney(lineItems.reduce((sum, item) => sum + Number(item.monthly_usd || 0), 0));
  const source: 'pricing_api' | 'fallback' = pricingApiHits > 0 ? 'pricing_api' : 'fallback';
  const fallbackReason = Array.from(new Set(fallbackReasons)).join(' ');

  return {
    success: true,
    currency: 'USD',
    source,
    based_on_decision: basedOnDecision,
    fallback_reason: fallbackReason || undefined,
    line_items: lineItems,
    subtotal_monthly_usd: subtotal,
    variance_note: 'Estimated monthly cost can vary by +/-20% with traffic, region updates, and usage patterns.',
    optimization_tips: buildOptimizationTips({ components, stackConfig }),
  };
}

export async function POST(request: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await request.json().catch(() => ({})) as {
      project_id?: string;
      aws_region?: string;
      decision?: Record<string, unknown>;
    };

    const projectId = String(body.project_id || '').trim();
    if (!projectId) {
      return NextResponse.json({ success: false, error: 'project_id is required' }, { status: 400 });
    }

    const owned = await verifyProjectOwnership(user.id, projectId);
    if ('error' in owned) return owned.error;

    const decision = asRecord(body.decision);
    const components = normalizeDecisionComponents(decision);
    if (components.length === 0) {
      return NextResponse.json({ success: false, error: 'decision.components, decision.deploy_sequence, or decision.stack_config is required' }, { status: 400 });
    }

    const awsRegion = String(body.aws_region || 'eu-north-1').trim() || 'eu-north-1';
    const estimate = await estimateDecisionCost({ decision, awsRegion });
    return NextResponse.json(estimate);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err || 'Cost estimation failed.');
    return NextResponse.json(
      {
        success: false,
        error: message,
        currency: 'USD',
        source: 'fallback',
        based_on_decision: false,
        fallback_reason: 'Estimator failed and returned static fallback response payload.',
        line_items: [],
        subtotal_monthly_usd: 0,
        variance_note: 'Estimated monthly cost can vary by +/-20% with traffic, region updates, and usage patterns.',
        optimization_tips: [
          'Use the smallest free-tier resources where possible.',
          'Disable non-essential components for smoke-test environments.',
          'Tear down test stacks when not in use.',
        ],
      } satisfies DecisionCostEstimateResponse,
      { status: 500 },
    );
  }
}
