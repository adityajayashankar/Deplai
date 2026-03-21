import { listLegacyAwsIconNames, loadLegacyAwsMapKeys } from '@/lib/legacy-assets';

const AWS_ICON_ALIASES: Array<{ keys: string[]; icon: string }> = [
  { keys: ['ec2', 'compute instance', 'virtual machine'], icon: 'amazonec2' },
  { keys: ['autoscaling', 'auto scaling'], icon: 'amazonec2autoscaling' },
  { keys: ['s3', 'bucket', 'object storage'], icon: 'amazons3' },
  { keys: ['cloudfront', 'cdn'], icon: 'amazoncloudfront' },
  { keys: ['route53', 'route 53', 'dns'], icon: 'amazonroute53' },
  { keys: ['rds', 'relational database'], icon: 'amazonrds' },
  { keys: ['aurora'], icon: 'aurora' },
  { keys: ['dynamodb', 'nosql'], icon: 'amazondynamodb' },
  { keys: ['documentdb'], icon: 'amazondocumentdb' },
  { keys: ['elasticache', 'redis', 'memcached'], icon: 'amazonelasticache' },
  { keys: ['lambda', 'serverless function'], icon: 'awslambda' },
  { keys: ['api gateway', 'apigateway'], icon: 'amazonapigateway' },
  { keys: ['vpc', 'virtual private cloud'], icon: 'amazonvpc' },
  { keys: ['alb', 'application load balancer', 'elb', 'load balancer'], icon: 'awselb' },
  { keys: ['iam', 'identity access'], icon: 'awsiam' },
  { keys: ['kms', 'key management'], icon: 'awskms' },
  { keys: ['secrets manager'], icon: 'awssecretsmanager' },
  { keys: ['waf', 'web application firewall'], icon: 'awswaf' },
  { keys: ['guardduty'], icon: 'awsguardduty' },
  { keys: ['security hub'], icon: 'awssecurityhub' },
  { keys: ['cloudwatch', 'monitoring'], icon: 'amazoncloudwatch' },
  { keys: ['cloudtrail', 'audit'], icon: 'awscloudtrail' },
  { keys: ['ecs', 'container service'], icon: 'amazonecs' },
  { keys: ['eks', 'kubernetes'], icon: 'amazoneks' },
  { keys: ['ecr', 'container registry'], icon: 'amazonecr' },
  { keys: ['sqs', 'queue'], icon: 'amazonsqs' },
  { keys: ['sns', 'notification'], icon: 'amazonsns' },
  { keys: ['eventbridge', 'event bus'], icon: 'amazoneventbridge' },
  { keys: ['kinesis', 'stream'], icon: 'amazonkinesisdatastreams' },
  { keys: ['msk', 'managed kafka'], icon: 'amazonmsk' },
  { keys: ['athena'], icon: 'amazonathena' },
  { keys: ['glue'], icon: 'awsglue' },
  { keys: ['redshift', 'data warehouse'], icon: 'redshift' },
  { keys: ['opensearch', 'elasticsearch'], icon: 'amazonopensearchservice' },
  { keys: ['bedrock'], icon: 'bedrock' },
  { keys: ['sagemaker', 'machine learning'], icon: 'sagemaker' },
  { keys: ['cognito', 'identity provider'], icon: 'amazoncognito' },
];

function normalize(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function compact(value: string): string {
  return normalize(value).replace(/\s+/g, '');
}

const LEGACY_ICON_NAMES = listLegacyAwsIconNames();
const LEGACY_MAP_KEYS = loadLegacyAwsMapKeys();

function matchExistingIcon(base: string): string | null {
  const normalized = compact(base).replace(/[^a-z0-9]/g, '');
  if (!normalized) return null;
  const candidates = [
    normalized,
    `amazon${normalized}`,
    `aws${normalized}`,
  ];
  for (const candidate of candidates) {
    if (LEGACY_ICON_NAMES.has(candidate)) return candidate;
  }
  return null;
}

function resolveFromLegacyMaps(searchCompact: string): string | null {
  if (!searchCompact || LEGACY_MAP_KEYS.length === 0 || LEGACY_ICON_NAMES.size === 0) {
    return null;
  }
  for (const rawKey of LEGACY_MAP_KEYS) {
    const key = compact(rawKey);
    if (!key || key.length < 2) continue;
    if (!searchCompact.includes(key)) continue;
    const icon = matchExistingIcon(key);
    if (icon) return icon;
  }
  return null;
}

export function resolveAwsIconName(nodeType?: string, nodeLabel?: string): string {
  const typeNorm = normalize(nodeType || '');
  const labelNorm = normalize(nodeLabel || '');
  const searchSpace = `${typeNorm} ${labelNorm}`.trim();
  const searchCompact = compact(searchSpace);

  for (const alias of AWS_ICON_ALIASES) {
    if (alias.keys.some((key) => searchSpace.includes(normalize(key)))) {
      return alias.icon;
    }
  }

  const legacyMapped = resolveFromLegacyMaps(searchCompact);
  if (legacyMapped) return legacyMapped;

  const typeCompact = compact(nodeType || '');
  const labelCompact = compact(nodeLabel || '');
  const fallbackSeed = typeCompact || labelCompact;
  const stripped = fallbackSeed.replace(/^(amazon|aws)/, '') || fallbackSeed;
  return matchExistingIcon(stripped) || 'default';
}
