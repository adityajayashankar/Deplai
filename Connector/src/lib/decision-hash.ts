/**
 * Canonical decision hashing for cost-estimate freshness checks (browser-safe).
 * Server routes that need sync hashing should import `canonicalDecisionJson` and use Node createHash.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
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
  if (compact === 'alb' || compact.includes('load_balancer') || compact === 'application_load_balancer') {
    return 'alb';
  }
  if (compact === 'eip' || compact === 'elastic_ip' || compact === 'elasticip') {
    return 'eip';
  }
  if (compact === 'ebs' || compact.includes('ebs') || compact.includes('root_volume')) {
    return 'ebs';
  }
  if (compact === 'nat_gateway' || compact === 'nat') {
    return 'nat_gateway';
  }
  if (compact.includes('vpc') || compact.includes('network')) {
    return 'vpc';
  }
  return compact;
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

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortKeysDeep(record[key]);
  }
  return sorted;
}

export function buildCanonicalDecision(decision: Record<string, unknown>): Record<string, unknown> {
  const components = normalizeDecisionComponents(decision);
  const stackConfig = normalizeDecisionStackConfig(decision);
  const intakes = asRecord(decision.intakes);
  return {
    components,
    deploy_sequence: stringList(decision.deploy_sequence).map((item) => canonicalComponentId(item)).filter(Boolean),
    stack_config: stackConfig,
    need_alb: Boolean(decision.need_alb) || components.includes('alb'),
    need_eip: Boolean(decision.need_eip) || components.includes('eip'),
    region: String(decision.region || '').trim() || null,
    provider: String(decision.provider || '').trim() || null,
    intakes: {
      monthly_traffic: intakes.monthly_traffic ?? null,
      peak_traffic: intakes.peak_traffic ?? null,
      peak_concurrent_users: intakes.peak_concurrent_users ?? intakes.peak_users ?? null,
      need_alb: intakes.need_alb ?? null,
      need_eip: intakes.need_eip ?? null,
      root_volume_size_gb: intakes.root_volume_size_gb ?? null,
    },
  };
}

export function canonicalDecisionJson(decision: Record<string, unknown>): string {
  return JSON.stringify(sortKeysDeep(buildCanonicalDecision(decision)));
}

export async function hashDecisionAsync(decision: Record<string, unknown>): Promise<string> {
  const payload = canonicalDecisionJson(decision);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
