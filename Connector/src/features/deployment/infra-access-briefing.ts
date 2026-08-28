import type {
  DeploymentInstanceSummary,
  EcsResourceConfig,
  InfraConsultantDecision,
  RdsResourceConfig,
  RedisResourceConfig,
} from '@/features/deployment/state';
import { coerceHttpAppPort } from '@/features/deployment/http-ports';

export type InfraOutputEntry = {
  key: string;
  label: string;
  value: string | string[] | number | boolean;
};

export type InfraSpecRow = {
  label: string;
  value: string;
  href?: string;
  copy?: boolean;
  hint?: string;
};

export type InfraPlannedSpecs = {
  plan?: 'ec2' | 'ecs' | 'static' | 'unknown';
  instanceType?: string | null;
  diskGb?: number | null;
  appPort?: number | null;
  needEip?: boolean;
  needAlb?: boolean;
  includeRds?: boolean;
  includeRedis?: boolean;
  rds?: RdsResourceConfig | null;
  redis?: RedisResourceConfig | null;
  ecs?: EcsResourceConfig | null;
  components?: string[];
};

export type InfraAccessBriefing = {
  strategy: 'ec2' | 'ecs' | 'static' | 'unknown';
  strategyLabel: string;
  appUrl: string | null;
  appHost: string | null;
  appPort: number | null;
  healthUrl: string | null;
  region: string;
  instanceType: string | null;
  instanceState: string | null;
  diskGb: number | null;
  sshCommand: string | null;
  sshHost: string | null;
  keyName: string | null;
  rdsCommand: string | null;
  redisCommand: string | null;
  consoleUrl: string | null;
  stack: string[];
  accessSteps: string[];
  access: InfraSpecRow[];
  compute: InfraSpecRow[];
  networking: InfraSpecRow[];
  data: InfraSpecRow[];
  observability: InfraSpecRow[];
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function isProvisionedValue(value: unknown): boolean {
  const text = String(value ?? '').trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  return !['n/a', 'na', 'null', 'undefined', 'none', '-', '—'].includes(lower);
}

export function firstProvisioned(...values: unknown[]): string | null {
  for (const value of values) {
    if (isProvisionedValue(value)) return String(value).trim();
  }
  return null;
}

function pickIacValue(outputs: InfraOutputEntry[] | null | undefined, keys: string[]): string | null {
  if (!outputs?.length) return null;
  const lowered = keys.map((key) => key.toLowerCase());
  for (const entry of outputs) {
    if (!lowered.includes(String(entry.key || '').toLowerCase())) continue;
    const raw = Array.isArray(entry.value) ? entry.value.filter(Boolean).join(', ') : String(entry.value ?? '');
    if (isProvisionedValue(raw)) return raw.trim();
  }
  return null;
}

export function hostFromUrlOrIp(value: string | null | undefined): string | null {
  if (!value || !isProvisionedValue(value)) return null;
  const trimmed = String(value).trim();
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
    return parsed.hostname || trimmed;
  } catch {
    return trimmed.replace(/^https?:\/\//, '').split('/')[0] || trimmed;
  }
}

export function asExternalHref(value: string | null | undefined): string | undefined {
  if (!value || !isProvisionedValue(value)) return undefined;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(value) || /^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return `http://${value}`;
  }
  return undefined;
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function splitHostPort(value: string): { host: string; port: string | null } {
  const withoutScheme = value.replace(/^https?:\/\//i, '');
  const hostPart = withoutScheme.split('/')[0] || withoutScheme;
  const match = hostPart.match(/^(.*):(\d+)$/);
  if (match) return { host: match[1], port: match[2] };
  return { host: hostPart, port: null };
}

function uniqueRows(rows: Array<InfraSpecRow | null | undefined>): InfraSpecRow[] {
  const seen = new Set<string>();
  const out: InfraSpecRow[] = [];
  for (const row of rows) {
    if (!row || !isProvisionedValue(row.value)) continue;
    const key = `${row.label}:${row.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function deriveStrategy(
  decision: InfraConsultantDecision | null | undefined,
  summary: DeploymentInstanceSummary,
  planned?: InfraPlannedSpecs,
): InfraAccessBriefing['strategy'] {
  if (planned?.plan === 'ec2' || planned?.plan === 'ecs' || planned?.plan === 'static') return planned.plan;
  const components = (decision?.components || planned?.components || []).map((item) => String(item).toLowerCase());
  const compute = asRecord(decision?.stack_config?.compute || asRecord(decision?.stack_config).ec2);
  const strategy = String(compute.strategy || '').toLowerCase();
  if (components.includes('s3_cloudfront') || strategy.includes('s3') || strategy.includes('cloudfront')) return 'static';
  if (components.includes('ecs') || strategy.includes('ecs')) return 'ecs';
  if (components.includes('ec2') || strategy.includes('ec2') || isProvisionedValue(summary.instanceId)) return 'ec2';
  if (isProvisionedValue(summary.ecsCluster)) return 'ecs';
  if (isProvisionedValue(summary.cloudfrontUrl)) return 'static';
  return 'unknown';
}

function strategyLabel(strategy: InfraAccessBriefing['strategy']): string {
  if (strategy === 'ec2') return 'EC2 app';
  if (strategy === 'ecs') return 'ECS Fargate service';
  if (strategy === 'static') return 'CloudFront static site';
  return 'AWS stack';
}

function stackChips(
  strategy: InfraAccessBriefing['strategy'],
  decision: InfraConsultantDecision | null | undefined,
  planned: InfraPlannedSpecs | undefined,
  extras: { hasRds: boolean; hasRedis: boolean; hasAlb: boolean; hasEip: boolean },
): string[] {
  const components = (decision?.components || planned?.components || []).map((item) => String(item).toLowerCase());
  const chips: string[] = [];
  const push = (label: string, test: boolean) => {
    if (test && !chips.includes(label)) chips.push(label);
  };
  push('EC2', strategy === 'ec2' || components.includes('ec2'));
  push('ECS', strategy === 'ecs' || components.includes('ecs'));
  push('CloudFront', strategy === 'static' || components.includes('s3_cloudfront'));
  push('ALB', extras.hasAlb || Boolean(planned?.needAlb) || components.includes('alb'));
  push('Elastic IP', extras.hasEip || Boolean(planned?.needEip) || components.includes('eip'));
  push('RDS', extras.hasRds || Boolean(planned?.includeRds) || components.includes('rds'));
  push('Redis', extras.hasRedis || Boolean(planned?.includeRedis) || components.includes('elasticache') || components.includes('redis'));
  return chips;
}

export function isSensitiveOutputKey(key: string): boolean {
  return /pem|private_key|password|secret|token/i.test(key);
}

export function buildInfraAccessBriefing(params: {
  summary: DeploymentInstanceSummary;
  iacOutputs?: InfraOutputEntry[] | null;
  decision?: InfraConsultantDecision | null;
  region?: string;
  planned?: InfraPlannedSpecs;
}): InfraAccessBriefing {
  const { summary, iacOutputs, decision, planned } = params;
  const stack = asRecord(decision?.stack_config);
  const ec2 = asRecord(stack.ec2);
  const rds = asRecord(stack.rds);
  const redis = asRecord(stack.elasticache || stack.redis);
  const ecs = asRecord(stack.ecs);
  const region = String(params.region || decision?.region || '').trim() || 'eu-north-1';
  const strategy = deriveStrategy(decision, summary, planned);

  const appUrl = firstProvisioned(
    summary.appUrl,
    pickIacValue(iacOutputs, ['app_url', 'application_url', 'site_url', 'alb_url']),
  );
  const healthUrl = firstProvisioned(
    summary.healthCheckUrl,
    pickIacValue(iacOutputs, ['health_check_url', 'health_url']),
  );
  const elasticIp = firstProvisioned(summary.elasticIp, pickIacValue(iacOutputs, ['elastic_ip', 'eip_public_ip']));
  const publicIp = firstProvisioned(summary.publicIp, pickIacValue(iacOutputs, ['ec2_public_ip', 'public_ip']));
  const publicDns = firstProvisioned(summary.publicDns, pickIacValue(iacOutputs, ['ec2_public_dns', 'public_dns']));
  const albDns = firstProvisioned(summary.albDns, pickIacValue(iacOutputs, ['alb_dns_name', 'load_balancer_dns_name']));
  const instanceId = firstProvisioned(summary.instanceId, pickIacValue(iacOutputs, ['ec2_instance_id', 'instance_id']));
  const instanceType = firstProvisioned(
    summary.instanceType,
    pickIacValue(iacOutputs, ['ec2_instance_type', 'instance_type']),
    ec2.instance_type,
    planned?.instanceType,
  );
  const instanceState = firstProvisioned(summary.instanceState, pickIacValue(iacOutputs, ['ec2_instance_state', 'instance_state']));
  const diskGb = numberOrNull(ec2.root_volume_size_gb) || numberOrNull(planned?.diskGb);
  const appPort = coerceHttpAppPort(ec2.app_port || ecs.app_port || planned?.appPort, 3000);
  const sshHost = strategy === 'ec2' ? hostFromUrlOrIp(elasticIp || publicIp || publicDns) : null;
  const keyName = firstProvisioned(summary.keyName);
  const sshCommand = sshHost
    ? `ssh -i ./${keyName || 'deplai-ec2-key'}.pem -o StrictHostKeyChecking=accept-new ec2-user@${sshHost}`
    : null;
  const consoleUrl = instanceId
    ? `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#InstanceDetails:instanceId=${instanceId}`
    : `https://${region}.console.aws.amazon.com/console/home?region=${region}`;

  const rdsEndpoint = firstProvisioned(summary.rdsEndpoint, pickIacValue(iacOutputs, ['rds_endpoint', 'rds_address', 'database_endpoint']));
  const redisEndpoint = firstProvisioned(summary.redisEndpoint, pickIacValue(iacOutputs, ['redis_endpoint', 'cache_endpoint']));
  const rdsParsed = rdsEndpoint ? splitHostPort(rdsEndpoint) : null;
  const rdsPort = firstProvisioned(summary.rdsPort, rdsParsed?.port, pickIacValue(iacOutputs, ['rds_port'])) || '5432';
  const rdsDb = firstProvisioned(summary.rdsDatabaseName, pickIacValue(iacOutputs, ['rds_database_name', 'db_name']), rds.db_identifier, planned?.rds?.db_identifier);
  const rdsUser = firstProvisioned(planned?.rds?.master_username, rds.master_username) || 'app';
  const redisHost = redisEndpoint ? splitHostPort(redisEndpoint).host : null;
  const redisPort = firstProvisioned(summary.redisPort, pickIacValue(iacOutputs, ['redis_port'])) || '6379';
  const rdsCommand = rdsParsed
    ? `psql "host=${rdsParsed.host} port=${rdsPort} dbname=${rdsDb || 'app'} user=${rdsUser}"`
    : null;
  const redisCommand = redisHost ? `redis-cli -h ${redisHost} -p ${redisPort}` : null;

  const rdsHintParts = [
    planned?.rds?.engine || rds.engine,
    planned?.rds?.engine_version || rds.engine_version,
    planned?.rds?.instance_class || rds.instance_class,
    (planned?.rds?.allocated_storage || rds.allocated_storage) ? `${planned?.rds?.allocated_storage || rds.allocated_storage} GB` : null,
    planned?.rds?.multi_az || rds.multi_az ? 'Multi-AZ' : null,
  ].filter(Boolean);
  const redisHintParts = [
    'redis',
    planned?.redis?.engine_version || redis.engine_version,
    planned?.redis?.node_type || redis.node_type,
  ].filter(Boolean);

  const access = uniqueRows([
    appUrl ? { label: 'Application URL', value: appUrl, href: asExternalHref(appUrl), copy: true, hint: 'Public HTTP entry for the running app' } : null,
    healthUrl && healthUrl !== appUrl ? { label: 'Health check', value: healthUrl, href: asExternalHref(healthUrl), copy: true } : null,
    albDns ? { label: 'Load balancer DNS', value: albDns, href: asExternalHref(albDns), copy: true, hint: 'Stable hostname in front of the app' } : null,
    elasticIp ? { label: 'Elastic IP', value: elasticIp, href: asExternalHref(elasticIp), copy: true, hint: 'Static public address that survives instance restart' } : null,
    publicIp && publicIp !== elasticIp ? { label: 'Public IP', value: publicIp, href: asExternalHref(publicIp), copy: true } : null,
    firstProvisioned(summary.cloudfrontUrl) ? {
      label: 'CloudFront',
      value: String(summary.cloudfrontUrl),
      href: asExternalHref(String(summary.cloudfrontUrl)),
      copy: true,
      hint: 'CDN URL for the static site',
    } : null,
  ]);

  const ecsCluster = firstProvisioned(summary.ecsCluster, pickIacValue(iacOutputs, ['ecs_cluster_name']));
  const ecrUrl = firstProvisioned(summary.ecrRepositoryUrl, pickIacValue(iacOutputs, ['ecr_repository_url']));
  const taskCpu = numberOrNull(ecs.cpu) || numberOrNull(planned?.ecs?.cpu);
  const taskMemory = numberOrNull(ecs.memory) || numberOrNull(planned?.ecs?.memory);
  const desiredCount = numberOrNull(ecs.desired_count) || numberOrNull(planned?.ecs?.desired_count);

  const compute = uniqueRows([
    instanceId ? { label: 'Instance ID', value: instanceId, copy: true, href: consoleUrl } : null,
    instanceType ? { label: 'Instance type', value: instanceType, hint: isProvisionedValue(summary.instanceType) ? undefined : 'From the approved plan' } : null,
    instanceState ? { label: 'State', value: instanceState } : null,
    diskGb ? { label: 'Root disk', value: `${diskGb} GB gp3` } : null,
    appPort ? { label: 'App port', value: String(appPort), hint: 'Container or process listen port behind HTTP 80' } : null,
    firstProvisioned(summary.privateIp) ? { label: 'Private IP', value: String(summary.privateIp), copy: true } : null,
    publicDns ? { label: 'Public DNS', value: publicDns, copy: true } : null,
    ecsCluster ? {
      label: 'ECS cluster',
      value: ecsCluster,
      copy: true,
      href: `https://${region}.console.aws.amazon.com/ecs/v2/clusters/${encodeURIComponent(ecsCluster)}?region=${region}`,
    } : null,
    ecrUrl ? { label: 'ECR repository', value: ecrUrl, copy: true } : null,
    taskCpu || taskMemory ? {
      label: 'Task size',
      value: `${taskCpu || '—'} CPU / ${taskMemory || '—'} MiB`,
    } : null,
    desiredCount ? { label: 'Desired count', value: String(desiredCount) } : null,
  ]);

  const vpcId = firstProvisioned(summary.vpcId);
  const subnetId = firstProvisioned(summary.subnetId);
  const networking = uniqueRows([
    { label: 'Region', value: region, copy: true },
    vpcId ? {
      label: 'VPC',
      value: vpcId,
      copy: true,
      href: `https://${region}.console.aws.amazon.com/vpcconsole/home?region=${region}#VpcDetails:VpcId=${vpcId}`,
    } : null,
    subnetId ? { label: 'Subnet', value: subnetId, copy: true } : null,
    elasticIp ? { label: 'Elastic IP', value: elasticIp, copy: true } : null,
    albDns ? { label: 'ALB DNS', value: albDns, copy: true } : null,
  ]);

  const showRds = Boolean(rdsEndpoint || planned?.includeRds || planned?.rds);
  const showRedis = Boolean(redisEndpoint || planned?.includeRedis || planned?.redis);
  const data = uniqueRows([
    rdsEndpoint ? {
      label: 'RDS endpoint',
      value: rdsEndpoint,
      copy: true,
      hint: (rdsHintParts.join(' · ') || 'Private SQL') + '. Reach it from the app VPC, not the public internet.',
    } : showRds && rdsHintParts.length ? {
      label: 'RDS (planned)',
      value: rdsHintParts.join(' · '),
      hint: 'Endpoint appears after a successful apply.',
    } : null,
    rdsPort && rdsEndpoint ? { label: 'RDS port', value: rdsPort } : null,
    rdsDb && rdsEndpoint ? { label: 'Database name', value: rdsDb, copy: true } : null,
    redisEndpoint ? {
      label: 'Redis endpoint',
      value: redisEndpoint,
      copy: true,
      hint: (redisHintParts.join(' · ') || 'Private cache') + '. Connect from the app, not locally.',
    } : showRedis && redisHintParts.length ? {
      label: 'Redis (planned)',
      value: redisHintParts.join(' · '),
      hint: 'Endpoint appears after a successful apply.',
    } : null,
    redisPort && redisEndpoint ? { label: 'Redis port', value: redisPort } : null,
  ]);

  const logGroup = firstProvisioned(summary.logGroup, pickIacValue(iacOutputs, ['log_group_name']));
  const observability = uniqueRows([
    logGroup ? {
      label: 'CloudWatch log group',
      value: logGroup,
      copy: true,
      href: `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups`,
    } : null,
    instanceId ? { label: 'EC2 console', value: 'Open instance', href: consoleUrl } : null,
    ecsCluster ? {
      label: 'ECS console',
      value: 'Open cluster',
      href: `https://${region}.console.aws.amazon.com/ecs/v2/clusters/${encodeURIComponent(ecsCluster)}?region=${region}`,
    } : null,
  ]);

  const accessSteps = strategy === 'ecs'
    ? [
        'Open the application URL (ALB). There is no SSH on Fargate.',
        logGroup ? 'Use the CloudWatch log group for runtime logs.' : 'Check ECS service events in the AWS console.',
        rdsEndpoint || redisEndpoint ? 'Reach RDS/Redis from the task in the VPC, not from your laptop.' : 'Push new images to ECR when you roll a version.',
      ]
    : strategy === 'static'
      ? [
          'Open the CloudFront URL. Fresh distributions can take a few minutes to become globally available.',
          'There is no SSH or instance login for a static site.',
        ]
      : [
          appUrl ? 'Open the application URL in a browser.' : 'Fetch runtime details to hydrate the public URL.',
          sshCommand ? 'SSH as ec2-user with the PEM you download for this instance (or PPK on Windows / PuTTY).' : 'Download the one-time PEM for this instance to SSH.',
          rdsEndpoint || redisEndpoint ? 'RDS and Redis are private — connect from the instance, not the public internet.' : 'Use the instance specs below for size, disk, and network.',
        ];

  return {
    strategy,
    strategyLabel: strategyLabel(strategy),
    appUrl,
    appHost: hostFromUrlOrIp(appUrl || elasticIp || publicIp),
    appPort,
    healthUrl: healthUrl && healthUrl !== appUrl ? healthUrl : null,
    region,
    instanceType,
    instanceState,
    diskGb,
    sshCommand,
    sshHost,
    keyName,
    rdsCommand,
    redisCommand,
    consoleUrl,
    stack: stackChips(strategy, decision, planned, {
      hasRds: Boolean(rdsEndpoint),
      hasRedis: Boolean(redisEndpoint),
      hasAlb: Boolean(albDns),
      hasEip: Boolean(elasticIp),
    }),
    accessSteps,
    access,
    compute,
    networking,
    data,
    observability,
  };
}

export function emptyDeploymentSummary(): DeploymentInstanceSummary {
  return {
    cloudfrontUrl: 'n/a',
    albDns: 'n/a',
    elasticIp: 'n/a',
    rdsEndpoint: 'n/a',
    rdsPort: 'n/a',
    rdsDatabaseName: 'n/a',
    redisEndpoint: 'n/a',
    redisPort: 'n/a',
    ecsCluster: 'n/a',
    ecrRepositoryUrl: 'n/a',
    logGroup: 'n/a',
    healthCheckUrl: 'n/a',
    keyName: 'deplai-ec2-key',
    keyFileName: '',
    generatedPem: null,
    databaseEnv: null,
    databaseFileName: '',
    instanceId: 'n/a',
    instanceArn: 'n/a',
    instanceState: 'n/a',
    instanceType: 'n/a',
    publicIp: 'n/a',
    appUrl: 'n/a',
    privateIp: 'n/a',
    publicDns: 'n/a',
    privateDns: 'n/a',
    vpcId: 'n/a',
    subnetId: 'n/a',
  };
}
