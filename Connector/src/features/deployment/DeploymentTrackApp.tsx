'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronRight, CircleDashed, Download, ExternalLink, RefreshCw, Rocket, Server, Terminal } from 'lucide-react';
import { ResourceCard } from '@/components/pipeline/ResourceCard';
import { ApplyLogViewer } from '@/components/pipeline/ApplyLogViewer';
import { AwsConsoleTerminal } from '@/components/pipeline/AwsConsoleTerminal';
import { buildDeploymentWorkspace } from '@/lib/deployment-planning-contract';
import {
  DEPLOYMENT_WORKSPACE_STYLE,
  EndpointRow,
  MetaChip,
  StageHeader,
  Surface,
  SurfaceLabel,
  accentButtonClass,
  formatCostComponentLabel,
  primaryButtonClass,
  secondaryButtonClass,
  shortenDecisionHash,
} from '@/features/deployment/deployment-ui';
import {
  APPROVAL_PAYLOAD_KEY,
  ARCHITECTURE_VIEW_KEY,
  COST_ESTIMATE_KEY,
  CURRENT_STAGE_STORAGE_PREFIX,
  DEFAULT_AWS_REGION,
  DEPLOYMENT_PROFILE_KEY,
  DEPLOY_HISTORY_MAX,
  INFRA_CONSULTANT_KEY,
  IAC_FILES_KEY,
  IAC_META_KEY,
  IAC_RUN_KEY,
  PLANNING_PROJECT_KEY,
  QA_CONTEXT_KEY,
  REPO_CONTEXT_MD_KEY,
  REVIEW_ANSWERS_KEY,
  REVIEW_PAYLOAD_KEY,
  SELECTED_PROJECT_STORAGE_KEY,
  clearPlanningState,
  clearSavedAws,
  awsOperatorCredRemainingMs,
  readAppSecretsMeta,
  writeAppSecretsMeta,
  downloadTextFile,
  extractDeploymentSummary,
  getDeployableIacFiles,
  hasTruncatedIacFiles,
  loadDeploySnapshot,
  loadDeployUiStage,
  persistDeploySnapshot,
  readSavedTerraformRuntimeConfig,
  readIacFilesFromSession,
  readSavedIacMeta,
  readSavedAws,
  readSavedIacRun,
  readStoredJson,
  resolveTerraformRuntimeConfig,
  saveDeployUiStage,
  toHistoryEntry,
  type ArchitectureReviewPayload,
  type AwsSessionConfig,
  type DeployApiResult,
  type DeployLogEntry,
  type DeployStateSnapshot,
  type Ec2ResourceConfig,
  type RdsResourceConfig,
  type RedisResourceConfig,
  type EcsResourceConfig,
  type StaticSiteResourceConfig,
  type GeneratedIacFile,
  type InfraConsultantDecision,
  type InfraConsultantMessage,
  type InfraConsultantState,
  type ProjectRecord,
  type RepositoryContextJson,
  type SavedIacMeta,
  type SavedIacRun,
  type TerraformRuntimeConfig,
  clearObsoleteTerraformUiState,
  writeSavedTerraformRuntimeConfig,
  writeSavedAws,
  writeStoredJson,
} from './state';
import { hashDecisionAsync } from '@/lib/decision-hash';
import { AppSecretsPanel, type AppSecretMeta } from '@/features/deployment/AppSecretsPanel';

type PipelineStageId = 'analysis' | 'qa' | 'architecture' | 'cost_estimation' | 'terraform' | 'aws_config' | 'app_secrets' | 'deploy' | 'outputs';

type IacPrResponse = {
  attempted?: boolean;
  success?: boolean;
  pr_url?: string | null;
  reason?: string;
  error?: string;
};

type IacResourceOutputEntry = {
  key: string;
  label: string;
  value: string | string[] | number | boolean;
};

type IacResourceOutputs = {
  service_type: string;
  deployed_at: string;
  outputs: IacResourceOutputEntry[];
};

type IacKeypair = {
  private_key_pem: string;
  keypair_name: string;
};

type DeploymentPlanId = 'ec2' | 's3_cloudfront' | 'ecs_fargate';

type DeploymentServiceSelection = {
  rds: boolean;
  redis: boolean;
};

type DeploymentPlanOption = {
  id: DeploymentPlanId;
  label: string;
  description: string;
  services: string[];
};

const PIPELINE_SOCKET_RETRY_DELAYS_MS = [1000, 2000, 5000, 5000];
const CONNECTOR_READINESS_RETRY_DELAYS_MS = [0, 500, 1_500];
const APPROVED_DECISION_KEY = 'deplai.pipeline.approvedDecision';
const DECISION_COST_ESTIMATE_KEY = 'deplai.pipeline.decisionCostEstimate';
const DEPLOYMENT_PLAN_KEY = 'deplai.pipeline.deploymentPlan';
const DEPLOYMENT_SERVICES_KEY = 'deplai.pipeline.deploymentServices';
const EC2_RESOURCE_CONFIG_KEY = 'deplai.pipeline.ec2ResourceConfig';
const EC2_INSTANCE_TYPES = ['t3.micro', 't3.small', 't3.medium', 't3.large'] as const;
const DEFAULT_EC2_RESOURCE_CONFIG: Ec2ResourceConfig = {
  instance_type: 't3.micro',
  root_volume_size_gb: 35,
  app_port: 3000,
  ssh_ingress_cidr_blocks: [],
};

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

async function ensureConnectorApiReady(): Promise<void> {
  let lastReason = 'no response';

  for (const delayMs of CONNECTOR_READINESS_RETRY_DELAYS_MS) {
    if (delayMs > 0) await waitForDelay(delayMs);
    try {
      const response = await fetch('/api/health', {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (response.ok) return;
      lastReason = `HTTP ${response.status}`;
    } catch (error) {
      lastReason = error instanceof Error ? error.message : 'network error';
    }
  }

  throw new Error(
    `The DeplAI API is not ready to start Terraform generation (${lastReason}). ` +
    'Wait a moment for the Connector service to become healthy, then select Regenerate Terraform.',
  );
}

const DEPLOYMENT_PLAN_OPTIONS: DeploymentPlanOption[] = [
  {
    id: 'ec2',
    label: 'EC2 App',
    description: 'Single instance app deployment with public HTTP ingress. Best for low-cost app hosting and current runtime apply.',
    services: ['EC2', 'VPC', 'Subnets', 'Security Groups', 'IAM'],
  },
  {
    id: 's3_cloudfront',
    label: 'Static Site',
    description: 'S3 website object hosting behind CloudFront. Best for static frontend builds and public docs.',
    services: ['S3', 'CloudFront'],
  },
  {
    id: 'ecs_fargate',
    label: 'ECS Fargate',
    description: 'Containerized service behind an ALB. Best when the repo should run as managed containers.',
    services: ['ECS', 'ALB', 'ECR', 'CloudWatch', 'VPC'],
  },
];

const DEFAULT_DEPLOYMENT_SERVICES: DeploymentServiceSelection = {
  rds: false,
  redis: false,
};

const RDS_RESOURCE_CONFIG_KEY = 'deplai.pipeline.rdsResourceConfig';
const REDIS_RESOURCE_CONFIG_KEY = 'deplai.pipeline.redisResourceConfig';
const ECS_RESOURCE_CONFIG_KEY = 'deplai.pipeline.ecsResourceConfig';
const STATIC_SITE_RESOURCE_CONFIG_KEY = 'deplai.pipeline.staticSiteResourceConfig';

const RDS_ENGINES = ['postgres', 'mysql', 'mariadb', 'aurora-mysql', 'aurora-postgresql', 'oracle-ee', 'sqlserver-ex', 'db2-ae'] as const;

/** Per-engine metadata matching AWS RDS "Create database" engine options */
const RDS_ENGINE_META: Record<(typeof RDS_ENGINES)[number], {
  label: string;
  versions: string[];
  defaultVersion: string;
  instanceClasses: string[];
  defaultInstanceClass: string;
  minStorage: number;
  defaultStorage: number;
  supportsAurora: boolean;
  supportsMultiAz: boolean;
  licenseNote?: string;
}> = {
  postgres: {
    label: 'PostgreSQL',
    versions: ['17.4', '16.13', '15.17', '14.17', '13.20'],
    defaultVersion: '16.13',
    instanceClasses: ['db.t4g.micro', 'db.t4g.small', 'db.t3.small', 'db.t3.medium', 'db.m7g.large', 'db.r8g.large'],
    defaultInstanceClass: 'db.t4g.micro',
    minStorage: 20,
    defaultStorage: 20,
    supportsAurora: false,
    supportsMultiAz: true,
  },
  mysql: {
    label: 'MySQL',
    versions: ['8.4.4', '8.0.41'],
    defaultVersion: '8.0.41',
    instanceClasses: ['db.t4g.micro', 'db.t4g.small', 'db.t3.small', 'db.t3.medium', 'db.m7g.large', 'db.r8g.large'],
    defaultInstanceClass: 'db.t4g.micro',
    minStorage: 20,
    defaultStorage: 20,
    supportsAurora: false,
    supportsMultiAz: true,
  },
  mariadb: {
    label: 'MariaDB',
    versions: ['11.4.5', '10.11.11', '10.6.21'],
    defaultVersion: '10.11.11',
    instanceClasses: ['db.t4g.micro', 'db.t4g.small', 'db.t3.small', 'db.t3.medium', 'db.m7g.large', 'db.r8g.large'],
    defaultInstanceClass: 'db.t4g.micro',
    minStorage: 20,
    defaultStorage: 20,
    supportsAurora: false,
    supportsMultiAz: true,
  },
  'aurora-mysql': {
    label: 'Aurora (MySQL Compatible)',
    versions: ['MySQL 8.0 (3.09)', 'MySQL 8.0 (3.08)', 'MySQL 5.7 (2.12)'],
    defaultVersion: 'MySQL 8.0 (3.09)',
    instanceClasses: ['db.serverless', 'db.t4g.medium', 'db.r8g.large', 'db.r8g.xlarge', 'db.r8g.2xlarge'],
    defaultInstanceClass: 'db.serverless',
    minStorage: 10,
    defaultStorage: 10,
    supportsAurora: true,
    supportsMultiAz: false,
    licenseNote: 'Aurora storage auto-scales from 10 GiB to 128 TiB.',
  },
  'aurora-postgresql': {
    label: 'Aurora (PostgreSQL Compatible)',
    versions: ['PostgreSQL 17.4', 'PostgreSQL 16.13', 'PostgreSQL 15.17', 'PostgreSQL 14.17'],
    defaultVersion: 'PostgreSQL 17.4',
    instanceClasses: ['db.serverless', 'db.t4g.medium', 'db.r8g.large', 'db.r8g.xlarge', 'db.r8g.2xlarge'],
    defaultInstanceClass: 'db.serverless',
    minStorage: 10,
    defaultStorage: 10,
    supportsAurora: true,
    supportsMultiAz: false,
    licenseNote: 'Aurora storage auto-scales from 10 GiB to 128 TiB.',
  },
  'oracle-ee': {
    label: 'Oracle',
    versions: ['19.0.0.0.ru-2024-07'],
    defaultVersion: '19.0.0.0.ru-2024-07',
    instanceClasses: ['db.t3.small', 'db.t3.medium', 'db.m7g.large', 'db.r8g.large', 'db.r8g.xlarge'],
    defaultInstanceClass: 'db.t3.medium',
    minStorage: 20,
    defaultStorage: 100,
    supportsAurora: false,
    supportsMultiAz: true,
    licenseNote: 'Oracle Enterprise Edition — requires BYOL or License Included.',
  },
  'sqlserver-ex': {
    label: 'Microsoft SQL Server',
    versions: ['SQL Server 2022 16.00', 'SQL Server 2019 15.00', 'SQL Server 2017 14.00'],
    defaultVersion: 'SQL Server 2022 16.00',
    instanceClasses: ['db.t3.small', 'db.t3.medium', 'db.m7g.large', 'db.r8g.large'],
    defaultInstanceClass: 'db.t3.medium',
    minStorage: 20,
    defaultStorage: 100,
    supportsAurora: false,
    supportsMultiAz: true,
    licenseNote: 'SQL Server Express (free license) — limited to 1 vCPU, 1 GiB RAM, 10 GiB DB.',
  },
  'db2-ae': {
    label: 'IBM Db2',
    versions: ['Db2 11.5.9'],
    defaultVersion: 'Db2 11.5.9',
    instanceClasses: ['db.t3.small', 'db.t3.medium', 'db.m7g.large', 'db.r8g.large'],
    defaultInstanceClass: 'db.t3.medium',
    minStorage: 20,
    defaultStorage: 100,
    supportsAurora: false,
    supportsMultiAz: true,
    licenseNote: 'IBM Db2 Advanced Edition.',
  },
};

const DEFAULT_RDS_RESOURCE_CONFIG: RdsResourceConfig = {
  engine: 'postgres',
  engine_version: '16.6',
  instance_class: 'db.t4g.micro',
  allocated_storage: 20,
  multi_az: false,
  backup_retention_period: 7,
  instance_size_tier: 'free_tier',
  db_identifier: 'database-1',
  master_username: 'admin',
  credentials_mode: 'self_managed',
  auto_generate_password: false,
  master_password: '',
  aurora_min_acu: 0,
  aurora_max_acu: 4,
  aurora_pause_after_inactivity: 300,
  storage_type: 'gp3',
  storage_autoscaling: true,
  max_allocated_storage: 1000,
  publicly_accessible: false,
  aurora_cluster_storage_type: 'standard',
  aurora_replica_count: 0,
  deletion_protection: false,
};


const DEFAULT_REDIS_RESOURCE_CONFIG: RedisResourceConfig = {
  node_type: 'cache.t4g.micro',
  engine_version: '7.0',
};
const DEFAULT_ECS_RESOURCE_CONFIG: EcsResourceConfig = {
  cpu: 512,
  memory: 1024,
  desired_count: 1,
};
const DEFAULT_STATIC_SITE_RESOURCE_CONFIG: StaticSiteResourceConfig = {
  price_class: 'PriceClass_100',
  spa_fallback: false,
};

const REDIS_NODE_TYPES = ['cache.t4g.micro', 'cache.t3.small', 'cache.t3.medium', 'cache.r6g.large'] as const;
const REDIS_ENGINE_VERSIONS = ['7.0', '6.2'] as const;
const ECS_CPU_OPTIONS = [256, 512, 1024, 2048, 4096] as const;
const ECS_MEMORY_OPTIONS = [512, 1024, 2048, 3072, 4096, 8192] as const;
const CLOUDFRONT_PRICE_CLASSES = ['PriceClass_100', 'PriceClass_200', 'PriceClass_All'] as const;

function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'on'].includes(normalized)) return true;
  if (['false', 'no', 'n', '0', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeRdsResourceConfig(value: unknown): RdsResourceConfig {
  const record = toRecord(value);
  const engine = RDS_ENGINES.includes(String(record.engine || '').trim().toLowerCase() as (typeof RDS_ENGINES)[number])
    ? String(record.engine).trim().toLowerCase() as RdsResourceConfig['engine']
    : DEFAULT_RDS_RESOURCE_CONFIG.engine;
  const meta = RDS_ENGINE_META[engine];
  const requestedClass = String(record.instance_class || '').trim();
  const isAuroraServerless = meta.supportsAurora && (requestedClass === 'db.serverless' || !requestedClass);
  const credentialsMode = record.credentials_mode === 'secrets_manager' ? 'secrets_manager' : 'self_managed';
  const sizeTiers = ['production', 'dev_test', 'free_tier'] as const;
  const requestedTier = String(record.instance_size_tier || '').trim();
  return {
    engine,
    engine_version: String(record.engine_version || meta.defaultVersion).trim() || meta.defaultVersion,
    instance_class: requestedClass || meta.defaultInstanceClass,
    allocated_storage: meta.supportsAurora
      ? meta.defaultStorage
      : clampInteger(record.allocated_storage ?? record.storage_gb, meta.defaultStorage, meta.minStorage, 4096),
    multi_az: meta.supportsAurora ? false : normalizeBool(record.multi_az, DEFAULT_RDS_RESOURCE_CONFIG.multi_az),
    backup_retention_period: clampInteger(record.backup_retention_period ?? record.backup_retention_days, DEFAULT_RDS_RESOURCE_CONFIG.backup_retention_period, 0, 35),
    aurora_mode: meta.supportsAurora ? (isAuroraServerless ? 'serverless' : 'provisioned') : undefined,
    instance_size_tier: sizeTiers.includes(requestedTier as (typeof sizeTiers)[number]) ? requestedTier as RdsResourceConfig['instance_size_tier'] : DEFAULT_RDS_RESOURCE_CONFIG.instance_size_tier,
    db_identifier: String(record.db_identifier || DEFAULT_RDS_RESOURCE_CONFIG.db_identifier || 'database-1').trim(),
    master_username: String(record.master_username || DEFAULT_RDS_RESOURCE_CONFIG.master_username || 'admin').trim(),
    credentials_mode: credentialsMode,
    auto_generate_password: normalizeBool(record.auto_generate_password, false),
    master_password: String(record.master_password || ''),
    aurora_min_acu: clampInteger(record.aurora_min_acu, 0, 0, 256),
    aurora_max_acu: clampInteger(record.aurora_max_acu, 4, 1, 256),
    aurora_pause_after_inactivity: clampInteger(record.aurora_pause_after_inactivity, 300, 300, 86400),
    storage_type: ['gp3', 'gp2', 'io1', 'standard'].includes(String(record.storage_type)) ? String(record.storage_type) as RdsResourceConfig['storage_type'] : DEFAULT_RDS_RESOURCE_CONFIG.storage_type,
    storage_autoscaling: normalizeBool(record.storage_autoscaling, DEFAULT_RDS_RESOURCE_CONFIG.storage_autoscaling ?? true),
    max_allocated_storage: clampInteger(record.max_allocated_storage, 1000, 21, 65536),
    publicly_accessible: normalizeBool(record.publicly_accessible, DEFAULT_RDS_RESOURCE_CONFIG.publicly_accessible ?? false),
    aurora_cluster_storage_type: record.aurora_cluster_storage_type === 'io_optimized' ? 'io_optimized' : 'standard',
    aurora_replica_count: clampInteger(record.aurora_replica_count, 0, 0, 15),
    deletion_protection: normalizeBool(record.deletion_protection, DEFAULT_RDS_RESOURCE_CONFIG.deletion_protection ?? false),
  };
}


function normalizeRedisResourceConfig(value: unknown): RedisResourceConfig {
  const record = toRecord(value);
  const requestedNode = String(record.node_type || '').trim();
  const requestedVersion = String(record.engine_version || record.version || '').trim();
  return {
    node_type: requestedNode || DEFAULT_REDIS_RESOURCE_CONFIG.node_type,
    engine_version: requestedVersion || DEFAULT_REDIS_RESOURCE_CONFIG.engine_version,
  };
}

function normalizeEcsResourceConfig(value: unknown): EcsResourceConfig {
  const record = toRecord(value);
  return {
    cpu: clampInteger(record.cpu, DEFAULT_ECS_RESOURCE_CONFIG.cpu, 256, 16384),
    memory: clampInteger(record.memory, DEFAULT_ECS_RESOURCE_CONFIG.memory, 512, 122880),
    desired_count: clampInteger(record.desired_count, DEFAULT_ECS_RESOURCE_CONFIG.desired_count, 1, 20),
  };
}

function normalizeStaticSiteResourceConfig(value: unknown): StaticSiteResourceConfig {
  const record = toRecord(value);
  const priceClass = CLOUDFRONT_PRICE_CLASSES.includes(String(record.price_class || '').trim() as (typeof CLOUDFRONT_PRICE_CLASSES)[number])
    ? String(record.price_class).trim() as StaticSiteResourceConfig['price_class']
    : DEFAULT_STATIC_SITE_RESOURCE_CONFIG.price_class;
  return {
    price_class: priceClass,
    spa_fallback: normalizeBool(record.spa_fallback, DEFAULT_STATIC_SITE_RESOURCE_CONFIG.spa_fallback),
  };
}

function readRdsResourceConfig(): RdsResourceConfig {
  return normalizeRdsResourceConfig(readStoredJson<Partial<RdsResourceConfig>>(RDS_RESOURCE_CONFIG_KEY) || DEFAULT_RDS_RESOURCE_CONFIG);
}
function readRedisResourceConfig(): RedisResourceConfig {
  return normalizeRedisResourceConfig(readStoredJson<Partial<RedisResourceConfig>>(REDIS_RESOURCE_CONFIG_KEY) || DEFAULT_REDIS_RESOURCE_CONFIG);
}
function readEcsResourceConfig(): EcsResourceConfig {
  return normalizeEcsResourceConfig(readStoredJson<Partial<EcsResourceConfig>>(ECS_RESOURCE_CONFIG_KEY) || DEFAULT_ECS_RESOURCE_CONFIG);
}
function readStaticSiteResourceConfig(): StaticSiteResourceConfig {
  return normalizeStaticSiteResourceConfig(readStoredJson<Partial<StaticSiteResourceConfig>>(STATIC_SITE_RESOURCE_CONFIG_KEY) || DEFAULT_STATIC_SITE_RESOURCE_CONFIG);
}

function normalizeDeploymentPlanId(value: unknown): DeploymentPlanId {
  const raw = String(value || '').trim();
  return DEPLOYMENT_PLAN_OPTIONS.some((option) => option.id === raw) ? raw as DeploymentPlanId : 'ec2';
}

function readDeploymentServices(): DeploymentServiceSelection {
  const saved = readStoredJson<Partial<DeploymentServiceSelection>>(DEPLOYMENT_SERVICES_KEY) || {};
  return {
    ...DEFAULT_DEPLOYMENT_SERVICES,
    rds: saved.rds === true,
    redis: saved.redis === true,
  };
}

function clampInteger(value: unknown, defaultValue: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeCidrList(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  return Array.from(new Set(
    rawItems
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .filter((item) => /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(item)),
  ));
}

function normalizeEc2ResourceConfig(value: unknown): Ec2ResourceConfig {
  const record = toRecord(value);
  const requestedInstanceType = String(record.instance_type || '').trim().toLowerCase();
  return {
    instance_type: EC2_INSTANCE_TYPES.includes(requestedInstanceType as typeof EC2_INSTANCE_TYPES[number])
      ? requestedInstanceType
      : DEFAULT_EC2_RESOURCE_CONFIG.instance_type,
    root_volume_size_gb: clampInteger(record.root_volume_size_gb, DEFAULT_EC2_RESOURCE_CONFIG.root_volume_size_gb, 20, 200),
    app_port: clampInteger(record.app_port, DEFAULT_EC2_RESOURCE_CONFIG.app_port, 1, 65535),
    ssh_ingress_cidr_blocks: normalizeCidrList(record.ssh_ingress_cidr_blocks),
  };
}

function readEc2ResourceConfig(): Ec2ResourceConfig {
  return normalizeEc2ResourceConfig(readStoredJson<Partial<Ec2ResourceConfig>>(EC2_RESOURCE_CONFIG_KEY) || DEFAULT_EC2_RESOURCE_CONFIG);
}

function ec2ResourceConfigFromDecision(decision: InfraConsultantDecision | null | undefined): Ec2ResourceConfig {
  const stackConfig = toRecord(decision?.stack_config);
  return normalizeEc2ResourceConfig({
    ...DEFAULT_EC2_RESOURCE_CONFIG,
    ...toRecord(stackConfig['ec2-instance']),
    ...toRecord(stackConfig.ec2),
  });
}

function rdsResourceConfigFromDecision(decision: InfraConsultantDecision | null | undefined): RdsResourceConfig | null {
  const stackConfig = toRecord(decision?.stack_config);
  const rds = toRecord(stackConfig.rds);
  if (Object.keys(rds).length === 0) return null;
  return normalizeRdsResourceConfig({ ...DEFAULT_RDS_RESOURCE_CONFIG, ...rds });
}

function redisResourceConfigFromDecision(decision: InfraConsultantDecision | null | undefined): RedisResourceConfig | null {
  const stackConfig = toRecord(decision?.stack_config);
  const redis = toRecord(stackConfig.elasticache || stackConfig.redis);
  if (Object.keys(redis).length === 0) return null;
  return normalizeRedisResourceConfig({ ...DEFAULT_REDIS_RESOURCE_CONFIG, ...redis });
}

function ecsResourceConfigFromDecision(decision: InfraConsultantDecision | null | undefined): EcsResourceConfig | null {
  const stackConfig = toRecord(decision?.stack_config);
  const ecs = toRecord(stackConfig.ecs);
  if (Object.keys(ecs).length === 0) return null;
  return normalizeEcsResourceConfig({ ...DEFAULT_ECS_RESOURCE_CONFIG, ...ecs });
}

function staticSiteResourceConfigFromDecision(decision: InfraConsultantDecision | null | undefined): StaticSiteResourceConfig | null {
  const stackConfig = toRecord(decision?.stack_config);
  const site = toRecord(stackConfig.s3_cloudfront || stackConfig.static_site);
  if (Object.keys(site).length === 0) return null;
  return normalizeStaticSiteResourceConfig({ ...DEFAULT_STATIC_SITE_RESOURCE_CONFIG, ...site });
}

function normalizeDecisionStackConfigForUi(
  decision: InfraConsultantDecision | null | undefined,
  ec2Config: Ec2ResourceConfig,
): Record<string, unknown> {
  const stackConfig = toRecord(decision?.stack_config);
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stackConfig)) {
    const component = canonicalDecisionComponent(key);
    if (!component) continue;
    if (component === 'ec2') {
      normalized.ec2 = {
        ...toRecord(stackConfig['ec2-instance']),
        ...toRecord(value),
        ...normalizeEc2ResourceConfig({ ...toRecord(value), ...ec2Config }),
      };
    } else if (component === 'elasticache') {
      normalized.elasticache = {
        ...toRecord(normalized.elasticache),
        ...toRecord(value),
      };
    } else {
      normalized[component] = {
        ...toRecord(normalized[component]),
        ...toRecord(value),
      };
    }
  }
  normalized.ec2 = {
    ...toRecord(normalized.ec2),
    ...ec2Config,
  };
  delete normalized.redis;
  return normalized;
}

function deploymentPlanToServiceType(planId: DeploymentPlanId): string {
  if (planId === 's3_cloudfront') return 's3';
  if (planId === 'ecs_fargate') return 'ecs';
  return 'ec2';
}

function deploymentPlanComponents(planId: DeploymentPlanId, services: DeploymentServiceSelection, priorDecision?: InfraConsultantDecision | null): string[] {
  const components = planId === 's3_cloudfront'
    ? ['s3_cloudfront']
    : planId === 'ecs_fargate'
      ? ['vpc', 'alb', 'ecs']
      : ['vpc', 'ec2'];
  if (services.rds) components.push('rds');
  if (services.redis) components.push('elasticache');

  // Preserve consult intakes (ALB/EIP) across operator plan toggles for EC2-class apps.
  if (planId === 'ec2') {
    const priorComponents = Array.isArray(priorDecision?.components)
      ? priorDecision.components.map((item) => String(item || '').trim().toLowerCase())
      : [];
    const stack = priorDecision?.stack_config && typeof priorDecision.stack_config === 'object'
      ? priorDecision.stack_config as Record<string, unknown>
      : {};
    if (priorComponents.includes('alb') || stack.alb || priorDecision && (priorDecision as { need_alb?: boolean }).need_alb) {
      components.push('alb');
    }
    if (priorComponents.includes('eip') || stack.eip || priorDecision && (priorDecision as { need_eip?: boolean }).need_eip) {
      components.push('eip');
    }
  }
  return Array.from(new Set(components));
}

interface DeploymentResourceConfigs {
  ec2: Ec2ResourceConfig;
  rds: RdsResourceConfig;
  redis: RedisResourceConfig;
  ecs: EcsResourceConfig;
  staticSite: StaticSiteResourceConfig;
}

function applyDeploymentSelectionToDecision(
  decision: InfraConsultantDecision | null | undefined,
  planId: DeploymentPlanId,
  services: DeploymentServiceSelection,
  configs: DeploymentResourceConfigs,
  awsRegion: string,
): InfraConsultantDecision {
  const ec2Config = configs.ec2;
  const components = deploymentPlanComponents(planId, services, decision);
  const baseStackConfig = normalizeDecisionStackConfigForUi(decision, ec2Config);
  const stackConfig: Record<string, unknown> = {};
  for (const component of components) {
    stackConfig[component] = toRecord(baseStackConfig[component]);
  }
  // Keep networking/alb/eip config from the consult decision even when empty shells were created.
  if (components.includes('alb') && Object.keys(toRecord(stackConfig.alb)).length === 0) {
    stackConfig.alb = {
      enabled: true,
      scheme: 'internet-facing',
      need_alb: true,
      target_port: ec2Config.app_port,
    };
  }
  if (components.includes('eip') && Object.keys(toRecord(stackConfig.eip)).length === 0) {
    stackConfig.eip = { enabled: true, associate_with: 'ec2', need_eip: true };
  }
  if (toRecord(baseStackConfig.networking) && Object.keys(toRecord(baseStackConfig.networking)).length > 0) {
    stackConfig.networking = toRecord(baseStackConfig.networking);
  }
  if (components.includes('ec2') && Object.keys(toRecord(stackConfig.ec2)).length === 0) {
    stackConfig.ec2 = { ...ec2Config, desired_count: 1 };
  } else if (components.includes('ec2')) {
    stackConfig.ec2 = { ...toRecord(stackConfig.ec2), ...ec2Config };
  }
  if (components.includes('ecs')) {
    stackConfig.ecs = {
      ...toRecord(stackConfig.ecs),
      cpu: configs.ecs.cpu,
      memory: configs.ecs.memory,
      desired_count: configs.ecs.desired_count,
    };
  }
  if (components.includes('s3_cloudfront')) {
    stackConfig.s3_cloudfront = {
      ...toRecord(stackConfig.s3_cloudfront),
      origin_type: 's3',
      price_class: configs.staticSite.price_class,
      spa_fallback: configs.staticSite.spa_fallback,
    };
  }
  if (services.rds) {
    stackConfig.rds = {
      ...toRecord(stackConfig.rds),
      engine: configs.rds.engine,
      engine_version: configs.rds.engine_version,
      instance_class: configs.rds.instance_class,
      allocated_storage: configs.rds.allocated_storage,
      multi_az: configs.rds.multi_az,
      backup_retention_period: configs.rds.backup_retention_period,
    };
  }
  if (services.redis) {
    stackConfig.elasticache = {
      ...toRecord(stackConfig.elasticache),
      engine: 'redis',
      node_type: configs.redis.node_type,
      engine_version: configs.redis.engine_version,
    };
  }

  const selectedPlan = DEPLOYMENT_PLAN_OPTIONS.find((option) => option.id === planId) || DEPLOYMENT_PLAN_OPTIONS[0];
  const note = `Operator selected ${selectedPlan.label}${services.rds || services.redis ? ` with ${[services.rds ? 'RDS' : '', services.redis ? 'Redis' : ''].filter(Boolean).join(' and ')}` : ''}.`;
  const existingNotes = Array.isArray(decision?.consultant_notes)
    ? decision.consultant_notes.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  return {
    ...(decision || {}),
    provider: 'aws',
    region: String(awsRegion || DEFAULT_AWS_REGION).trim() || DEFAULT_AWS_REGION,
    components,
    deploy_sequence: components,
    stack_config: stackConfig,
    need_alb: components.includes('alb'),
    need_eip: components.includes('eip'),
    consultant_notes: [note, ...existingNotes.filter((item) => item !== note)],
    outputs_to_capture: Array.isArray(decision?.outputs_to_capture)
      ? decision.outputs_to_capture
      : ['application_url', 'public_ip', 'cloudfront_url'],
  } as InfraConsultantDecision;
}

const SIDEBAR_STAGES: Array<{ id: PipelineStageId; label: string; details: string }> = [
  { id: 'analysis', label: 'Repository Analysis', details: 'Codebase Scan' },
  { id: 'qa', label: 'Questions', details: 'Interactive Q&A' },
  { id: 'architecture', label: 'Architecture Diagram', details: 'Stage 3' },
  { id: 'cost_estimation', label: 'Cost Estimation', details: 'Stage 4' },
  { id: 'terraform', label: 'Infrastructure Generation', details: 'Generator' },
  { id: 'aws_config', label: 'AWS Config', details: 'Runtime Inputs' },
  { id: 'app_secrets', label: 'App Secrets', details: 'Env & OAuth' },
  { id: 'deploy', label: 'Deploy', details: 'Execution' },
  { id: 'outputs', label: 'Outputs', details: 'Credentials & URLs' },
];

function normalizeDeployUiStage(value: unknown): PipelineStageId {
  const stage = String(value || '').trim();
  if (stage === 'approval') return 'terraform';
  return SIDEBAR_STAGES.some((entry) => entry.id === stage) ? stage as PipelineStageId : 'analysis';
}

function timestampLabel(date = new Date()) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function normalizeIacFiles(files: GeneratedIacFile[]): GeneratedIacFile[] {
  const byPath = new Map<string, GeneratedIacFile>();
  for (const file of files) {
    const path = String(file.path || '').trim();
    if (!path) continue;
    if (path.startsWith('terraform/site/') && path !== 'terraform/site/index.html') continue;
    byPath.set(path, { path, content: String(file.content || '') });
  }
  return Array.from(byPath.values());
}

function readCostEstimate() {
  const raw = readStoredJson<{ total_monthly_usd?: number; budget_cap_usd?: number }>(COST_ESTIMATE_KEY);
  return { total: Number(raw?.total_monthly_usd || 0), cap: Number(raw?.budget_cap_usd || 100) };
}

type DecisionDiagramNode = {
  id: string;
  label: string;
  x: number;
  y: number;
  color: string;
  category: 'networking' | 'compute' | 'data' | 'security' | 'observability';
  details: string[];
};

type DecisionDiagramEdge = {
  from: string;
  to: string;
  label: string;
};

type DecisionDiagramModel = {
  awsRegion: string;
  components: string[];
  nodes: DecisionDiagramNode[];
  edges: DecisionDiagramEdge[];
  hasVpcBoundary: boolean;
  hasMultiAz: boolean;
  hasPrivateTier: boolean;
};

type DecisionCostLineItem = {
  component: string;
  label: string;
  hourly_usd: number;
  monthly_usd: number;
  note: string;
  source: 'pricing_api' | 'fallback';
};

type DecisionCostEstimate = {
  success: boolean;
  currency: string;
  source: 'pricing_api' | 'fallback';
  based_on_decision?: boolean;
  decision_hash?: string;
  fallback_reason?: string;
  line_items: DecisionCostLineItem[];
  subtotal_monthly_usd: number;
  variance_note: string;
  optimization_tips: string[];
  error?: string;
};

type ApprovedDecisionState = {
  workspace: string;
  decision: InfraConsultantDecision;
  locked_at: string;
};

type ApprovalPayload = {
  diagram?: {
    nodes?: Array<Record<string, unknown>>;
    edges?: Array<Record<string, unknown>>;
    region?: string;
  };
  cost_estimate?: {
    line_items?: unknown;
    total_monthly_usd?: number;
  };
  budget_gate?: {
    cap_usd?: number;
  };
};

type PipelineSocketState = 'idle' | 'connecting' | 'connected' | 'error';

type DeployStatusResponse = {
  success?: boolean;
  status?: string;
  result?: unknown;
  error?: string;
};

type EndpointVerificationCheck = {
  label: string;
  url: string;
  ok: boolean;
  status: number | null;
  detail: string;
};

type OutputBannerState = {
  tone: 'success' | 'warning' | 'error';
  label: string;
  title: string;
  description: string;
};

type SocketNotice = {
  key: string;
  text: string;
  ts: string;
  tone: 'info' | 'error';
};

type TerraformRendererSummary = {
  primary: string;
  runtime: string;
  secondary: string;
  warning: string | null;
};

type AwsRuntimeLiveInstance = {
  instance_id?: string;
  public_ipv4_address?: string;
  private_ipv4_address?: string;
  instance_state?: string;
  instance_type?: string;
  public_dns?: string;
  private_dns?: string;
  vpc_id?: string;
  subnet_id?: string;
  instance_arn?: string;
};

type AwsRuntimeLiveCounts = {
  ec2_instances_total?: number;
  ec2_instances_running?: number;
  vpcs?: number;
  subnets?: number;
  nat_gateways?: number;
  internet_gateways?: number;
  route_tables?: number;
  security_groups?: number;
  key_pairs?: number;
  s3_buckets?: number;
  cloudfront_distributions?: number;
};

type AwsRuntimeLiveDetails = {
  region?: string;
  account_id?: string;
  instance?: AwsRuntimeLiveInstance;
  resource_counts?: AwsRuntimeLiveCounts;
};

type DeployStatus = DeployStateSnapshot['status'];
type DeployLog = DeployStateSnapshot['logs'][number];

type ActiveDeployState = {
  status: DeployStatus;
  progress: number;
  logs: DeployLog[];
  deployResult: DeployApiResult | null;
  deploymentHistory: DeployStateSnapshot['deploymentHistory'];
  updatedAt?: string;
};

type ActiveDeployEntry = {
  state: ActiveDeployState;
  listeners: Set<(state: ActiveDeployState) => void>;
  inFlight: boolean;
};

function matchesCurrentIacWorkspace(
  meta: SavedIacMeta | null,
  projectId: string | null,
  workspace: string,
): boolean {
  if (!meta || !projectId) return false;
  if (meta.project_id !== projectId) return false;
  if (meta.workspace && workspace && meta.workspace !== workspace) {
    const legacyGeneratedWorkspace =
      !meta.workspace.startsWith('deploy-') &&
      workspace.startsWith('deploy-');
    if (!legacyGeneratedWorkspace) return false;
  }
  return true;
}

function getCurrentSavedRun(
  savedRun: SavedIacRun | null,
  meta: SavedIacMeta | null,
  projectId: string | null,
  workspace: string,
): SavedIacRun | null {
  if (!savedRun || !meta?.has_run) return null;
  return matchesCurrentIacWorkspace(meta, projectId, workspace) ? savedRun : null;
}

function hasSuccessfulTerraformGeneration(
  projectId: string | null,
  workspace: string,
  meta: SavedIacMeta | null,
  savedRun: SavedIacRun | null,
  files: GeneratedIacFile[],
): boolean {
  if (!matchesCurrentIacWorkspace(meta, projectId, workspace)) return false;
  if (savedRun?.run_id && savedRun.workspace) return true;
  return getDeployableIacFiles(files).length > 0;
}

function describeTerraformRenderer(meta: SavedIacMeta | null): TerraformRendererSummary {
  const actualRenderer = String(meta?.actual_renderer || '').trim().toLowerCase();
  if (actualRenderer === 'terraform_agent_multi_worker_dynamic') {
    return {
      primary: 'Terraform Agent',
      runtime: 'Terraform runtime',
      secondary: 'LLM worker generated Terraform bundle',
      warning: null,
    };
  }
  if (actualRenderer === 'terraform_agent_multi_worker_partial_fallback' || actualRenderer === 'terraform_agent_full_fallback') {
    return {
      primary: 'Terraform Agent',
      runtime: 'Terraform runtime',
      secondary: String(meta?.unsupported_reason || '').trim() || 'Dynamic generation with deterministic rescue',
      warning: null,
    };
  }
  if (actualRenderer === 'deplai_ec2_app') {
    return {
      primary: 'DeplAI EC2 App',
      runtime: 'Terraform runtime',
      secondary: String(meta?.deployment_package_id || '').trim() || 'Deterministic app package renderer',
      warning: null,
    };
  }
  if (actualRenderer === 'deplai_deterministic') {
    return {
      primary: 'DeplAI Terraform',
      runtime: 'Terraform runtime',
      secondary: String(meta?.unsupported_reason || '').trim() || 'Legacy deterministic renderer',
      warning: null,
    };
  }
  return {
    primary: 'Terraform Generator',
    runtime: 'Terraform runtime',
    secondary: 'Renderer metadata unavailable',
    warning: 'Renderer metadata unavailable for this generation. Showing a neutral generator summary.',
  };
}

const activeDeployments = new Map<string, ActiveDeployEntry>();

function toDeployState(snapshot?: Partial<ActiveDeployState>): ActiveDeployState {
  return {
    status: snapshot?.status === 'running' || snapshot?.status === 'done' || snapshot?.status === 'error' ? snapshot.status : 'idle',
    progress: Number.isFinite(snapshot?.progress) ? Number(snapshot?.progress) : 0,
    logs: Array.isArray(snapshot?.logs) ? snapshot.logs : [],
    deployResult: snapshot?.deployResult && typeof snapshot.deployResult === 'object' ? snapshot.deployResult : null,
    deploymentHistory: Array.isArray(snapshot?.deploymentHistory) ? snapshot.deploymentHistory : [],
    updatedAt: typeof snapshot?.updatedAt === 'string' ? snapshot.updatedAt : undefined,
  };
}

function getOrCreateActiveDeployment(projectId: string, seed?: Partial<ActiveDeployState>): ActiveDeployEntry {
  const existing = activeDeployments.get(projectId);
  if (existing) return existing;
  const created: ActiveDeployEntry = {
    state: toDeployState(seed),
    listeners: new Set(),
    inFlight: false,
  };
  activeDeployments.set(projectId, created);
  return created;
}

function emitActiveDeployment(projectId: string): void {
  const entry = activeDeployments.get(projectId);
  if (!entry) return;
  for (const listener of entry.listeners) listener(entry.state);
}

function persistActiveDeploymentState(projectId: string, state: ActiveDeployState): void {
  if (typeof window === 'undefined') return;
  persistDeploySnapshot(projectId, {
    status: state.status,
    progress: state.progress,
    logs: state.logs,
    deployResult: state.deployResult,
    deploymentHistory: state.deploymentHistory,
    updatedAt: new Date().toISOString(),
  });
}

function setActiveDeploymentState(projectId: string, next: ActiveDeployState): void {
  const entry = getOrCreateActiveDeployment(projectId);
  entry.state = toDeployState(next);
  persistActiveDeploymentState(projectId, entry.state);
  emitActiveDeployment(projectId);
}

function patchActiveDeploymentState(
  projectId: string,
  patch: Partial<ActiveDeployState> | ((prev: ActiveDeployState) => ActiveDeployState),
): ActiveDeployState {
  const entry = getOrCreateActiveDeployment(projectId);
  const next = typeof patch === 'function'
    ? patch(entry.state)
    : { ...entry.state, ...patch };
  entry.state = toDeployState({ ...next, updatedAt: new Date().toISOString() });
  persistActiveDeploymentState(projectId, entry.state);
  emitActiveDeployment(projectId);
  return entry.state;
}

function extractLiveRuntimeDetails(result: DeployApiResult | null): AwsRuntimeLiveDetails | null {
  const details = result?.details;
  if (!details || typeof details !== 'object') return null;
  const live = (details as { live_runtime_details?: AwsRuntimeLiveDetails }).live_runtime_details;
  return live && typeof live === 'object' ? live : null;
}

function mergeDeployResultWithRuntimeDetails(
  result: DeployApiResult | null,
  details: AwsRuntimeLiveDetails,
): DeployApiResult {
  return {
    ...((result || {}) as DeployApiResult),
    details: {
      ...(((result?.details as Record<string, unknown> | null | undefined) || {})),
      live_runtime_details: details,
    },
  };
}

function getLiveRuntimeInstanceId(result: DeployApiResult | null): string {
  const liveDetails = extractLiveRuntimeDetails(result);
  return String(liveDetails?.instance?.instance_id || '').trim();
}

function normalizeVerificationChecks(raw: unknown): EndpointVerificationCheck[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const entry = item && typeof item === 'object' ? item as Record<string, unknown> : null;
      if (!entry) return null;
      return {
        label: String(entry.label || 'endpoint'),
        url: String(entry.url || ''),
        ok: Boolean(entry.ok),
        status: typeof entry.status === 'number' ? entry.status : null,
        detail: String(entry.detail || ''),
      } satisfies EndpointVerificationCheck;
    })
    .filter((item): item is EndpointVerificationCheck => item !== null);
}

function labelForAnswer(
  review: ArchitectureReviewPayload | null,
  questionId: string,
  value: string,
): string {
  const question = review?.questions.find((entry) => entry.id === questionId);
  return question?.options?.find((option) => option.value === value)?.label || value;
}

function formatQuestionCategory(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return 'Deployment';
  return raw
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function questionInputPlaceholder(questionId: string, fallback: string | null | undefined): string {
  const value = String(fallback || '').trim();
  if (value) return value;
  if (questionId === 'q_domain') return 'api.example.com';
  return 'Type your answer';
}

function buildQaSummary(
  review: ArchitectureReviewPayload | null,
  answers: Record<string, string>,
  repoContext: RepositoryContextJson | null,
  repoContextMd: string,
): string {
  const blocks: string[] = [];
  const summary = String(repoContext?.summary || '').trim();
  if (summary) {
    blocks.push(`Repository summary:\n${summary}`);
  }
  const runtime = String(repoContext?.language?.runtime || '').trim();
  const frameworks = Array.isArray(repoContext?.frameworks)
    ? repoContext.frameworks.map((item) => String(item.name || '')).filter(Boolean)
    : [];
  const dataStores = Array.isArray(repoContext?.data_stores)
    ? repoContext.data_stores.map((item) => String(item.type || '')).filter(Boolean)
    : [];
  const processes = Array.isArray(repoContext?.processes)
    ? repoContext.processes.map((item) => `${String(item.type || 'process')}: ${String(item.command || item.source || '').trim()}`).filter(Boolean)
    : [];
  const requiredSecrets = Array.isArray(repoContext?.environment_variables?.required_secrets)
    ? (repoContext.environment_variables?.required_secrets as unknown[]).map((item) => String(item || '')).filter(Boolean)
    : [];
  const buildCommand = String(repoContext?.build?.build_command || '').trim();
  const startCommand = String(repoContext?.build?.start_command || '').trim();
  const healthPath = String(repoContext?.health?.endpoint || '').trim();
  const detailLines = [
    runtime ? `Runtime: ${runtime}` : '',
    frameworks.length > 0 ? `Frameworks: ${frameworks.join(', ')}` : '',
    dataStores.length > 0 ? `Data stores: ${dataStores.join(', ')}` : '',
    buildCommand ? `Build command: ${buildCommand}` : '',
    startCommand ? `Start command: ${startCommand}` : '',
    healthPath ? `Health endpoint: ${healthPath}` : '',
    processes.length > 0 ? `Processes: ${processes.join(' | ')}` : '',
    requiredSecrets.length > 0 ? `Required secrets: ${requiredSecrets.join(', ')}` : '',
  ].filter(Boolean);
  if (detailLines.length > 0) {
    blocks.push(`Repository analysis details:\n${detailLines.join('\n')}`);
  }
  const markdown = String(repoContextMd || '').trim();
  if (markdown) {
    blocks.push(`Repository analysis markdown:\n${markdown}`);
  }
  if (review) {
    review.questions.forEach((question) => {
      const answer = String(answers[question.id] || '').trim();
      if (!answer) return;
      blocks.push(`Q: ${question.question}\nA: ${labelForAnswer(review, question.id, answer)}`);
    });
  }
  return blocks.join('\n\n').trim();
}

function parseBoolLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (['true', 'yes', 'y', '1', 'enabled'].includes(normalized)) return true;
  if (['false', 'no', 'n', '0', 'disabled'].includes(normalized)) return false;
  return null;
}

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

function normalizeSizeValue(value: unknown): 'small' | 'medium' | 'large' | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'small' || normalized === 'medium' || normalized === 'large') return normalized;
  return null;
}

function normalizeRepoDetectionSummaryText(value: string | null | undefined): string {
  const summary = String(value || '').trim();
  if (!summary) return '';
  return summary.replace(/^Compute strategy:\s*(.+)$/im, (_line: string, strategyText: string) => {
    const normalized = String(strategyText || '').trim().toLowerCase();
    if (['ecs', 'ecs_fargate', 'ec2', 'ec2_instance'].includes(normalized)) {
      return 'Compute strategy: ec2-instance';
    }
    return `Compute strategy: ${String(strategyText || '').trim() || 'unknown'}`;
  });
}

function findAnsweredValue(
  review: ArchitectureReviewPayload | null,
  answers: Record<string, string>,
  patterns: RegExp[],
): string {
  for (const question of review?.questions || []) {
    const haystack = `${question.id} ${question.category} ${question.question}`.toLowerCase();
    if (!patterns.some((pattern) => pattern.test(haystack))) continue;
    const candidate = String(answers[question.id] || '').trim();
    if (candidate) return candidate;
  }

  for (const [key, raw] of Object.entries(answers)) {
    const haystack = String(key || '').toLowerCase();
    if (!patterns.some((pattern) => pattern.test(haystack))) continue;
    const candidate = String(raw || '').trim();
    if (candidate) return candidate;
  }

  return '';
}

function buildInfraUserAnswers(params: {
  review: ArchitectureReviewPayload | null;
  answers: Record<string, string>;
  awsRegion: string;
  deploymentProfile: Record<string, unknown> | null;
  architectureView: Record<string, unknown> | null;
  repoContext: RepositoryContextJson | null;
}): Record<string, unknown> {
  const region = String(params.awsRegion || DEFAULT_AWS_REGION).trim() || DEFAULT_AWS_REGION;
  const deployment = (params.deploymentProfile || {}) as Record<string, unknown>;
  const architecture = (params.architectureView || {}) as Record<string, unknown>;
  const compute = (deployment.compute || architecture.compute || {}) as Record<string, unknown>;
  const computeStrategy = String(compute.strategy || '').trim().toLowerCase();
  const dataLayer = Array.isArray(deployment.data_layer)
    ? deployment.data_layer
    : Array.isArray(architecture.data_layer)
      ? architecture.data_layer
      : [];

  const hasDatabase = dataLayer.some((item) => {
    const type = String((item as Record<string, unknown>)?.type || '').trim().toLowerCase();
    return ['postgres', 'postgresql', 'mysql', 'mariadb', 'mongodb', 'dynamodb'].includes(type);
  });
  const hasRedis = dataLayer.some((item) => String((item as Record<string, unknown>)?.type || '').trim().toLowerCase() === 'redis');
  const staticFrontendPreferred = computeStrategy === 's3_cloudfront'
    || Boolean((params.repoContext?.frontend as Record<string, unknown> | undefined)?.static_site_candidate);

  const fromAnswers = params.answers || {};
  const needsStaging = parseBoolLike(findAnsweredValue(params.review, fromAnswers, [/staging/i]));
  const peakConcurrentUsers = parsePositiveInt(findAnsweredValue(params.review, fromAnswers, [/concurrent/i, /peak.*users?/i, /traffic/i]));
  const needsCloudfront = parseBoolLike(findAnsweredValue(params.review, fromAnswers, [/cloudfront/i, /cdn/i]));
  const needsWaf = parseBoolLike(findAnsweredValue(params.review, fromAnswers, [/\bwaf\b/i]));
  const databaseSize = normalizeSizeValue(findAnsweredValue(params.review, fromAnswers, [/database.*size/i, /db.*size/i, /database.*tier/i]));
  const needReadReplicas = parseBoolLike(findAnsweredValue(params.review, fromAnswers, [/read.*replica/i, /replica/i]));
  const multiAz = parseBoolLike(findAnsweredValue(params.review, fromAnswers, [/multi[\s-]?az/i, /high availability/i]));
  const maxConcurrentWorkerTasks = parsePositiveInt(findAnsweredValue(params.review, fromAnswers, [/worker.*tasks?/i, /worker.*concurrent/i]));
  const redisNodeSize = normalizeSizeValue(findAnsweredValue(params.review, fromAnswers, [/redis.*size/i, /cache.*size/i]));
  const staticAssetsCloudfront = parseBoolLike(findAnsweredValue(params.review, fromAnswers, [/static.*assets?/i, /s3.*cloudfront/i]));

  const normalizedRawAnswers: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fromAnswers)) {
    const normalized = String(value || '').trim();
    if (normalized) normalizedRawAnswers[key] = normalized;
  }

  return {
    ...normalizedRawAnswers,
    regions: [region],
    aws_region: region,
    needs_staging: needsStaging ?? false,
    peak_concurrent_users: peakConcurrentUsers ?? 200,
    needs_cloudfront_cdn: needsCloudfront ?? staticFrontendPreferred,
    needs_waf: needsWaf ?? false,
    database_size: databaseSize ?? (hasDatabase ? 'small' : 'small'),
    need_read_replicas: needReadReplicas ?? false,
    multi_az: multiAz ?? false,
    max_concurrent_worker_tasks: maxConcurrentWorkerTasks ?? 2,
    redis_node_size: redisNodeSize ?? (hasRedis ? 'small' : 'small'),
    static_assets_s3_cloudfront: staticAssetsCloudfront ?? staticFrontendPreferred,
  };
}

function buildConsultantArchitectureSeed(params: {
  workspace: string;
  projectName: string;
  awsRegion: string;
  repoContext: RepositoryContextJson | null;
  userAnswers: Record<string, unknown>;
}): Record<string, unknown> {
  const region = String(params.awsRegion || DEFAULT_AWS_REGION).trim() || DEFAULT_AWS_REGION;
  const runtime = String(params.repoContext?.language?.runtime || 'unknown').trim() || 'unknown';
  const staticSitePreferred = Boolean(params.userAnswers.static_assets_s3_cloudfront);
  const environment = Boolean(params.userAnswers.needs_staging) ? 'staging' : 'prod';

  return {
    document_kind: 'deployment_profile',
    profile_version: 'consultant_seed_v1',
    generated_at: new Date().toISOString(),
    workspace: String(params.workspace || 'deploy-workspace').trim() || 'deploy-workspace',
    project_name: String(params.projectName || 'project').trim() || 'project',
    provider: 'aws',
    application_type: runtime,
    environment,
    compute: {
      strategy: staticSitePreferred ? 's3_cloudfront' : 'ec2',
      services: [
        {
          id: 'app',
          process_type: 'web',
          image_source: null,
          cpu: staticSitePreferred ? null : 512,
          memory: staticSitePreferred ? null : 1024,
          port: staticSitePreferred ? null : 3000,
          desired_count: staticSitePreferred ? 0 : 1,
          autoscaling: staticSitePreferred ? {} : {
            min_count: 1,
            max_count: 2,
            target_cpu_utilization: 60,
          },
          command: null,
        },
      ],
    },
    networking: {
      vpc: 'new',
      layout: 'private_subnets',
      nat_gateway: !staticSitePreferred,
      load_balancer: { public: !staticSitePreferred },
      ports_exposed: staticSitePreferred ? [] : [3000],
    },
    runtime_config: {
      required_secrets: [],
      config_values: ['AWS_REGION'],
      secrets_manager_prefix: `/${String(params.projectName || 'project').trim() || 'project'}/${environment}`,
    },
    data_layer: [],
    warnings: [
      `Generated consultant seed profile for ${runtime} in ${region}.`,
    ],
  };
}

function summarizePlanResources(planSummary: Record<string, unknown> | null): string {
  if (!planSummary || typeof planSummary !== 'object') return 'Plan summary is available and awaiting confirmation.';
  const totals = (planSummary.total_resources || {}) as Record<string, unknown>;
  const add = Number(totals.add || 0);
  const change = Number(totals.change || 0);
  const destroy = Number(totals.destroy || 0);
  return `Plan summary: add=${add}, change=${change}, destroy=${destroy}.`;
}

function summarizeInfraConsultantDecision(decision: InfraConsultantDecision | null | undefined): string {
  if (!decision) return '';
  const components = Array.isArray(decision.components)
    ? decision.components.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const sequence = Array.isArray(decision.deploy_sequence)
    ? decision.deploy_sequence.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const outputs = Array.isArray(decision.outputs_to_capture)
    ? decision.outputs_to_capture.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const notes = Array.isArray(decision.consultant_notes)
    ? decision.consultant_notes.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const ec2 = ec2ResourceConfigFromDecision(decision);

  const lines: string[] = [];
  if (components.length > 0) lines.push(`Components: ${components.join(', ')}`);
  if (sequence.length > 0) lines.push(`Deploy sequence: ${sequence.join(' -> ')}`);
  if (components.includes('ec2') || components.includes('ec2-instance')) {
    lines.push(`EC2: ${ec2.instance_type}, root=${ec2.root_volume_size_gb}GB, app_port=${ec2.app_port}, ssh_cidrs=${ec2.ssh_ingress_cidr_blocks.length ? ec2.ssh_ingress_cidr_blocks.join(', ') : 'none'}`);
  }
  if (components.includes('alb') || decision.need_alb) {
    lines.push('ALB: enabled');
  }
  if (components.includes('eip') || decision.need_eip) {
    lines.push('Elastic IP: enabled');
  }
  if (outputs.length > 0) lines.push(`Outputs to capture: ${outputs.join(', ')}`);
  if (notes.length > 0) lines.push(`Notes: ${notes.join(' | ')}`);
  return lines.join('\n');
}

function canonicalDecisionComponent(value: unknown): string {
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
    const normalized = canonicalDecisionComponent(value);
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

function inferDeploymentPlanFromDecision(decision: InfraConsultantDecision | null | undefined): DeploymentPlanId {
  const components = normalizeDecisionComponents(decision);
  if (components.includes('s3_cloudfront')) return 's3_cloudfront';
  if (components.includes('ecs')) return 'ecs_fargate';
  return 'ec2';
}

function inferServicesFromDecision(decision: InfraConsultantDecision | null | undefined): DeploymentServiceSelection {
  const components = normalizeDecisionComponents(decision);
  return {
    rds: components.includes('rds'),
    redis: components.includes('elasticache') || components.includes('redis'),
  };
}

function plainServiceDecisionLabel(planId: DeploymentPlanId): { label: string; hint: string } {
  if (planId === 's3_cloudfront') {
    return { label: 'Static website', hint: 'Files served from cloud storage + CDN' };
  }
  if (planId === 'ecs_fargate') {
    return { label: 'Container app', hint: 'Runs in managed containers behind a traffic distributor' };
  }
  return { label: 'App server', hint: 'Runs your app on a virtual machine' };
}

function normalizeDecisionSequence(decision: InfraConsultantDecision | null | undefined): string[] {
  if (!decision) return [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (value: unknown) => {
    const normalized = canonicalDecisionComponent(value);
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

function formatComponentName(component: string): string {
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

function decisionCategory(component: string): DecisionDiagramNode['category'] {
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

function decisionColor(category: DecisionDiagramNode['category']): string {
  if (category === 'networking') return '#93c5fd';
  if (category === 'compute') return '#fdba74';
  if (category === 'data') return '#86efac';
  if (category === 'security') return '#fca5a5';
  return '#d4d4d8';
}

function componentDetails(component: string, stackConfig: Record<string, unknown>): string[] {
  const config = toRecord(stackConfig[component] || (component === 'ec2' ? stackConfig['ec2-instance'] : undefined));
  const key = String(component || '').toLowerCase();

  if (key === 'ecs' || key === 'ec2') {
    const parts: string[] = [];
    const instanceType = String(config.instance_type || '').trim();
    const appPort = toPositiveNumber(config.app_port);
    const desired = toPositiveNumber(config.desired_count);
    if (instanceType) parts.push(instanceType);
    if (appPort) parts.push(`:${appPort}`);
    if (desired && desired > 1) parts.push(`×${desired}`);
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
    return ['HTTP · HTTPS'];
  }

  if (key === 'eip') {
    return ['Static public IP'];
  }

  if (key === 's3_cloudfront' || key === 'cloudfront') {
    return ['CDN'];
  }

  // Skip dumping raw stack_config key=value noise onto the diagram.
  return [];
}

function getDecisionNodeHeight(node: DecisionDiagramNode): number {
  return 44 + Math.min(2, node.details.length) * 14;
}

function isBoundaryOnlyComponent(component: string): boolean {
  const key = String(component || '').toLowerCase();
  return key === 'vpc' || key === 'subnet' || key === 'public_subnet' || key === 'private_subnet';
}

function isPrivatePlacement(component: string): boolean {
  const key = String(component || '').toLowerCase();
  return key.includes('rds') || key.includes('redis') || key.includes('elasticache') || key.includes('db');
}

function buildMeaningfulEdges(components: string[], entryNodeByComponent: Map<string, string>): DecisionDiagramEdge[] {
  const edges: DecisionDiagramEdge[] = [];
  const id = (component: string) => entryNodeByComponent.get(component) || '';
  const has = (component: string) => Boolean(id(component));
  const push = (from: string, to: string, label = '') => {
    if (!from || !to || from === to) return;
    if (edges.some((item) => item.from === from && item.to === to)) return;
    edges.push({ from, to, label });
  };

  const frontDoor = has('alb') ? 'alb' : has('eip') ? 'eip' : has('ec2') ? 'ec2' : has('ecs') ? 'ecs' : components[0] || '';
  if (frontDoor) push('internet', id(frontDoor));

  if (has('alb') && has('ec2')) push(id('alb'), id('ec2'));
  if (has('alb') && has('ecs')) push(id('alb'), id('ecs'));
  if (!has('alb') && has('eip') && has('ec2')) push(id('eip'), id('ec2'));
  if (!has('alb') && has('eip') && has('ecs')) push(id('eip'), id('ecs'));
  if (has('ec2') && has('rds')) push(id('ec2'), id('rds'));
  if (has('ecs') && has('rds')) push(id('ecs'), id('rds'));
  if (has('ec2') && (has('elasticache') || has('redis'))) {
    push(id('ec2'), id('elasticache') || id('redis'));
  }
  if (has('ecs') && (has('elasticache') || has('redis'))) {
    push(id('ecs'), id('elasticache') || id('redis'));
  }

  if (edges.length <= 1) {
    const chain = components.map((component) => id(component)).filter(Boolean);
    if (chain[0]) push('internet', chain[0]);
    for (let index = 1; index < chain.length; index += 1) {
      push(chain[index - 1], chain[index]);
    }
  }

  return edges;
}

function humanizeConsultantNotes(notes: string[]): string[] {
  const skip = [
    /heuristic planner/i,
    /merged repository detection/i,
    /operator selected/i,
    /chat intakes/i,
    /production-safe/i,
  ];
  const cleaned = notes
    .map((note) => String(note || '').trim())
    .filter(Boolean)
    .filter((note) => !skip.some((pattern) => pattern.test(note)))
    .map((note) => note
      .replace(/^ALB enabled from operator request, HA, or traffic threshold\.?/i, 'ALB included for traffic distribution.')
      .replace(/^Elastic IP enabled for a stable public front door\.?/i, 'Elastic IP for a stable public address.')
      .replace(/^Peak concurrent\/traffic intake:\s*/i, 'Peak traffic sized for ')
      .replace(/^Both ALB and EIP were requested, ALB remains the primary HTTP front door\.?/i, 'ALB is the HTTP front door; EIP stays attached for a stable address.')
      .trim())
    .filter(Boolean);

  const unique: string[] = [];
  for (const note of cleaned) {
    if (unique.some((item) => item.toLowerCase() === note.toLowerCase())) continue;
    unique.push(note);
  }
  return unique.slice(0, 3);
}

function buildDecisionArchitectureDiagram(
  decision: InfraConsultantDecision | null | undefined,
  awsRegion: string,
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
    return 3;
  };
  const publicComponents = visibleComponents
    .filter((component) => !isPrivatePlacement(component))
    .sort((left, right) => publicRank(left) - publicRank(right));
  const privateComponents = visibleComponents.filter((component) => isPrivatePlacement(component));

  const nodes: DecisionDiagramNode[] = [];
  const entryNodeByComponent = new Map<string, string>();
  const pushNode = (node: DecisionDiagramNode) => {
    if (!nodes.some((item) => item.id === node.id)) nodes.push(node);
  };

  pushNode({
    id: 'internet',
    label: 'Internet',
    x: 48,
    y: publicComponents.length > 0 ? 158 : 210,
    color: '#a1a1aa',
    category: 'networking',
    details: [],
  });

  const placeRow = (items: string[], startY: number) => {
    const columnWidth = 176;
    let column = 0;
    for (const component of items) {
      const category = decisionCategory(component);
      const color = decisionColor(category);
      const label = formatComponentName(component);
      const details = componentDetails(component, stackConfig);
      const x = 250 + column * columnWidth;
      const y = startY;

      if (component === 'rds' && hasMultiAz) {
        const primaryId = 'rds-primary';
        const replicaId = 'rds-replica';
        pushNode({ id: primaryId, label: 'RDS Primary', x, y, color, category, details });
        pushNode({
          id: replicaId,
          label: 'RDS Standby',
          x: x + columnWidth,
          y,
          color,
          category,
          details: ['failover'],
        });
        entryNodeByComponent.set(component, primaryId);
        column += 2;
        continue;
      }

      // Skip aliases that already have a placed node (e.g. redis after elasticache).
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
        details,
      });
      entryNodeByComponent.set(component, nodeId);
      column += 1;
    }
  };

  placeRow(publicComponents, 150);
  placeRow(privateComponents, 340);

  const edges = buildMeaningfulEdges(visibleComponents, entryNodeByComponent);
  if (hasMultiAz && entryNodeByComponent.get('rds') === 'rds-primary') {
    edges.push({ from: 'rds-primary', to: 'rds-replica', label: '' });
  }

  return {
    awsRegion: String(awsRegion || DEFAULT_AWS_REGION).trim() || DEFAULT_AWS_REGION,
    components: visibleComponents.length > 0 ? visibleComponents : orderedComponents,
    nodes,
    edges,
    hasVpcBoundary,
    hasMultiAz,
    hasPrivateTier: privateComponents.length > 0,
  };
}

export default function DeploymentTrackApp() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const customizationSnapshotId = (searchParams.get('customizationSnapshotId') || '').trim();
  const customizationTenantId = (searchParams.get('tenantId') || '').trim();
  const logEndRef = useRef<HTMLDivElement>(null);
  const pipelineSocketRef = useRef<WebSocket | null>(null);
  const pipelineSocketRetryRef = useRef<number | null>(null);
  const pipelineSocketAttemptRef = useRef(0);
  const socketNoticeKeysRef = useRef<Set<string>>(new Set());
  const deployRequestRef = useRef<string | null>(null);
  const idleRecoveryRef = useRef<string | null>(null);
  const analysisRequestRef = useRef<string | null>(null);
  const reviewRequestRef = useRef<string | null>(null);
  const terraformAutostartRef = useRef<string | null>(null);
  const decisionCostRequestKeyRef = useRef<string | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [activeStage, setActiveStage] = useState<PipelineStageId>('analysis');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [repoContext, setRepoContext] = useState<RepositoryContextJson | null>(() => readStoredJson<RepositoryContextJson>('deplai.pipeline.repoContext'));
  const [repoContextMd, setRepoContextMd] = useState<string>(() => readStoredJson<string>(REPO_CONTEXT_MD_KEY) || '');
  const [review, setReview] = useState<ArchitectureReviewPayload | null>(() => readStoredJson<ArchitectureReviewPayload>(REVIEW_PAYLOAD_KEY));
  const [answers, setAnswers] = useState<Record<string, string>>(() => readStoredJson<Record<string, string>>(REVIEW_ANSWERS_KEY) || {});
  const [deploymentProfile, setDeploymentProfile] = useState<Record<string, unknown> | null>(() => readStoredJson<Record<string, unknown>>(DEPLOYMENT_PROFILE_KEY));
  const [architectureView, setArchitectureView] = useState<Record<string, unknown> | null>(() => readStoredJson<Record<string, unknown>>(ARCHITECTURE_VIEW_KEY));
  const [approvalPayload, setApprovalPayload] = useState<ApprovalPayload | null>(() => readStoredJson<ApprovalPayload>(APPROVAL_PAYLOAD_KEY));
  const [infraConsultant, setInfraConsultant] = useState<InfraConsultantState | null>(() => readStoredJson<InfraConsultantState>(INFRA_CONSULTANT_KEY));
  const [approvedDecisionState, setApprovedDecisionState] = useState<ApprovedDecisionState | null>(() => readStoredJson<ApprovedDecisionState>(APPROVED_DECISION_KEY));
  const [decisionCostEstimate, setDecisionCostEstimate] = useState<DecisionCostEstimate | null>(() => readStoredJson<DecisionCostEstimate>(DECISION_COST_ESTIMATE_KEY));
  const [currentDecisionHash, setCurrentDecisionHash] = useState<string>('');
  const [decisionCostLoading, setDecisionCostLoading] = useState(false);
  const [decisionCostError, setDecisionCostError] = useState<string | null>(null);
  const [infraConsultantInput, setInfraConsultantInput] = useState('');
  const [infraConsultantLoading, setInfraConsultantLoading] = useState(false);
  const [deploymentPlan, setDeploymentPlan] = useState<DeploymentPlanId>(() => normalizeDeploymentPlanId(readStoredJson<string>(DEPLOYMENT_PLAN_KEY)));
  const [deploymentServices, setDeploymentServices] = useState<DeploymentServiceSelection>(() => readDeploymentServices());
  const [ec2ResourceConfig, setEc2ResourceConfig] = useState<Ec2ResourceConfig>(() => readEc2ResourceConfig());
  const [rdsResourceConfig, setRdsResourceConfig] = useState<RdsResourceConfig>(() => readRdsResourceConfig());
  const [redisResourceConfig, setRedisResourceConfig] = useState<RedisResourceConfig>(() => readRedisResourceConfig());
  const [ecsResourceConfig, setEcsResourceConfig] = useState<EcsResourceConfig>(() => readEcsResourceConfig());
  const [staticSiteResourceConfig, setStaticSiteResourceConfig] = useState<StaticSiteResourceConfig>(() => readStaticSiteResourceConfig());
  const [iacFiles, setIacFiles] = useState<GeneratedIacFile[]>(() => readIacFilesFromSession());
  const [selectedFile, setSelectedFile] = useState<string>(() => readIacFilesFromSession()[0]?.path || '');
  const [iacPrUrl, setIacPrUrl] = useState<string | null>(null);
  const [iacPrCreating, setIacPrCreating] = useState(false);
  const [appSecretsMeta, setAppSecretsMeta] = useState<AppSecretMeta[]>([]);
  const [terraformGenerating, setTerraformGenerating] = useState(false);
  const [aws, setAws] = useState<AwsSessionConfig>(() => readSavedAws());
  const [terraformRuntimeConfig, setTerraformRuntimeConfig] = useState<TerraformRuntimeConfig>(() => ({
    aws_region: DEFAULT_AWS_REGION,
    state_bucket: '',
    lock_table: '',
  }));
  const [terraformRuntimeConfigWasStored, setTerraformRuntimeConfigWasStored] = useState(false);
  const [deployStatus, setDeployStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [deployProgress, setDeployProgress] = useState(0);
  const [deployLogs, setDeployLogs] = useState<DeployLogEntry[]>([]);
  const [deployResult, setDeployResult] = useState<DeployApiResult | null>(null);
  const [requiresPlanConfirmation, setRequiresPlanConfirmation] = useState(false);
  const [pendingPlanSummary, setPendingPlanSummary] = useState<Record<string, unknown> | null>(null);
  const [deploymentHistory, setDeploymentHistory] = useState<DeployStateSnapshot['deploymentHistory']>([]);
  const [deploySocketState, setDeploySocketState] = useState<PipelineSocketState>('idle');
  const [socketNotices, setSocketNotices] = useState<SocketNotice[]>([]);
  /** Local UI phase so the Deploy panel always shows feedback even if shared deploy state lags. */
  const [deployUiPhase, setDeployUiPhase] = useState<
    'idle' | 'starting' | 'waiting_api' | 'awaiting_plan' | 'reconciling' | 'done' | 'error'
  >('idle');
  const [deployElapsedSec, setDeployElapsedSec] = useState(0);
  const deployStartedAtRef = useRef<number | null>(null);
  const deployHeartbeatRef = useRef<number | null>(null);
  const [stopLoading, setStopLoading] = useState(false);
  const [destroyLoading, setDestroyLoading] = useState(false);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [budgetOverride, setBudgetOverride] = useState(false);
  const [endpointChecks, setEndpointChecks] = useState<EndpointVerificationCheck[]>([]);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProject = useMemo(() => projects.find((project) => project.id === selectedProjectId) || null, [projects, selectedProjectId]);
  const expectedWorkspace = useMemo(() => (
    selectedProject ? buildDeploymentWorkspace(selectedProject.id, selectedProject.name) : ''
  ), [selectedProject]);
  const currentInfraConsultant = useMemo(
    () => (infraConsultant && infraConsultant.workspace === expectedWorkspace ? infraConsultant : null),
    [expectedWorkspace, infraConsultant],
  );
  const approvedConsultantDecision = useMemo(
    () => (approvedDecisionState && approvedDecisionState.workspace === expectedWorkspace ? approvedDecisionState.decision : null),
    [approvedDecisionState, expectedWorkspace],
  );
  const decisionForVisualization = useMemo(
    () => approvedConsultantDecision || currentInfraConsultant?.decision || null,
    [approvedConsultantDecision, currentInfraConsultant?.decision],
  );
  const selectedDeploymentPlanOption = useMemo(
    () => DEPLOYMENT_PLAN_OPTIONS.find((option) => option.id === deploymentPlan) || DEPLOYMENT_PLAN_OPTIONS[0],
    [deploymentPlan],
  );
  const selectedDeploymentComponents = useMemo(
    () => deploymentPlanComponents(deploymentPlan, deploymentServices),
    [deploymentPlan, deploymentServices],
  );
  const deploymentResourceConfigs = useMemo<DeploymentResourceConfigs>(
    () => ({
      ec2: ec2ResourceConfig,
      rds: rdsResourceConfig,
      redis: redisResourceConfig,
      ecs: ecsResourceConfig,
      staticSite: staticSiteResourceConfig,
    }),
    [ec2ResourceConfig, rdsResourceConfig, redisResourceConfig, ecsResourceConfig, staticSiteResourceConfig],
  );
  const deploymentSelectionDecision = useMemo(
    () => applyDeploymentSelectionToDecision(
      currentInfraConsultant?.decision,
      deploymentPlan,
      deploymentServices,
      deploymentResourceConfigs,
      terraformRuntimeConfig.aws_region,
    ),
    [currentInfraConsultant?.decision, deploymentPlan, deploymentServices, deploymentResourceConfigs, terraformRuntimeConfig.aws_region],
  );
  const deploymentSelectionSummary = useMemo(
    () => summarizeInfraConsultantDecision(deploymentSelectionDecision),
    [deploymentSelectionDecision],
  );
  const decisionDiagram = useMemo(
    () => buildDecisionArchitectureDiagram(decisionForVisualization, terraformRuntimeConfig.aws_region),
    [decisionForVisualization, terraformRuntimeConfig.aws_region],
  );
  const consultantNotesList = useMemo(
    () => humanizeConsultantNotes(
      Array.isArray(decisionForVisualization?.consultant_notes)
        ? decisionForVisualization.consultant_notes.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
    ),
    [decisionForVisualization?.consultant_notes],
  );
  const decisionSignature = useMemo(
    () => (decisionForVisualization ? JSON.stringify(decisionForVisualization) : ''),
    [decisionForVisualization],
  );

  useEffect(() => {
    let cancelled = false;
    if (!decisionForVisualization) {
      setCurrentDecisionHash('');
      return;
    }
    void hashDecisionAsync(decisionForVisualization as unknown as Record<string, unknown>)
      .then((hash) => {
        if (!cancelled) setCurrentDecisionHash(hash);
      })
      .catch(() => {
        if (!cancelled) setCurrentDecisionHash('');
      });
    return () => {
      cancelled = true;
    };
  }, [decisionForVisualization, decisionSignature]);

  const costEstimateIsFresh = Boolean(
    decisionCostEstimate?.success
    && decisionCostEstimate.decision_hash
    && currentDecisionHash
    && decisionCostEstimate.decision_hash === currentDecisionHash,
  );
  const hasApprovedDecisionForCost = Boolean(approvedConsultantDecision || currentInfraConsultant?.confirmed);
  const consultantDecisionSummary = useMemo(
    () => deploymentSelectionSummary || String(currentInfraConsultant?.summary || '').trim() || summarizeInfraConsultantDecision(currentInfraConsultant?.decision),
    [currentInfraConsultant?.decision, currentInfraConsultant?.summary, deploymentSelectionSummary],
  );
  const reviewQuestions = useMemo(() => review?.questions || [], [review]);
  const requiredQuestions = useMemo(
    () => reviewQuestions.filter((question) => question.required !== false),
    [reviewQuestions],
  );
  const answeredRequiredCount = useMemo(
    () => requiredQuestions.filter((question) => String(answers[question.id] || '').trim()).length,
    [answers, requiredQuestions],
  );
  const answeredQuestionCount = useMemo(
    () => reviewQuestions.filter((question) => String(answers[question.id] || '').trim()).length,
    [answers, reviewQuestions],
  );
  const allQuestionsAnswered = Boolean(
    review && requiredQuestions.every((question) => String(answers[question.id] || '').trim()),
  );
  const nextRequiredQuestion = useMemo(
    () => requiredQuestions.find((question) => !String(answers[question.id] || '').trim()) || null,
    [answers, requiredQuestions],
  );
  const optionalQuestionCount = Math.max(reviewQuestions.length - requiredQuestions.length, 0);
  const groupedQuestions = useMemo(() => {
    const groups = new Map<string, typeof reviewQuestions>();
    reviewQuestions.forEach((question) => {
      const key = formatQuestionCategory(question.category);
      groups.set(key, [...(groups.get(key) || []), question]);
    });
    return Array.from(groups.entries());
  }, [reviewQuestions]);
  const reviewCompletionPercent = useMemo(() => {
    if (requiredQuestions.length === 0) return 0;
    return Math.round((answeredRequiredCount / requiredQuestions.length) * 100);
  }, [answeredRequiredCount, requiredQuestions.length]);
  const needsSessionToken = aws.aws_access_key_id.trim().toUpperCase().startsWith('ASIA');
  const hasSessionTokenWhenRequired = !needsSessionToken || Boolean(aws.aws_session_token.trim());
  const hasAwsSecrets = Boolean(
    aws.aws_access_key_id.trim()
    && aws.aws_secret_access_key.trim()
    && hasSessionTokenWhenRequired,
  );
  const costEstimate = readCostEstimate();
  const effectiveCostTotal = Number(
    decisionCostEstimate?.subtotal_monthly_usd
    || currentInfraConsultant?.advisor_cost_estimate?.subtotal_monthly_usd
    || costEstimate.total
    || 0,
  );
  const effectiveBudgetCap = Number(
    currentInfraConsultant?.budget_cap_usd
    || costEstimate.cap
    || 100,
  );
  const patchState = useCallback((patch: Partial<ActiveDeployState> | ((prev: ActiveDeployState) => ActiveDeployState)) => {
    if (!selectedProjectId) return;
    patchActiveDeploymentState(selectedProjectId, patch);
  }, [selectedProjectId]);
  const persistInfraConsultant = useCallback((next: InfraConsultantState | null) => {
    setInfraConsultant(next);
    if (next) {
      writeStoredJson(INFRA_CONSULTANT_KEY, next);
    } else if (typeof window !== 'undefined') {
      sessionStorage.removeItem(INFRA_CONSULTANT_KEY);
    }
  }, []);
  const persistApprovedDecision = useCallback((next: ApprovedDecisionState | null) => {
    setApprovedDecisionState(next);
    if (next) {
      writeStoredJson(APPROVED_DECISION_KEY, next);
    } else if (typeof window !== 'undefined') {
      sessionStorage.removeItem(APPROVED_DECISION_KEY);
    }
  }, []);
  const appendLog = useCallback((
    text: string,
    type: 'info' | 'success' | 'error' = 'info',
    meta?: Omit<DeployLogEntry, 'text' | 'ts' | 'type'>,
  ) => {
    patchState((prev) => {
      const last = prev.logs[prev.logs.length - 1];
      if (
        last &&
        last.text === text &&
        last.type === type &&
        last.worker_id === meta?.worker_id &&
        last.worker_status === meta?.worker_status
      ) {
        return prev;
      }
      return {
        ...prev,
        logs: [...prev.logs, { text, ts: timestampLabel(), type, ...meta }],
      };
    });
  }, [patchState]);
  const appendSocketNotice = useCallback((key: string, text: string, tone: 'info' | 'error' = 'info') => {
    if (!key || socketNoticeKeysRef.current.has(key)) return;
    socketNoticeKeysRef.current.add(key);
    setSocketNotices((prev) => [...prev, { key, text, ts: timestampLabel(), tone }].slice(-4));
  }, []);
  const updateIacFileContent = useCallback((filePath: string, nextContent: string) => {
    setIacFiles((prev) => {
      const nextFiles = prev.map((file) => (
        file.path === filePath
          ? { ...file, content: nextContent }
          : file
      ));
      writeStoredJson(IAC_FILES_KEY, nextFiles);
      return nextFiles;
    });
  }, []);
  const pushDeploymentHistory = useCallback((result: DeployApiResult | null, status: 'done' | 'error') => {
    if (!result) return;
    patchState((prev) => {
      const nextEntry = toHistoryEntry(result, status, terraformRuntimeConfig.aws_region);
      const previous = prev.deploymentHistory[0];
      if (
        previous &&
        previous.status === nextEntry.status &&
        previous.instanceId === nextEntry.instanceId &&
        previous.cloudfrontUrl === nextEntry.cloudfrontUrl
      ) {
        return prev;
      }
      return {
        ...prev,
        deploymentHistory: [nextEntry, ...prev.deploymentHistory].slice(0, DEPLOY_HISTORY_MAX),
      };
    });
  }, [patchState, terraformRuntimeConfig.aws_region]);
  const mergeRuntimeDetailsIntoResult = useCallback((details: AwsRuntimeLiveDetails) => {
    patchState((prev) => ({
      ...prev,
      deployResult: mergeDeployResultWithRuntimeDetails(prev.deployResult, details),
    }));
  }, [patchState]);
  const deploySummary = useMemo(() => extractDeploymentSummary(deployResult), [deployResult]);
  const liveRuntimeDetails = useMemo(() => extractLiveRuntimeDetails(deployResult), [deployResult]);
  const iacResourceOutputs = useMemo<IacResourceOutputs | null>(() => {
    if (deployResult?.mode !== 'iac_pipeline') return null;
    const outputs = deployResult?.outputs;
    if (!outputs || typeof outputs !== 'object') return null;
    const candidate = outputs as Partial<IacResourceOutputs>;
    if (!Array.isArray(candidate.outputs)) return null;
    return {
      service_type: String(candidate.service_type || deployResult.service_type || 'aws'),
      deployed_at: String(candidate.deployed_at || new Date().toISOString()),
      outputs: candidate.outputs as IacResourceOutputEntry[],
    };
  }, [deployResult?.mode, deployResult?.outputs, deployResult?.service_type]);
  const iacKeypair = useMemo<IacKeypair | null>(() => {
    const keypair = deployResult?.keypair;
    if (!keypair?.private_key_pem) return null;
    const name = String(keypair.key_name || deployResult?.ec2_key_name || '').trim();
    return {
      private_key_pem: keypair.private_key_pem,
      keypair_name: name || 'deplai-keypair',
    };
  }, [deployResult?.ec2_key_name, deployResult?.keypair]);
  const keyPairDownloadMessage = useMemo(() => {
    const details = deployResult?.details as Record<string, unknown> | null | undefined;
    const reusedKey = Boolean(details?.key_pair_reused);
    const existingKeyName = String(details?.existing_ec2_key_pair_name || deploySummary.keyName || '').trim();
    if (deploySummary.generatedPem) return '';
    if (reusedKey && existingKeyName) {
      return `This deploy reused existing EC2 key pair '${existingKeyName}'. No new private PEM was generated, so there is nothing to download. Use the original private key for SSH access.`;
    }
    return 'No generated private key is available in this deployment result.';
  }, [deployResult?.details, deploySummary.generatedPem, deploySummary.keyName]);
  const terraformWorkerStates = useMemo(() => {
    const latest = new Map<string, DeployLogEntry>();
    deployLogs.forEach((log) => {
      if (!log.worker_id) return;
      if (log.stage && log.stage !== 'terraform_generation') return;
      latest.set(log.worker_id, log);
    });
    return Array.from(latest.values());
  }, [deployLogs]);
  const terraformGenerationLogs = useMemo(
    () => deployLogs.filter((log) => log.stage === 'terraform_generation' || (!log.stage && Boolean(log.worker_id))),
    [deployLogs],
  );
  const hasLiveRuntimeDetails = useMemo(() => {
    if (deployResult?.mode === 'iac_pipeline') {
      return Boolean(iacResourceOutputs && iacResourceOutputs.outputs.length > 0);
    }
    return Boolean(liveRuntimeDetails && getLiveRuntimeInstanceId(deployResult) && getLiveRuntimeInstanceId(deployResult) !== 'n/a');
  }, [deployResult, liveRuntimeDetails, iacResourceOutputs]);
  const persistedEndpointChecks = useMemo(() => normalizeVerificationChecks(deployResult?.verification_checks), [deployResult?.verification_checks]);
  const effectiveEndpointChecks = endpointChecks.length > 0 ? endpointChecks : persistedEndpointChecks;
  const verificationFailed = useMemo(
    () => deployResult?.deployment_verified === false || (effectiveEndpointChecks.length > 0 && effectiveEndpointChecks.every((check) => !check.ok)),
    [deployResult?.deployment_verified, effectiveEndpointChecks],
  );
  const verificationPassed = useMemo(() => {
    if (effectiveEndpointChecks.length > 0) {
      return effectiveEndpointChecks.some((check) => check.ok);
    }
    return deployResult?.deployment_verified === true;
  }, [deployResult?.deployment_verified, effectiveEndpointChecks]);
  const backendErrorMessage = useMemo(() => {
    const direct = String(deployResult?.error || '').trim();
    if (direct) return direct;
    if (verificationFailed) {
      return 'Deployment verification failed or runtime data is incomplete.';
    }
    if (deployStatus === 'error') {
      return 'The backend reported a deployment error.';
    }
    return '';
  }, [deployResult?.error, deployStatus, verificationFailed]);
  const hasEndpointTargets = useMemo(
    () => [
      deploySummary.cloudfrontUrl,
      deploySummary.albDns,
      deploySummary.elasticIp,
      deploySummary.appUrl,
      deploySummary.publicIp,
    ].some((value) => value && value !== 'n/a'),
    [deploySummary.albDns, deploySummary.appUrl, deploySummary.cloudfrontUrl, deploySummary.elasticIp, deploySummary.publicIp],
  );
  const outputBanner = useMemo<OutputBannerState>(() => {
    if (deployStatus === 'running') {
      return {
        tone: 'warning',
        label: 'Deployment Running',
        title: 'Deployment In Progress',
        description: 'The backend runtime is still applying infrastructure. Outputs will hydrate when the current repo reaches a terminal state.',
      };
    }
    if (deployStatus === 'error' || backendErrorMessage) {
      return {
        tone: 'error',
        label: 'Error',
        title: 'Deployment Error',
        description: backendErrorMessage || 'The deployment did not complete successfully. Review the runtime error and verification details below.',
      };
    }
    if (!deployResult) {
      return {
        tone: 'warning',
        label: 'No Deployment Data',
        title: 'Infrastructure Outputs',
        description: 'No deployment snapshot is bound to this repo yet. Run deploy or reconcile backend status to hydrate outputs.',
      };
    }
    if (verificationFailed) {
      return {
        tone: 'error',
        label: 'Verification Failed',
        title: 'Infrastructure Outputs',
        description: 'The backend returned outputs, but verification failed or the runtime data is incomplete for this repo.',
      };
    }
    if (!deployResult.success) {
      return {
        tone: 'warning',
        label: 'Pending Runtime Confirmation',
        title: 'Infrastructure Outputs',
        description: 'The deploy track has a partial payload, but the backend has not confirmed a successful terminal runtime state yet.',
      };
    }
    if (!hasLiveRuntimeDetails) {
      return {
        tone: 'warning',
        label: 'Missing Runtime Data',
        title: 'Infrastructure Outputs',
        description: 'The deployment payload exists, but live runtime details are missing. Fetch runtime details before treating this deploy as healthy.',
      };
    }
    if (verificationPassed) {
      return {
        tone: 'success',
        label: 'Live',
        title: 'Infrastructure Outputs',
        description: 'The backend confirmed a successful terminal state and the current repo has live runtime data.',
      };
    }
    return {
      tone: 'warning',
      label: 'Pending Verification',
      title: 'Infrastructure Outputs',
      description: 'The backend confirmed infrastructure, but live endpoint verification has not been recorded for this repo yet.',
    };
  }, [backendErrorMessage, deployResult, deployStatus, hasLiveRuntimeDetails, verificationFailed, verificationPassed]);
  const savedRun = readSavedIacRun();
  const savedIacMeta = readSavedIacMeta();
  const activeSavedRun = useMemo(
    () => getCurrentSavedRun(savedRun, savedIacMeta, selectedProjectId, expectedWorkspace),
    [expectedWorkspace, savedIacMeta, savedRun, selectedProjectId],
  );
  const snapshotIacMatches = useMemo(() => {
    if (!customizationSnapshotId && !customizationTenantId) return true;
    const source = savedIacMeta?.source_metadata;
    return Boolean(
      source?.kind === 'customization_snapshot'
      && source.snapshot_id === customizationSnapshotId
      && source.tenant_id === customizationTenantId,
    );
  }, [customizationSnapshotId, customizationTenantId, savedIacMeta?.source_metadata]);
  const sessionIacTruncated = useMemo(() => hasTruncatedIacFiles(iacFiles), [iacFiles]);
  const deployableIacFiles = useMemo(() => getDeployableIacFiles(iacFiles), [iacFiles]);
  const shouldUseSavedRunForDeploy = Boolean(activeSavedRun?.run_id && snapshotIacMatches);
  const deployStartBlockers = useMemo(() => {
    const blockers: string[] = [];
    const confirmingPlan = requiresPlanConfirmation || deployUiPhase === 'awaiting_plan';
    if (deployStatus === 'running' && !confirmingPlan) {
      blockers.push('Deployment is already running. Stop it or wait for completion.');
    }
    if (!selectedProject) {
      blockers.push('Select a repository before starting deploy.');
    }
    if (!hasAwsSecrets) {
      blockers.push(
        needsSessionToken && !aws.aws_session_token.trim()
          ? 'Temporary ASIA credentials require AWS_SESSION_TOKEN in AWS Config.'
          : 'Add AWS credentials in AWS Config (access key + secret key).',
      );
    }
    // Plan already ran — keep snapshot soft for confirm, but still require a deployable bundle.
    if (!confirmingPlan && !snapshotIacMatches) {
      blockers.push('Regenerate infrastructure from the selected customization snapshot.');
    }
    if (deployableIacFiles.length === 0 && !shouldUseSavedRunForDeploy) {
      blockers.push(
        confirmingPlan
          ? 'Plan is ready, but the Terraform bundle is no longer in this session. Regenerate infrastructure, then Start Deploy again.'
          : 'Generate infrastructure after selecting a deployment target and managed services.',
      );
    }
    if (effectiveCostTotal > effectiveBudgetCap && !budgetOverride) {
      blockers.push('Estimated monthly cost exceeds the budget cap. Approve the budget override to deploy.');
    }
    return blockers;
  }, [
    aws.aws_session_token,
    budgetOverride,
    deployUiPhase,
    effectiveBudgetCap,
    effectiveCostTotal,
    deployStatus,
    deployableIacFiles.length,
    hasAwsSecrets,
    needsSessionToken,
    requiresPlanConfirmation,
    selectedProject,
    shouldUseSavedRunForDeploy,
    snapshotIacMatches,
  ]);
  const canStartDeploy = deployStartBlockers.length === 0;
  const deployIsLive = deployStatus === 'running'
    || deployUiPhase === 'starting'
    || deployUiPhase === 'waiting_api'
    || deployUiPhase === 'reconciling';
  // Only keep Confirm enabled while idle awaiting plan — never during an in-flight apply.
  const awaitingPlanIdle = (requiresPlanConfirmation || deployUiPhase === 'awaiting_plan') && !deployIsLive;
  const deployButtonDisabled = !canStartDeploy || deployIsLive;
  const deployPhaseLabel = (() => {
    if (deployUiPhase === 'starting') return 'Starting deploy…';
    if (deployUiPhase === 'waiting_api') return `Terraform apply in progress (${deployElapsedSec}s)`;
    if (deployUiPhase === 'reconciling') return `Reconciling backend status (${deployElapsedSec}s)`;
    if (deployUiPhase === 'awaiting_plan') return 'Plan ready — confirm to continue';
    if (deployUiPhase === 'error' || deployStatus === 'error') return 'Deploy failed';
    if (deployUiPhase === 'done' || deployStatus === 'done') return 'Deploy finished';
    if (deployStatus === 'running') return `Deploy running (${deployElapsedSec}s)`;
    if (awaitingPlanIdle) return 'Plan ready — confirm to continue';
    return 'Idle — click Start Deploy';
  })();
  const activeIacFilePath = selectedFile || iacFiles[0]?.path || '';
  const hasCurrentIacMeta = useMemo(
    () => matchesCurrentIacWorkspace(savedIacMeta, selectedProjectId, expectedWorkspace) && snapshotIacMatches,
    [expectedWorkspace, savedIacMeta, selectedProjectId, snapshotIacMatches],
  );
  const hasSuccessfulGeneration = useMemo(
    () => snapshotIacMatches && hasSuccessfulTerraformGeneration(selectedProjectId, expectedWorkspace, savedIacMeta, activeSavedRun, iacFiles),
    [activeSavedRun, expectedWorkspace, iacFiles, savedIacMeta, selectedProjectId, snapshotIacMatches],
  );
  const canContinueToTerraform = Boolean(
    approvedConsultantDecision
    || (currentInfraConsultant?.confirmed && currentInfraConsultant?.decision)
    || (decisionForVisualization && Number(decisionCostEstimate?.subtotal_monthly_usd || 0) > 0)
    || hasSuccessfulGeneration,
  );
  const terraformRendererSummary = useMemo(
    () => describeTerraformRenderer(hasCurrentIacMeta ? savedIacMeta : null),
    [hasCurrentIacMeta, savedIacMeta],
  );
  const terraformRunLabel = useMemo(() => {
    if (terraformGenerating) return 'Generation in progress';
    if (shouldUseSavedRunForDeploy) return 'Connected to saved run';
    if (hasSuccessfulGeneration) return 'Generated bundle ready';
    if (sessionIacTruncated) return 'Cached preview requires regeneration';
    if (iacFiles.length > 0) return 'Cached bundle pending refresh';
    return 'Awaiting generation';
  }, [hasSuccessfulGeneration, iacFiles.length, sessionIacTruncated, shouldUseSavedRunForDeploy, terraformGenerating]);
  const shouldConnectPipelineSocket = Boolean(
    selectedProject && (
      activeStage === 'terraform'
      || activeStage === 'deploy'
      || activeStage === 'outputs'
      || deployStatus === 'running'
      || terraformGenerating
    )
  );
  const canFetchRuntimeDetails = Boolean(selectedProject && hasAwsSecrets);
  const onIacPipelineComplete = useCallback((
    outputs: object,
    keypair?: object | null,
  ) => {
    patchState((prev) => {
      const nextResult: DeployApiResult = {
        ...((prev.deployResult || {}) as DeployApiResult),
        success: true,
        outputs: outputs as Record<string, unknown>,
      };
      const mappedKeypair = keypair as IacKeypair | null | undefined;
      if (mappedKeypair?.private_key_pem) {
        nextResult.keypair = {
          key_name: mappedKeypair.keypair_name,
          private_key_pem: mappedKeypair.private_key_pem,
        };
      }
      return {
        ...prev,
        status: 'done',
        progress: 100,
        deployResult: nextResult,
      };
    });
    setError(null);
  }, [patchState]);
  const onIacPipelineError = useCallback((message: string) => {
    setError(message);
    appendLog(message, 'error', { stage: 'iac_pipeline' });
    patchState((prev) => ({
      ...prev,
      status: 'error',
      progress: 100,
      deployResult: {
        ...((prev.deployResult || {}) as DeployApiResult),
        success: false,
        error: message,
      },
    }));
  }, [appendLog, patchState]);
  const handleIacDestroyed = useCallback(() => {
    appendLog('IaC pipeline destroy requested.', 'info', { stage: 'iac_pipeline' });
    patchState((prev) => ({
      ...prev,
      deployResult: prev.deployResult
        ? { ...prev.deployResult, outputs: undefined, status: 'destroyed' }
        : prev.deployResult,
    }));
  }, [appendLog, patchState]);
  const canVerifyLiveEndpoints = Boolean(
    selectedProject &&
    deployStatus !== 'running' &&
    deployResult?.success &&
    hasLiveRuntimeDetails &&
    hasEndpointTargets &&
    !backendErrorMessage,
  );
  const canContinueToAwsConfig = Boolean(approvedConsultantDecision || hasSuccessfulGeneration);
  const secretsManagerPrefix = useMemo(() => {
    const runtime = (deploymentProfile?.runtime_config || {}) as Record<string, unknown>;
    const fromProfile = String(runtime.secrets_manager_prefix || '').trim();
    if (fromProfile) return fromProfile.startsWith('/') ? fromProfile : `/${fromProfile}`;
    const slug = String(selectedProject?.name || 'deplai')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'deplai';
    const env = String((deploymentProfile as { environment?: string } | null)?.environment || 'prod').trim() || 'prod';
    return `/${slug}/${env}`;
  }, [deploymentProfile, selectedProject?.name]);
  const requiredAppSecretKeys = useMemo(() => {
    const keys = new Set<string>();
    const looksSensitive = (key: string) => {
      if (/^NEXT_PUBLIC_/i.test(key)) return false;
      return (
        /(_SECRET|_TOKEN|_PASSWORD|_PRIVATE_KEY|_API_KEY|_ACCESS_KEY|_CLIENT_SECRET)$/i.test(key)
        || /^(NEXTAUTH_SECRET|AUTH_SECRET|JWT_SECRET)$/i.test(key)
        || /^(GOOGLE|GITHUB|DISCORD|AZURE|APPLE)_CLIENT_(ID|SECRET)$/i.test(key)
      );
    };
    const fromRepo = repoContext?.environment_variables?.required_secrets;
    if (Array.isArray(fromRepo)) {
      for (const item of fromRepo) {
        const key = String(item || '').trim();
        // .env.example often lists every blank key as "required"; only gate true secrets.
        if (key && looksSensitive(key)) keys.add(key);
      }
    }
    const runtime = (deploymentProfile?.runtime_config || {}) as Record<string, unknown>;
    const fromProfile = runtime.required_secrets;
    if (Array.isArray(fromProfile)) {
      for (const item of fromProfile) {
        const key = String(item || '').trim();
        if (key && looksSensitive(key)) keys.add(key);
      }
    }
    const frameworks = Array.isArray(repoContext?.frameworks)
      ? repoContext.frameworks.map((item) => String((item as { name?: string })?.name || item || '').toLowerCase()).join(' ')
      : '';
    if (/nextauth|auth\.js|passport|oauth|supabase/.test(frameworks) || /google|github|oauth|nextauth/i.test(JSON.stringify(repoContext?.environment_variables || {}))) {
      for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'NEXTAUTH_SECRET']) {
        keys.add(key);
      }
    }
    return Array.from(keys).filter((key) => !['JWT_SECRET', 'AUTH_SECRET'].includes(key));
  }, [deploymentProfile, repoContext]);
  const oauthCallbackPaths = useMemo(() => {
    const paths = new Set<string>();
    const envKeys = JSON.stringify(repoContext?.environment_variables || {}).toLowerCase();
    if (envKeys.includes('nextauth') || envKeys.includes('auth')) {
      paths.add('/api/auth/callback/google');
      paths.add('/api/auth/callback/github');
    }
    if (envKeys.includes('google')) paths.add('/api/auth/callback/google');
    if (envKeys.includes('github')) paths.add('/api/auth/callback/github');
    return Array.from(paths);
  }, [repoContext]);
  const publicAppUrlForSecrets = useMemo(() => {
    if (deploySummary.appUrl && deploySummary.appUrl !== 'n/a') return deploySummary.appUrl;
    if (deploySummary.elasticIp && deploySummary.elasticIp !== 'n/a') return `http://${deploySummary.elasticIp}`;
    if (deploySummary.publicIp && deploySummary.publicIp !== 'n/a') return `http://${deploySummary.publicIp}`;
    return null;
  }, [deploySummary.appUrl, deploySummary.elasticIp, deploySummary.publicIp]);
  const qaSummary = useMemo(() => buildQaSummary(review, answers, repoContext, repoContextMd), [answers, repoContext, repoContextMd, review]);
  const infraUserAnswers = useMemo(() => {
    return {
      ...buildInfraUserAnswers({
        review,
        answers,
        awsRegion: terraformRuntimeConfig.aws_region,
        deploymentProfile,
        architectureView,
        repoContext,
      }),
      deployment_plan: deploymentPlan,
      service_type: deploymentPlanToServiceType(deploymentPlan),
      managed_services: deploymentServices,
      selected_components: selectedDeploymentComponents,
      static_assets_s3_cloudfront: deploymentPlan === 's3_cloudfront',
      needs_managed_database: deploymentServices.rds,
      needs_managed_cache: deploymentServices.redis,
      ec2_resource_config: ec2ResourceConfig,
      ec2: ec2ResourceConfig,
      instance_type: ec2ResourceConfig.instance_type,
      root_volume_size_gb: ec2ResourceConfig.root_volume_size_gb,
      app_port: ec2ResourceConfig.app_port,
      ssh_ingress_cidr_blocks: ec2ResourceConfig.ssh_ingress_cidr_blocks,
    };
  }, [answers, architectureView, deploymentPlan, deploymentServices, deploymentProfile, ec2ResourceConfig, repoContext, review, selectedDeploymentComponents, terraformRuntimeConfig.aws_region]);
  const consultantArchitectureSeed = useMemo(() => buildConsultantArchitectureSeed({
    workspace: expectedWorkspace,
    projectName: selectedProject?.name || selectedProjectId || 'project',
    awsRegion: terraformRuntimeConfig.aws_region,
    repoContext,
    userAnswers: infraUserAnswers,
  }), [expectedWorkspace, infraUserAnswers, repoContext, selectedProject?.name, selectedProjectId, terraformRuntimeConfig.aws_region]);
  const analysisFrameworkNames = useMemo(() => (
    Array.isArray(repoContext?.frameworks)
      ? repoContext.frameworks.map((item) => String(item.name || '')).filter(Boolean)
      : []
  ), [repoContext?.frameworks]);
  const analysisDataStoreNames = useMemo(() => (
    Array.isArray(repoContext?.data_stores)
      ? repoContext.data_stores.map((item) => String(item.type || '')).filter(Boolean)
      : []
  ), [repoContext?.data_stores]);
  const analysisProcessLines = useMemo(() => (
    Array.isArray(repoContext?.processes)
      ? repoContext.processes.map((item) => `${String(item.type || 'process')}: ${String(item.command || item.source || '').trim()}`).filter(Boolean)
      : []
  ), [repoContext?.processes]);
  const analysisSecretNames = useMemo(() => (
    Array.isArray(repoContext?.environment_variables?.required_secrets)
      ? (repoContext.environment_variables?.required_secrets as unknown[]).map((item) => String(item || '')).filter(Boolean)
      : []
  ), [repoContext?.environment_variables?.required_secrets]);
  const analysisConfigNames = useMemo(() => (
    Array.isArray(repoContext?.environment_variables?.config_values)
      ? (repoContext.environment_variables?.config_values as unknown[]).map((item) => String(item || '')).filter(Boolean)
      : []
  ), [repoContext?.environment_variables?.config_values]);
  const analysisFlagLines = useMemo(() => (
    [
      ...(Array.isArray(repoContext?.conflicts) ? repoContext.conflicts.map((item) => String(item.reason || '').trim()) : []),
      ...(Array.isArray(repoContext?.low_confidence_items) ? repoContext.low_confidence_items.map((item) => String(item.reason || '').trim()) : []),
    ].filter(Boolean)
  ), [repoContext?.conflicts, repoContext?.low_confidence_items]);
  const analysisInfraHints = useMemo(() => {
    const hints = (repoContext?.infrastructure_hints || {}) as Record<string, unknown>;
    const composeImages = Array.isArray(hints.compose_images)
      ? hints.compose_images.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    return {
      hasDockerfile: Boolean(hints.has_dockerfile || repoContext?.build?.has_dockerfile),
      hasCompose: Boolean(hints.existing_compose),
      hasKubernetes: Boolean(hints.kubernetes_manifests),
      hasHelm: Boolean(hints.helm_charts),
      isMonorepo: Boolean(hints.monorepo),
      isServerless: Boolean(hints.serverless_config),
      composeImages,
    };
  }, [repoContext?.build, repoContext?.infrastructure_hints]);
  const analysisFrameworkDetails = useMemo(() => {
    if (!Array.isArray(repoContext?.frameworks)) return [];
    const seen = new Set<string>();
    const items: Array<{ name: string; role: string }> = [];
    for (const raw of repoContext.frameworks) {
      const name = String(raw?.name || '').trim();
      if (!name) continue;
      const role = String(raw?.role || '').trim();
      const dedupeKey = `${name.toLowerCase()}::${role.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      items.push({ name, role });
    }
    return items;
  }, [repoContext?.frameworks]);
  const analysisDataStoreDetails = useMemo(() => {
    if (!Array.isArray(repoContext?.data_stores)) return [];
    const seen = new Set<string>();
    const items: Array<{ type: string; version: string }> = [];
    for (const raw of repoContext.data_stores) {
      const type = String(raw?.type || '').trim();
      if (!type) continue;
      const version = String(raw?.version || '').trim();
      const dedupeKey = `${type.toLowerCase()}::${version.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      items.push({ type, version });
    }
    return items;
  }, [repoContext?.data_stores]);
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [deployLogs]);

  useEffect(() => {
    writeSavedAws(aws);
  }, [aws]);

  useEffect(() => {
    if (!selectedProjectId) {
      setAppSecretsMeta([]);
      return;
    }
    setAppSecretsMeta(readAppSecretsMeta(selectedProjectId));
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) return;
    writeAppSecretsMeta(selectedProjectId, appSecretsMeta);
  }, [appSecretsMeta, selectedProjectId]);

  // Expire operator AWS credentials from sessionStorage when TTL elapses.
  useEffect(() => {
    const syncExpiry = () => {
      const hasCreds = Boolean(
        aws.aws_access_key_id.trim()
        || aws.aws_secret_access_key.trim()
        || aws.aws_session_token.trim(),
      );
      if (!hasCreds) return;
      if (awsOperatorCredRemainingMs(aws) > 0) return;
      clearSavedAws();
      setAws((prev) => ({
        ...prev,
        aws_access_key_id: '',
        aws_secret_access_key: '',
        aws_session_token: '',
      }));
    };
    syncExpiry();
    const timer = window.setInterval(syncExpiry, 30_000);
    return () => window.clearInterval(timer);
  }, [aws]);

  useEffect(() => {
    writeStoredJson(DEPLOYMENT_PLAN_KEY, deploymentPlan);
  }, [deploymentPlan]);

  useEffect(() => {
    writeStoredJson(DEPLOYMENT_SERVICES_KEY, deploymentServices);
  }, [deploymentServices]);

  useEffect(() => {
    clearObsoleteTerraformUiState();
  }, []);

  useEffect(() => {
    setIacPrUrl(null);
  }, [selectedProjectId]);

  useEffect(() => {
    if (deployStatus === 'running' && (deployUiPhase === 'idle' || deployUiPhase === 'done' || deployUiPhase === 'error')) {
      setDeployUiPhase('waiting_api');
    } else if (deployStatus === 'done') {
      setDeployUiPhase('done');
    } else if (deployStatus === 'error') {
      setDeployUiPhase('error');
    } else if (deployStatus === 'idle' && requiresPlanConfirmation) {
      setDeployUiPhase('awaiting_plan');
    }
  }, [deployStatus, deployUiPhase, requiresPlanConfirmation]);

  // Restore plan log lines when UI resumes in awaiting_plan with an empty console.
  useEffect(() => {
    if (!(requiresPlanConfirmation || deployUiPhase === 'awaiting_plan')) return;
    if (deployLogs.length > 0) return;
    const summary = pendingPlanSummary
      || ((deployResult?.plan_summary as Record<string, unknown> | null | undefined) || null);
    appendLog(summarizePlanResources(summary), 'info');
    appendLog('Terraform plan is ready. Click Confirm Plan & Deploy to continue apply.', 'info');
  }, [
    appendLog,
    deployLogs.length,
    deployResult?.plan_summary,
    deployUiPhase,
    pendingPlanSummary,
    requiresPlanConfirmation,
  ]);

  useEffect(() => () => {
    if (deployHeartbeatRef.current !== null) {
      window.clearInterval(deployHeartbeatRef.current);
      deployHeartbeatRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!selectedProjectId) return;
    writeStoredJson(REVIEW_ANSWERS_KEY, answers);
  }, [answers, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) return;
    const entry = getOrCreateActiveDeployment(selectedProjectId);
    const apply = (next: ActiveDeployState) => {
      setDeployStatus(next.status);
      setDeployProgress(next.progress);
      setDeployLogs(next.logs);
      setDeployResult(next.deployResult);
      const requiresConfirmation = Boolean(
        next.deployResult?.requires_plan_confirmation
        || String(next.deployResult?.status || '').trim().toLowerCase() === 'awaiting_plan_confirmation',
      );
      setRequiresPlanConfirmation(requiresConfirmation);
      setPendingPlanSummary((next.deployResult?.plan_summary as Record<string, unknown> | null | undefined) || null);
      setDeploymentHistory(next.deploymentHistory);
    };
    entry.listeners.add(apply);
    apply(entry.state);
    return () => {
      entry.listeners.delete(apply);
    };
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) return;
    writeStoredJson(QA_CONTEXT_KEY, {
      qa_summary: qaSummary,
      deployment_region: terraformRuntimeConfig.aws_region || DEFAULT_AWS_REGION,
    });
  }, [qaSummary, selectedProjectId, terraformRuntimeConfig.aws_region]);

  useEffect(() => {
    if (!selectedProjectId) return;
    writeSavedTerraformRuntimeConfig(selectedProjectId, terraformRuntimeConfig);
  }, [selectedProjectId, terraformRuntimeConfig]);

  useEffect(() => {
    if (!hasCurrentIacMeta || !hasSuccessfulGeneration || !terraformRendererSummary.warning) return;
    const warningKey = `renderer-warning:${selectedProjectId || 'none'}:${savedIacMeta?.generated_at || expectedWorkspace}`;
    if (socketNoticeKeysRef.current.has(warningKey)) return;
    appendLog(terraformRendererSummary.warning, 'info', { stage: 'terraform_generation' });
    appendSocketNotice(warningKey, terraformRendererSummary.warning, 'info');
  }, [
    appendLog,
    appendSocketNotice,
    expectedWorkspace,
    hasCurrentIacMeta,
    hasSuccessfulGeneration,
    savedIacMeta?.generated_at,
    selectedProjectId,
    terraformRendererSummary.warning,
  ]);

  useEffect(() => {
    fetch('/api/projects', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data: { projects?: ProjectRecord[] }) => {
        setProjects(Array.isArray(data.projects) ? data.projects : []);
        setProjectsLoaded(true);
      })
      .catch(() => {
        setProjects([]);
        setProjectsLoaded(true);
      });
  }, []);

  useEffect(() => {
    const queryProjectId = String(
      searchParams.get('projectId')
      || searchParams.get('project_id')
      || '',
    ).trim();
    const entry = searchParams.get('entry');
    const storedProjectId = String(
      localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY)
      || sessionStorage.getItem(PLANNING_PROJECT_KEY)
      || '',
    ).trim();
    const nextProjectId = queryProjectId
      || storedProjectId
      || (projects.length === 1 ? String(projects[0]?.id || '').trim() : '')
      || null;
    if (!nextProjectId) {
      idleRecoveryRef.current = null;
      decisionCostRequestKeyRef.current = null;
      socketNoticeKeysRef.current.clear();
      setSocketNotices([]);
      setSelectedProjectId(null);
      persistApprovedDecision(null);
      setDecisionCostEstimate(null);
      setDecisionCostError(null);
      setTerraformRuntimeConfigWasStored(false);
      setRequiresPlanConfirmation(false);
      setPendingPlanSummary(null);
      setActiveStage('analysis');
      setDeployStatus('idle');
      setDeployProgress(0);
      setDeployLogs([]);
      setDeployResult(null);
      setRequiresPlanConfirmation(false);
      setPendingPlanSummary(null);
      setDeploymentHistory([]);
      setBudgetOverride(false);
      setEndpointChecks([]);
      setError(null);
      return;
    }
    const nextProject = projects.find((project) => project.id === nextProjectId) || null;
    const nextWorkspace = buildDeploymentWorkspace(nextProjectId, nextProject?.name || nextProjectId);
    const previousPlanningProjectId = sessionStorage.getItem(PLANNING_PROJECT_KEY);
    const freshLaunch = entry === 'card' || entry === 'selector';
    const projectChanged = !previousPlanningProjectId || previousPlanningProjectId !== nextProjectId;
    if (freshLaunch || projectChanged) {
      clearPlanningState();
      idleRecoveryRef.current = null;
      analysisRequestRef.current = null;
      reviewRequestRef.current = null;
      terraformAutostartRef.current = null;
      decisionCostRequestKeyRef.current = null;
      socketNoticeKeysRef.current.clear();
      setAnalysisLoading(false);
      setReviewLoading(false);
      setRepoContext(null);
      setRepoContextMd('');
      setReview(null);
      setAnswers({});
      setDeploymentProfile(null);
      setArchitectureView(null);
      setApprovalPayload(null);
      setEc2ResourceConfig(DEFAULT_EC2_RESOURCE_CONFIG);
      writeStoredJson(EC2_RESOURCE_CONFIG_KEY, DEFAULT_EC2_RESOURCE_CONFIG);
      setRdsResourceConfig(DEFAULT_RDS_RESOURCE_CONFIG);
      writeStoredJson(RDS_RESOURCE_CONFIG_KEY, DEFAULT_RDS_RESOURCE_CONFIG);
      setRedisResourceConfig(DEFAULT_REDIS_RESOURCE_CONFIG);
      writeStoredJson(REDIS_RESOURCE_CONFIG_KEY, DEFAULT_REDIS_RESOURCE_CONFIG);
      setEcsResourceConfig(DEFAULT_ECS_RESOURCE_CONFIG);
      writeStoredJson(ECS_RESOURCE_CONFIG_KEY, DEFAULT_ECS_RESOURCE_CONFIG);
      setStaticSiteResourceConfig(DEFAULT_STATIC_SITE_RESOURCE_CONFIG);
      writeStoredJson(STATIC_SITE_RESOURCE_CONFIG_KEY, DEFAULT_STATIC_SITE_RESOURCE_CONFIG);
      setIacFiles([]);
      setSelectedFile('');
      persistApprovedDecision(null);
      setDecisionCostEstimate(null);
      setDecisionCostError(null);
      setDeployStatus('idle');
      setDeployProgress(0);
      setDeployLogs([]);
      setDeployResult(null);
      setDeploymentHistory([]);
      setEndpointChecks([]);
      setSocketNotices([]);
      setError(null);
    }
    setSelectedProjectId(nextProjectId);
    const existingRuntimeConfig = readSavedTerraformRuntimeConfig(nextProjectId);
    setTerraformRuntimeConfigWasStored(Boolean(existingRuntimeConfig));
    const seededRuntimeConfig = resolveTerraformRuntimeConfig(nextProjectId, {
      aws: readSavedAws(),
      savedRun: getCurrentSavedRun(readSavedIacRun(), readSavedIacMeta(), nextProjectId, nextWorkspace),
    });
    setTerraformRuntimeConfig(existingRuntimeConfig || seededRuntimeConfig);
    localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, nextProjectId);
    sessionStorage.setItem(PLANNING_PROJECT_KEY, nextProjectId);
    setActiveStage(freshLaunch ? 'analysis' : normalizeDeployUiStage(loadDeployUiStage(nextProjectId)));
    const snapshot = loadDeploySnapshot(nextProjectId);
    const existing = activeDeployments.get(nextProjectId);
    const nextState = existing?.state || toDeployState(snapshot || undefined);
    setActiveDeploymentState(nextProjectId, nextState);
    setEndpointChecks([]);
  }, [persistApprovedDecision, projects, searchParams]);

  useEffect(() => {
    if (!selectedProjectId) return;
    if (hasCurrentIacMeta || iacFiles.length === 0) return;
    sessionStorage.removeItem(IAC_FILES_KEY);
    sessionStorage.removeItem(IAC_RUN_KEY);
    sessionStorage.removeItem(IAC_META_KEY);
    setIacFiles([]);
    setSelectedFile('');
  }, [hasCurrentIacMeta, iacFiles.length, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) return;
    persistDeploySnapshot(selectedProjectId, {
      status: deployStatus,
      progress: deployProgress,
      logs: deployLogs,
      deployResult,
      deploymentHistory,
      updatedAt: new Date().toISOString(),
    });
  }, [deployLogs, deployProgress, deployResult, deployStatus, deploymentHistory, selectedProjectId]);

  useEffect(() => {
    if (!selectedProject || !hasAwsSecrets) return;
    if (deployStatus !== 'idle') return;
    if (idleRecoveryRef.current === selectedProject.id) return;
    if (deployResult?.details && typeof deployResult.details === 'object' && 'live_runtime_details' in (deployResult.details as Record<string, unknown>)) return;

    idleRecoveryRef.current = selectedProject.id;
    let cancelled = false;

    const recover = async () => {
      try {
        const response = await fetch('/api/pipeline/runtime-details', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: selectedProject.id,
            aws_access_key_id: aws.aws_access_key_id,
            aws_secret_access_key: aws.aws_secret_access_key,
            aws_session_token: aws.aws_session_token,
            aws_region: terraformRuntimeConfig.aws_region,
          }),
        });
        const data = await response.json().catch(() => ({})) as { success?: boolean; details?: Record<string, unknown>; error?: string };
        const recoveredInstanceId = String((data.details as { instance?: { instance_id?: string } } | undefined)?.instance?.instance_id || '').trim();
        if (cancelled || !response.ok || data.success !== true || !data.details || !recoveredInstanceId || recoveredInstanceId === 'n/a') return;

        const recoveredResult: DeployApiResult = {
          success: true,
          details: {
            live_runtime_details: data.details,
          },
        };
        patchState((prev) => ({
          ...prev,
          status: 'done',
          progress: 100,
          deployResult: mergeDeployResultWithRuntimeDetails(prev.deployResult || recoveredResult, data.details as AwsRuntimeLiveDetails),
        }));
        pushDeploymentHistory(recoveredResult, 'done');
        appendLog(`Recovered existing deployment for this project (${recoveredInstanceId}).`, 'success');
      } catch {
        // best-effort recovery only
      }
    };

    void recover();

    return () => {
      cancelled = true;
    };
  }, [appendLog, aws.aws_access_key_id, aws.aws_secret_access_key, aws.aws_session_token, deployResult?.details, deployStatus, hasAwsSecrets, patchState, pushDeploymentHistory, selectedProject, terraformRuntimeConfig.aws_region]);

  useEffect(() => {
    if (!selectedProject || !shouldConnectPipelineSocket) {
      if (pipelineSocketRetryRef.current !== null) {
        window.clearTimeout(pipelineSocketRetryRef.current);
        pipelineSocketRetryRef.current = null;
      }
      pipelineSocketRef.current?.close();
      pipelineSocketRef.current = null;
      pipelineSocketAttemptRef.current = 0;
      setDeploySocketState('idle');
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;

    const clearRetry = () => {
      if (pipelineSocketRetryRef.current !== null) {
        window.clearTimeout(pipelineSocketRetryRef.current);
        pipelineSocketRetryRef.current = null;
      }
    };

    const scheduleReconnect = (message: string) => {
      if (disposed || !shouldConnectPipelineSocket) return;
      const attemptIndex = Math.min(pipelineSocketAttemptRef.current, PIPELINE_SOCKET_RETRY_DELAYS_MS.length - 1);
      const delayMs = PIPELINE_SOCKET_RETRY_DELAYS_MS[attemptIndex];
      pipelineSocketAttemptRef.current += 1;
      setDeploySocketState('error');
      appendSocketNotice(`socket-error:${message}`, message, 'error');
      clearRetry();
      pipelineSocketRetryRef.current = window.setTimeout(() => {
        if (disposed || !shouldConnectPipelineSocket) return;
        void connect();
      }, delayMs);
    };

    const connect = async () => {
      try {
        setDeploySocketState('connecting');
        const [wsConfigRes, tokenRes] = await Promise.all([
          fetch('/api/pipeline/ws-config', { cache: 'no-store' }),
          fetch(`/api/scan/ws-token?project_id=${encodeURIComponent(selectedProject.id)}`, { cache: 'no-store' }),
        ]);
        const wsConfig = await wsConfigRes.json().catch(() => ({})) as { success?: boolean; ws_base?: string; error?: string };
        const tokenData = await tokenRes.json().catch(() => ({})) as { token?: string; error?: string };
        if (!wsConfigRes.ok || !wsConfig.success || !wsConfig.ws_base) {
          throw new Error(wsConfig.error || 'Failed to resolve pipeline websocket base.');
        }
        if (!tokenRes.ok || !tokenData.token) {
          throw new Error(tokenData.error || 'Failed to issue pipeline websocket token.');
        }
        if (disposed) return;

        const wsUrl = `${wsConfig.ws_base.replace(/\/$/, '')}/ws/pipeline/${encodeURIComponent(selectedProject.id)}?token=${encodeURIComponent(tokenData.token)}`;
        socket = new WebSocket(wsUrl);
        pipelineSocketRef.current = socket;

        socket.onopen = () => {
          if (disposed) return;
          clearRetry();
          pipelineSocketAttemptRef.current = 0;
          setDeploySocketState('connected');
          appendSocketNotice(`socket-connected:${selectedProject.id}`, 'Live monitoring connected.', 'info');
          socket?.send(JSON.stringify({ action: 'start' }));
        };

        socket.onmessage = (event) => {
          if (disposed) return;
          try {
            const payload = JSON.parse(String(event.data || '')) as {
              type?: string;
              data?: {
                type?: 'info' | 'success' | 'error';
                content?: string;
                message?: string;
                worker_id?: string;
                worker_role?: string;
                worker_status?: string;
                stage?: string;
                model?: string;
              };
            };
            const frameType = String(payload.type || '').toLowerCase();
            if (frameType !== 'message' && frameType !== 'status') return;
            const frameData = payload.data || {};
            const content = String(frameData.content || frameData.message || '').trim();
            if (!content) return;
            appendLog(content, frameData.type || 'info', {
              worker_id: frameData.worker_id,
              worker_role: frameData.worker_role,
              worker_status: frameData.worker_status,
              stage: frameData.stage,
              model: frameData.model,
            });
          } catch {
            // ignore malformed websocket payloads
          }
        };

        socket.onerror = () => {
          if (disposed) return;
          setDeploySocketState('error');
          appendSocketNotice('socket-event:error', 'Live monitoring hit a websocket error. Reconnect will be attempted automatically.', 'error');
        };

        socket.onclose = () => {
          if (disposed) return;
          if (pipelineSocketRef.current === socket) {
            pipelineSocketRef.current = null;
          }
          scheduleReconnect('Live monitoring disconnected. Retrying with backoff.');
        };
      } catch (reason) {
        if (disposed) return;
        scheduleReconnect(reason instanceof Error ? reason.message : 'Failed to connect to live pipeline websocket.');
      }
    };

    void connect();

    return () => {
      disposed = true;
      clearRetry();
      socket?.close();
      if (pipelineSocketRef.current === socket) {
        pipelineSocketRef.current = null;
      }
      pipelineSocketAttemptRef.current = 0;
      setDeploySocketState('idle');
    };
  }, [appendLog, appendSocketNotice, selectedProject, shouldConnectPipelineSocket]);

  const setAndPersistStage = useCallback((stage: PipelineStageId, options?: { force?: boolean }) => {
    const nextStage = normalizeDeployUiStage(stage);
    if (!selectedProjectId) {
      setActiveStage('analysis');
      return;
    }
    if (nextStage === 'aws_config' && !canContinueToAwsConfig && !options?.force) {
      return;
    }
    if (nextStage === 'app_secrets' && (!hasAwsSecrets || !canContinueToAwsConfig) && !options?.force) {
      return;
    }
    if (nextStage === 'terraform' && !canContinueToTerraform && !options?.force) {
      return;
    }
    setActiveStage(nextStage);
    if (selectedProjectId) {
      saveDeployUiStage(selectedProjectId, nextStage);
      localStorage.setItem(`${CURRENT_STAGE_STORAGE_PREFIX}${selectedProjectId}`, nextStage);
    }
  }, [canContinueToAwsConfig, canContinueToTerraform, hasAwsSecrets, selectedProjectId]);

  const runAnalysis = useCallback(async () => {
    if (!selectedProject) return;
    const workspace = buildDeploymentWorkspace(selectedProject.id, selectedProject.name);
    if (analysisRequestRef.current === workspace) return;
    analysisRequestRef.current = workspace;
    setAnalysisLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/repository-analysis/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: selectedProject.id, workspace }),
      });
      const data = await response.json().catch(() => ({})) as { success?: boolean; context_json?: RepositoryContextJson; context_md?: string; error?: string };
      if (!response.ok || !data.success || !data.context_json) {
        throw new Error(data.error || 'Repository analysis failed.');
      }
      const contextMd = String(data.context_md || '');
      setRepoContext(data.context_json);
      setRepoContextMd(contextMd);
      writeStoredJson('deplai.pipeline.repoContext', data.context_json);
      writeStoredJson(REPO_CONTEXT_MD_KEY, contextMd);
      writeStoredJson(QA_CONTEXT_KEY, { qa_summary: String(data.context_json.summary || '') });
    } finally {
      setAnalysisLoading(false);
      if (analysisRequestRef.current === workspace) {
        analysisRequestRef.current = null;
      }
    }
  }, [selectedProject]);

  useEffect(() => {
    if (activeStage !== 'analysis' || !selectedProject) return;
    if (repoContext && repoContext.workspace === expectedWorkspace) return;
    void runAnalysis().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Repository analysis failed.'));
  }, [activeStage, expectedWorkspace, repoContext, runAnalysis, selectedProject]);

  useEffect(() => {
    if (!infraConsultant) return;
    if (!expectedWorkspace || infraConsultant.workspace !== expectedWorkspace) {
      persistInfraConsultant(null);
    }
  }, [expectedWorkspace, infraConsultant, persistInfraConsultant]);

  const loadReview = useCallback(async () => {
    if (!selectedProject) return;
    const workspace = repoContext?.workspace || buildDeploymentWorkspace(selectedProject.id, selectedProject.name);
    if (reviewRequestRef.current === workspace) return;
    reviewRequestRef.current = workspace;
    setReviewLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/architecture/review/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: selectedProject.id, workspace }),
      });
      const data = await response.json().catch(() => ({})) as { success?: boolean; review?: ArchitectureReviewPayload; error?: string };
      if (!response.ok || !data.success || !data.review) {
        throw new Error(data.error || 'Failed to start architecture review.');
      }
      setReview(data.review);
      const initialAnswers = Object.keys(answers).length > 0 ? answers : {};
      setAnswers(initialAnswers);
      writeStoredJson(REVIEW_PAYLOAD_KEY, data.review);
      writeStoredJson(REVIEW_ANSWERS_KEY, initialAnswers);
    } finally {
      setReviewLoading(false);
      if (reviewRequestRef.current === workspace) {
        reviewRequestRef.current = null;
      }
    }
  }, [answers, repoContext?.workspace, selectedProject]);

  useEffect(() => {
    if (activeStage !== 'qa' || !selectedProject) return;
    if (!repoContext || repoContext.workspace !== expectedWorkspace) {
      setAndPersistStage('analysis');
      return;
    }
    if (review && review.context_json.workspace === expectedWorkspace && review.questions.length > 0) return;
    void loadReview().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Failed to start architecture review.'));
  }, [activeStage, expectedWorkspace, loadReview, repoContext, review, selectedProject, setAndPersistStage]);

  const updateAnswer = useCallback((questionId: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
  }, []);

  const generatePlan = useCallback(async () => {
    if (!selectedProject || !review) return;
    setError(null);
    const mergedAnswers = {
      ...(review.defaults || {}),
      ...answers,
    };
    setAnswers(mergedAnswers);
    writeStoredJson(REVIEW_ANSWERS_KEY, mergedAnswers);
    const response = await fetch('/api/architecture/review/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: selectedProject.id, workspace: review.context_json.workspace || buildDeploymentWorkspace(selectedProject.id, selectedProject.name), answers: mergedAnswers }),
    });
    const data = await response.json().catch(() => ({})) as {
      success?: boolean;
      deployment_profile?: Record<string, unknown>;
      architecture_view?: Record<string, unknown>;
      approval_payload?: Record<string, unknown>;
      error?: string;
    };
    if (!response.ok || !data.success || !data.deployment_profile || !data.architecture_view) {
      throw new Error(data.error || 'Failed to generate deployment profile.');
    }
    setDeploymentProfile(data.deployment_profile);
    setArchitectureView(data.architecture_view);
    setApprovalPayload(data.approval_payload || null);
    writeStoredJson(DEPLOYMENT_PROFILE_KEY, data.deployment_profile);
    writeStoredJson(ARCHITECTURE_VIEW_KEY, data.architecture_view);
    writeStoredJson(APPROVAL_PAYLOAD_KEY, data.approval_payload || {});
    writeStoredJson(COST_ESTIMATE_KEY, {
      total_monthly_usd: Number((data.approval_payload?.cost_estimate as { total_monthly_usd?: number } | undefined)?.total_monthly_usd || 0),
      budget_cap_usd: Number((data.approval_payload?.budget_gate as { cap_usd?: number } | undefined)?.cap_usd || 100),
    });
    setAndPersistStage('architecture');
  }, [answers, review, selectedProject, setAndPersistStage]);

  const resetCurrentIacSessionArtifacts = useCallback(() => {
    sessionStorage.removeItem(IAC_FILES_KEY);
    sessionStorage.removeItem(IAC_RUN_KEY);
    sessionStorage.removeItem(IAC_META_KEY);
    socketNoticeKeysRef.current.clear();
    setSocketNotices([]);
    setIacFiles([]);
    setSelectedFile('');
    setIacPrUrl(null);
    patchState((prev) => ({
      ...prev,
      logs: prev.logs.filter((log) => log.stage !== 'terraform_generation'),
    }));
  }, [patchState]);

  const handleDeploymentPlanChange = useCallback((planId: DeploymentPlanId) => {
    if (deploymentPlan === planId) return;
    resetCurrentIacSessionArtifacts();
    persistApprovedDecision(null);
    setDecisionCostEstimate(null);
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(DECISION_COST_ESTIMATE_KEY);
    }
    if (currentInfraConsultant?.confirmed) {
      persistInfraConsultant({ ...currentInfraConsultant, confirmed: false });
    }
    appendLog(`Deployment target changed to ${DEPLOYMENT_PLAN_OPTIONS.find((option) => option.id === planId)?.label || planId}. Regenerate infrastructure before deploy.`, 'info', { stage: 'terraform_generation' });
    setDeploymentPlan(planId);
  }, [appendLog, currentInfraConsultant, deploymentPlan, persistApprovedDecision, persistInfraConsultant, resetCurrentIacSessionArtifacts]);

  const handleDeploymentServiceToggle = useCallback((service: keyof DeploymentServiceSelection) => {
    resetCurrentIacSessionArtifacts();
    persistApprovedDecision(null);
    setDecisionCostEstimate(null);
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(DECISION_COST_ESTIMATE_KEY);
    }
    if (currentInfraConsultant?.confirmed) {
      persistInfraConsultant({ ...currentInfraConsultant, confirmed: false });
    }
    appendLog('Managed service selection changed. Regenerate infrastructure before deploy.', 'info', { stage: 'terraform_generation' });
    setDeploymentServices((current) => ({ ...current, [service]: !current[service] }));
  }, [appendLog, currentInfraConsultant, persistApprovedDecision, persistInfraConsultant, resetCurrentIacSessionArtifacts]);

  const handleEc2ResourceConfigChange = useCallback((patch: Partial<Ec2ResourceConfig>) => {
    const next = normalizeEc2ResourceConfig({ ...ec2ResourceConfig, ...patch });
    resetCurrentIacSessionArtifacts();
    persistApprovedDecision(null);
    setDecisionCostEstimate(null);
    setDecisionCostError(null);
    decisionCostRequestKeyRef.current = null;
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(DECISION_COST_ESTIMATE_KEY);
      sessionStorage.removeItem(COST_ESTIMATE_KEY);
    }
    writeStoredJson(EC2_RESOURCE_CONFIG_KEY, next);
    if (currentInfraConsultant?.confirmed) {
      persistInfraConsultant({ ...currentInfraConsultant, confirmed: false });
    }
    appendLog('Advanced EC2 settings changed. Re-approve the consultant decision before Terraform generation.', 'info', { stage: 'terraform_generation' });
    setEc2ResourceConfig(next);
  }, [
    appendLog,
    currentInfraConsultant,
    ec2ResourceConfig,
    persistApprovedDecision,
    persistInfraConsultant,
    resetCurrentIacSessionArtifacts,
  ]);

  const invalidateDecisionForResourceChange = useCallback((logMessage: string) => {
    resetCurrentIacSessionArtifacts();
    persistApprovedDecision(null);
    setDecisionCostEstimate(null);
    setDecisionCostError(null);
    decisionCostRequestKeyRef.current = null;
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(DECISION_COST_ESTIMATE_KEY);
      sessionStorage.removeItem(COST_ESTIMATE_KEY);
    }
    if (currentInfraConsultant?.confirmed) {
      persistInfraConsultant({ ...currentInfraConsultant, confirmed: false });
    }
    appendLog(logMessage, 'info', { stage: 'terraform_generation' });
  }, [appendLog, currentInfraConsultant, persistApprovedDecision, persistInfraConsultant, resetCurrentIacSessionArtifacts]);

  const handleRdsResourceConfigChange = useCallback((patch: Partial<RdsResourceConfig>) => {
    const merged: Partial<RdsResourceConfig> = { ...rdsResourceConfig, ...patch };
    if (patch.engine && patch.engine_version === undefined) {
      merged.engine_version = RDS_ENGINE_META[patch.engine]?.defaultVersion;
    }

    const next = normalizeRdsResourceConfig(merged);
    writeStoredJson(RDS_RESOURCE_CONFIG_KEY, next);
    invalidateDecisionForResourceChange('RDS settings changed. Re-approve the consultant decision before Terraform generation.');
    setRdsResourceConfig(next);
  }, [invalidateDecisionForResourceChange, rdsResourceConfig]);

  const handleRedisResourceConfigChange = useCallback((patch: Partial<RedisResourceConfig>) => {
    const next = normalizeRedisResourceConfig({ ...redisResourceConfig, ...patch });
    writeStoredJson(REDIS_RESOURCE_CONFIG_KEY, next);
    invalidateDecisionForResourceChange('Redis settings changed. Re-approve the consultant decision before Terraform generation.');
    setRedisResourceConfig(next);
  }, [invalidateDecisionForResourceChange, redisResourceConfig]);

  const handleEcsResourceConfigChange = useCallback((patch: Partial<EcsResourceConfig>) => {
    const next = normalizeEcsResourceConfig({ ...ecsResourceConfig, ...patch });
    writeStoredJson(ECS_RESOURCE_CONFIG_KEY, next);
    invalidateDecisionForResourceChange('ECS settings changed. Re-approve the consultant decision before Terraform generation.');
    setEcsResourceConfig(next);
  }, [ecsResourceConfig, invalidateDecisionForResourceChange]);

  const handleStaticSiteResourceConfigChange = useCallback((patch: Partial<StaticSiteResourceConfig>) => {
    const next = normalizeStaticSiteResourceConfig({ ...staticSiteResourceConfig, ...patch });
    writeStoredJson(STATIC_SITE_RESOURCE_CONFIG_KEY, next);
    invalidateDecisionForResourceChange('CloudFront settings changed. Re-approve the consultant decision before Terraform generation.');
    setStaticSiteResourceConfig(next);
  }, [invalidateDecisionForResourceChange, staticSiteResourceConfig]);

  const runInfraConsultantTurn = useCallback(async (
    action: 'start' | 'reply' | 'force_decision',
    history: InfraConsultantMessage[],
    priorDecision?: InfraConsultantDecision | null,
  ) => {
    if (!selectedProject) return;
    setError(null);
    setInfraConsultantLoading(true);
    try {
      const response = await fetch('/api/pipeline/iac', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: selectedProject.id,
          provider: 'aws',
          terraform_renderer: 'auto',
          consultant_action: action,
          consultant_history: history,
          consultant_turn_count: currentInfraConsultant?.turn_count || 0,
          consultant_decision: priorDecision !== undefined
            ? (priorDecision || undefined)
            : (currentInfraConsultant?.decision || undefined),
          architecture_json: deploymentProfile || architectureView || consultantArchitectureSeed,
          deployment_profile: deploymentProfile || consultantArchitectureSeed,
          repository_context: repoContext || undefined,
          user_answers: infraUserAnswers,
          aws_region: terraformRuntimeConfig.aws_region.trim() || DEFAULT_AWS_REGION,
          qa_summary: qaSummary,
          budget_cap_usd: currentInfraConsultant?.budget_cap_usd || undefined,
          selected_tier: currentInfraConsultant?.selected_tier || undefined,
          requirements: currentInfraConsultant?.requirements || undefined,
          customization_snapshot_id: customizationSnapshotId || undefined,
          tenant_id: customizationTenantId || undefined,
        }),
      });
      const data = await response.json().catch(() => ({})) as {
        success?: boolean;
        consultant_response?: string;
        consultant_ready?: boolean;
        consultant_turn_count?: number;
        repo_detection_summary?: string;
        consultant_decision?: InfraConsultantDecision | null;
        consultant_summary?: string | null;
        budget_cap_usd?: number | null;
        selected_tier?: string | null;
        upgrade_suggestions?: InfraConsultantState['upgrade_suggestions'];
        advisor_budget_gate?: InfraConsultantState['budget_gate'];
        advisor_cost_estimate?: InfraConsultantState['advisor_cost_estimate'];
        advisor_requirements?: Record<string, string> | null;
        error?: string;
      };
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Infra consultant conversation failed.');
      }

      const nextHistory = [...history];
      const assistantMessage = String(data.consultant_response || '').trim();
      if (assistantMessage) {
        nextHistory.push({ role: 'assistant', content: assistantMessage });
      }
      const nextDecision = data.consultant_decision || null;
      if (nextDecision) {
        const nextPlan = inferDeploymentPlanFromDecision(nextDecision);
        const nextServices = inferServicesFromDecision(nextDecision);
        setDeploymentPlan(nextPlan);
        writeStoredJson(DEPLOYMENT_PLAN_KEY, nextPlan);
        setDeploymentServices(nextServices);
        writeStoredJson(DEPLOYMENT_SERVICES_KEY, nextServices);
        const nextEc2Config = ec2ResourceConfigFromDecision(nextDecision);
        setEc2ResourceConfig(nextEc2Config);
        writeStoredJson(EC2_RESOURCE_CONFIG_KEY, nextEc2Config);
        const nextRdsConfig = rdsResourceConfigFromDecision(nextDecision);
        if (nextRdsConfig) {
          setRdsResourceConfig(nextRdsConfig);
          writeStoredJson(RDS_RESOURCE_CONFIG_KEY, nextRdsConfig);
        }
        const nextRedisConfig = redisResourceConfigFromDecision(nextDecision);
        if (nextRedisConfig) {
          setRedisResourceConfig(nextRedisConfig);
          writeStoredJson(REDIS_RESOURCE_CONFIG_KEY, nextRedisConfig);
        }
        const nextEcsConfig = ecsResourceConfigFromDecision(nextDecision);
        if (nextEcsConfig) {
          setEcsResourceConfig(nextEcsConfig);
          writeStoredJson(ECS_RESOURCE_CONFIG_KEY, nextEcsConfig);
        }
        const nextStaticConfig = staticSiteResourceConfigFromDecision(nextDecision);
        if (nextStaticConfig) {
          setStaticSiteResourceConfig(nextStaticConfig);
          writeStoredJson(STATIC_SITE_RESOURCE_CONFIG_KEY, nextStaticConfig);
        }
      }
      const nextSummary = String(data.consultant_summary || '').trim() || summarizeInfraConsultantDecision(nextDecision);
      if (!assistantMessage && nextDecision) {
        nextHistory.push({
          role: 'assistant',
          content: nextSummary || 'I produced an infrastructure decision from the available repository context. Review and confirm it to continue.',
        });
      }
      if (!assistantMessage && !nextDecision) {
        throw new Error('Infra consultant returned no question or decision.');
      }

      const nextReady = Boolean(data.consultant_ready);
      const tierRaw = String(data.selected_tier || currentInfraConsultant?.selected_tier || 'recommended').trim();
      const selectedTier = (tierRaw === 'baseline' || tierRaw === 'resilient' || tierRaw === 'recommended')
        ? tierRaw
        : 'recommended';
      persistInfraConsultant({
        workspace: expectedWorkspace,
        history: nextHistory,
        repo_detection_summary: String(data.repo_detection_summary || currentInfraConsultant?.repo_detection_summary || ''),
        turn_count: Number(data.consultant_turn_count || (currentInfraConsultant?.turn_count || 0)),
        decision: nextDecision,
        summary: nextSummary,
        confirmed: false,
        ready: nextReady,
        budget_cap_usd: Number(data.budget_cap_usd || currentInfraConsultant?.budget_cap_usd || 0) || undefined,
        selected_tier: selectedTier,
        upgrade_suggestions: Array.isArray(data.upgrade_suggestions)
          ? data.upgrade_suggestions
          : (currentInfraConsultant?.upgrade_suggestions || []),
        budget_gate: data.advisor_budget_gate || currentInfraConsultant?.budget_gate,
        advisor_cost_estimate: data.advisor_cost_estimate || currentInfraConsultant?.advisor_cost_estimate,
        requirements: data.advisor_requirements || currentInfraConsultant?.requirements,
      });
    } finally {
      setInfraConsultantLoading(false);
    }
  }, [
    consultantArchitectureSeed,
    customizationSnapshotId,
    customizationTenantId,
    architectureView,
    currentInfraConsultant,
    deploymentProfile,
    expectedWorkspace,
    infraUserAnswers,
    persistInfraConsultant,
    qaSummary,
    repoContext,
    selectedProject,
    terraformRuntimeConfig.aws_region,
  ]);

  useEffect(() => {
    if (activeStage !== 'qa' || !selectedProject) return;
    if (!repoContext || repoContext.workspace !== expectedWorkspace) return;
    if (infraConsultantLoading) return;
    const hasStartedConsultant = Boolean(
      currentInfraConsultant
      && (
        (currentInfraConsultant.history?.length || 0) > 0
        || (currentInfraConsultant.turn_count || 0) > 0
        || currentInfraConsultant.decision
      ),
    );
    if (hasStartedConsultant) return;

    if (!currentInfraConsultant) {
      persistInfraConsultant({
        workspace: expectedWorkspace,
        history: [],
        repo_detection_summary: '',
        turn_count: 0,
        decision: null,
        summary: '',
        confirmed: false,
        ready: false,
      });
    }
    void runInfraConsultantTurn('start', []).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Failed to start infra consultant.');
    });
  }, [
    activeStage,
    currentInfraConsultant,
    expectedWorkspace,
    infraConsultantLoading,
    persistInfraConsultant,
    repoContext,
    runInfraConsultantTurn,
    selectedProject,
  ]);

  const fetchDecisionCostEstimate = useCallback(async (decision: InfraConsultantDecision) => {
    if (!selectedProject) return;
    setDecisionCostLoading(true);
    setDecisionCostError(null);
    try {
      const normalizedDecision: InfraConsultantDecision = {
        ...decision,
        components: normalizeDecisionComponents(decision),
        deploy_sequence: normalizeDecisionSequence(decision),
        stack_config: toRecord(decision?.stack_config),
      };
      const response = await fetch('/api/pipeline/cost-estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: selectedProject.id,
          aws_region: terraformRuntimeConfig.aws_region.trim() || DEFAULT_AWS_REGION,
          decision: normalizedDecision,
        }),
      });
      const data = await response.json().catch(() => ({})) as DecisionCostEstimate;
      if (!response.ok || !data.success) {
        throw new Error(String(data.error || 'Failed to estimate AWS monthly cost.'));
      }
      setDecisionCostEstimate(data);
      writeStoredJson(DECISION_COST_ESTIMATE_KEY, data);
      writeStoredJson(COST_ESTIMATE_KEY, {
        total_monthly_usd: Number(data.subtotal_monthly_usd || 0),
        budget_cap_usd: Number(currentInfraConsultant?.budget_cap_usd || costEstimate.cap || 100),
      });
    } finally {
      setDecisionCostLoading(false);
    }
  }, [costEstimate.cap, currentInfraConsultant?.budget_cap_usd, selectedProject, terraformRuntimeConfig.aws_region]);

  useEffect(() => {
    if (!decisionForVisualization || !selectedProject) return;
    if (!['architecture', 'cost_estimation', 'deploy', 'aws_config'].includes(activeStage)) return;
    if (!currentInfraConsultant?.confirmed && !approvedConsultantDecision) return;
    if (!currentDecisionHash) return;

    const requestKey = `${selectedProject.id}:${expectedWorkspace}:${decisionSignature}`;
    const estimateMatchesDecision = Boolean(
      decisionCostEstimate?.decision_hash
      && decisionCostEstimate.decision_hash === currentDecisionHash,
    );
    if (decisionCostRequestKeyRef.current === requestKey && estimateMatchesDecision) return;
    decisionCostRequestKeyRef.current = requestKey;
    void fetchDecisionCostEstimate(decisionForVisualization).catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : 'Failed to estimate AWS monthly cost.';
      setDecisionCostError(message);
      // Don't hard-block deploy UX on a refresh failure; surface as a soft error.
      if (activeStage === 'architecture' || activeStage === 'cost_estimation') {
        setError(message);
      }
    });
  }, [
    activeStage,
    approvedConsultantDecision,
    currentDecisionHash,
    currentInfraConsultant?.confirmed,
    decisionCostEstimate,
    decisionForVisualization,
    decisionSignature,
    expectedWorkspace,
    fetchDecisionCostEstimate,
    selectedProject,
  ]);

  useEffect(() => {
    const advisorCap = Number(currentInfraConsultant?.budget_cap_usd || 0);
    if (!(advisorCap > 0)) return;
    const stored = readCostEstimate();
    if (Math.abs(stored.cap - advisorCap) < 0.01) return;
    writeStoredJson(COST_ESTIMATE_KEY, {
      total_monthly_usd: Number(decisionCostEstimate?.subtotal_monthly_usd || stored.total || 0),
      budget_cap_usd: advisorCap,
    });
  }, [currentInfraConsultant?.budget_cap_usd, decisionCostEstimate?.subtotal_monthly_usd]);
  const generateTerraform = useCallback(async (): Promise<boolean> => {
    if (!selectedProject) return false;
    setError(null);
    setIacPrUrl(null);
    setTerraformGenerating(true);
    appendLog('Starting infrastructure generation from the confirmed deployment profile.', 'info', { stage: 'terraform_generation' });
    try {
      // The dashboard may restore this stage immediately after a Connector
      // container restart.  Do not fire the one-shot generation request until
      // the same-origin API is ready; otherwise browsers surface only the
      // unhelpful TypeError: Failed to fetch.
      await ensureConnectorApiReady();
      const response = await fetch('/api/pipeline/iac', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        body: JSON.stringify({
          project_id: selectedProject.id,
          provider: 'aws',
          iac_mode: 'llm',
          terraform_renderer: 'auto',
          qa_summary: qaSummary,
          architecture_context: String(repoContext?.summary || ''),
          repository_context: repoContext || undefined,
          deployment_profile: deploymentProfile || consultantArchitectureSeed,
          approval_payload: approvalPayload || undefined,
          architecture_json: deploymentProfile || architectureView || consultantArchitectureSeed,
          user_answers: infraUserAnswers,
          consultant_decision: approvedConsultantDecision || undefined,
          aws_region: terraformRuntimeConfig.aws_region.trim() || DEFAULT_AWS_REGION,
          customization_snapshot_id: customizationSnapshotId || undefined,
          tenant_id: customizationTenantId || undefined,
        }),
      });
      const data = await response.json().catch(() => ({})) as {
        success?: boolean;
        files?: GeneratedIacFile[];
        summary?: string;
        warnings?: string[];
        run_id?: string;
        workspace?: string;
        provider_version?: string;
        state_bucket?: string;
        lock_table?: string;
        source?: string;
        source_metadata?: SavedIacMeta['source_metadata'];
        requested_renderer?: string;
        actual_renderer?: string;
        execution_kind?: string;
        component_catalog_version?: string;
        unsupported_reason?: string;
        deployment_package_id?: string;
        decision_applied?: boolean;
        decision_drift?: Array<{
          component?: unknown;
          key?: unknown;
          expected?: unknown;
          got?: unknown;
        }>;
        requires_infra_consultation?: boolean;
        details?: unknown;
        error?: string;
      };
      if (!response.ok || !data.success) {
        if (data.requires_infra_consultation) {
          appendLog('Infrastructure consultant decision is required before Terraform generation.', 'error', { stage: 'terraform_generation' });
        }
        const detail = typeof data.details === 'string'
          ? data.details
          : data.details && typeof data.details === 'object'
            ? JSON.stringify(data.details)
            : '';
        const message = [String(data.error || '').trim(), detail.trim(), 'Infrastructure generation failed.']
          .filter(Boolean)
          .join(' | ');
        throw new Error(message);
      }
      const files = normalizeIacFiles(Array.isArray(data.files) ? data.files : []);
      setIacFiles(files);
      if (files[0]?.path) setSelectedFile(files[0].path);
      writeStoredJson(IAC_FILES_KEY, files);
      if (data.run_id && data.workspace) {
        sessionStorage.setItem(IAC_RUN_KEY, JSON.stringify({ run_id: data.run_id, workspace: data.workspace, provider_version: data.provider_version || '', state_bucket: data.state_bucket || '', lock_table: data.lock_table || '' }));
      } else {
        sessionStorage.removeItem(IAC_RUN_KEY);
      }
      sessionStorage.setItem(IAC_META_KEY, JSON.stringify({
        project_id: selectedProject.id,
        workspace: expectedWorkspace,
        runtime_workspace: data.workspace || undefined,
        source: String(data.source || ''),
        source_metadata: data.source_metadata || null,
        generated_at: new Date().toISOString(),
        has_run: Boolean(data.run_id && data.workspace),
        requested_renderer: String(data.requested_renderer || '').trim() || undefined,
        actual_renderer: String(data.actual_renderer || '').trim() || undefined,
        execution_kind: String(data.execution_kind || '').trim() || undefined,
        component_catalog_version: String(data.component_catalog_version || '').trim() || undefined,
        unsupported_reason: String(data.unsupported_reason || '').trim() || undefined,
        deployment_package_id: String(data.deployment_package_id || '').trim() || undefined,
        decision_applied: typeof data.decision_applied === 'boolean' ? data.decision_applied : undefined,
        decision_drift: Array.isArray(data.decision_drift)
          ? data.decision_drift.map((item) => ({
            component: String(item?.component || '').trim(),
            key: String(item?.key || '').trim(),
            expected: item?.expected,
            got: item?.got,
          })).filter((item) => item.component.length > 0 && item.key.length > 0)
          : [],
      }));
      if (!terraformRuntimeConfigWasStored) {
        setTerraformRuntimeConfig((prev) => ({
          aws_region: String(prev.aws_region || DEFAULT_AWS_REGION).trim() || DEFAULT_AWS_REGION,
          state_bucket: prev.state_bucket || String(data.state_bucket || '').trim(),
          lock_table: prev.lock_table || String(data.lock_table || '').trim(),
        }));
        setTerraformRuntimeConfigWasStored(true);
      }
      appendLog(data.summary || `Infrastructure generation completed with ${files.length} file(s).`, 'success', { stage: 'terraform_generation' });
      for (const warning of Array.isArray(data.warnings) ? data.warnings : []) {
        appendLog(String(warning), 'info', { stage: 'terraform_generation' });
      }
      return true;
    } catch (reason) {
      const rawMessage = reason instanceof Error ? reason.message : 'Infrastructure generation failed.';
      const message = /failed to fetch/i.test(rawMessage)
        ? 'The connection to the DeplAI API was interrupted before Terraform generation returned a result. Select Regenerate Terraform to retry.'
        : rawMessage;
      appendLog(message, 'error', { stage: 'terraform_generation' });
      throw new Error(message);
    } finally {
      setTerraformGenerating(false);
    }
  }, [appendLog, approvalPayload, approvedConsultantDecision, architectureView, consultantArchitectureSeed, customizationSnapshotId, customizationTenantId, deploymentProfile, expectedWorkspace, infraUserAnswers, qaSummary, repoContext, selectedProject, terraformRuntimeConfig.aws_region, terraformRuntimeConfigWasStored]);

  const createIacPr = useCallback(async () => {
    if (!selectedProject || iacPrCreating || terraformGenerating || deployableIacFiles.length === 0) return;
    setError(null);
    setIacPrCreating(true);
    try {
      const response = await fetch('/api/pipeline/iac/pr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: selectedProject.id,
          project_name: selectedProject.name,
          files: deployableIacFiles,
        }),
      });
      const data = await response.json().catch(() => ({})) as IacPrResponse;
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to create infrastructure PR.');
      }
      const prUrl = String(data.pr_url || '').trim();
      setIacPrUrl(prUrl || null);
      appendLog(prUrl ? `Infrastructure PR created: ${prUrl}` : 'Infrastructure PR created.', 'success');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to create infrastructure PR.');
    } finally {
      setIacPrCreating(false);
    }
  }, [appendLog, deployableIacFiles, iacPrCreating, selectedProject, terraformGenerating]);

  useEffect(() => {
    if (activeStage !== 'terraform' || !selectedProject) return;
    if (terraformGenerating || infraConsultantLoading || hasSuccessfulGeneration) return;
    if (!repoContext || repoContext.workspace !== expectedWorkspace) return;

    if (!approvedConsultantDecision) return;
    const autostartKey = `${selectedProject.id}:${expectedWorkspace}:${decisionSignature}:${Boolean(hasSuccessfulGeneration)}`;
    if (terraformAutostartRef.current === autostartKey) return;
    terraformAutostartRef.current = autostartKey;

    resetCurrentIacSessionArtifacts();
    appendLog('Infra consultant decision approved. Starting repo-specific Terraform generation through the strategy router.', 'info', { stage: 'terraform_generation' });
    void generateTerraform().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Infrastructure generation failed.');
    });
  }, [
    activeStage,
    appendLog,
    approvedConsultantDecision,
    decisionSignature,
    expectedWorkspace,
    generateTerraform,
    hasSuccessfulGeneration,
    infraConsultantLoading,
    repoContext,
    resetCurrentIacSessionArtifacts,
    selectedProject,
    terraformGenerating,
  ]);

  const submitInfraConsultantMessage = useCallback(async () => {
    const message = infraConsultantInput.trim();
    if (!message || !selectedProject) return;
    const priorHistory = currentInfraConsultant?.history || [];
    const priorDecision = currentInfraConsultant?.decision || null;
    const nextHistory: InfraConsultantMessage[] = [...priorHistory, { role: 'user', content: message }];
    persistInfraConsultant({
      workspace: expectedWorkspace,
      history: nextHistory,
      repo_detection_summary: currentInfraConsultant?.repo_detection_summary || '',
      turn_count: currentInfraConsultant?.turn_count || 0,
      decision: priorDecision,
      summary: currentInfraConsultant?.summary || '',
      confirmed: false,
      ready: false,
      budget_cap_usd: currentInfraConsultant?.budget_cap_usd,
      selected_tier: currentInfraConsultant?.selected_tier,
      upgrade_suggestions: currentInfraConsultant?.upgrade_suggestions,
      budget_gate: currentInfraConsultant?.budget_gate,
      advisor_cost_estimate: currentInfraConsultant?.advisor_cost_estimate,
      requirements: currentInfraConsultant?.requirements,
    });
    setInfraConsultantInput('');
    await runInfraConsultantTurn(
      (currentInfraConsultant?.turn_count || 0) >= 20 ? 'force_decision' : 'reply',
      nextHistory,
      priorDecision,
    );
  }, [
    currentInfraConsultant,
    expectedWorkspace,
    infraConsultantInput,
    persistInfraConsultant,
    runInfraConsultantTurn,
    selectedProject,
  ]);

  const approveInfraConsultantDecision = useCallback(() => {
    if (!currentInfraConsultant?.decision) return;
    const approvedDecision = JSON.parse(JSON.stringify(deploymentSelectionDecision)) as InfraConsultantDecision;
    const budgetCap = Number(currentInfraConsultant.budget_cap_usd || costEstimate.cap || 100);
    persistInfraConsultant({
      ...currentInfraConsultant,
      decision: approvedDecision,
      summary: summarizeInfraConsultantDecision(approvedDecision),
      confirmed: true,
      ready: true,
    });
    persistApprovedDecision({
      workspace: expectedWorkspace,
      decision: approvedDecision,
      locked_at: new Date().toISOString(),
    });
    writeStoredJson(COST_ESTIMATE_KEY, {
      total_monthly_usd: Number(currentInfraConsultant.advisor_cost_estimate?.subtotal_monthly_usd || costEstimate.total || 0),
      budget_cap_usd: budgetCap,
    });
  }, [costEstimate.cap, costEstimate.total, currentInfraConsultant, deploymentSelectionDecision, expectedWorkspace, persistApprovedDecision, persistInfraConsultant]);

  const lockDecisionForTerraform = useCallback(() => {
    if (approvedConsultantDecision) return true;
    const decision = deploymentSelectionDecision || currentInfraConsultant?.decision || decisionForVisualization;
    if (!decision) return false;
    persistApprovedDecision({
      workspace: expectedWorkspace,
      decision: JSON.parse(JSON.stringify(decision)) as InfraConsultantDecision,
      locked_at: new Date().toISOString(),
    });
    if (currentInfraConsultant) {
      persistInfraConsultant({
        ...currentInfraConsultant,
        decision: JSON.parse(JSON.stringify(decision)) as InfraConsultantDecision,
        summary: summarizeInfraConsultantDecision(decision),
        confirmed: true,
        ready: true,
      });
    }
    return true;
  }, [
    approvedConsultantDecision,
    currentInfraConsultant,
    decisionForVisualization,
    deploymentSelectionDecision,
    expectedWorkspace,
    persistApprovedDecision,
    persistInfraConsultant,
  ]);

  const rejectInfraConsultantDecision = useCallback(async () => {
    if (!currentInfraConsultant) return;
    const nextHistory: InfraConsultantMessage[] = [
      ...currentInfraConsultant.history,
      { role: 'user', content: 'Not yet. Keep refining and ask the next thing you need in simple terms.' },
    ];
    persistInfraConsultant({
      ...currentInfraConsultant,
      history: nextHistory,
      decision: currentInfraConsultant.decision,
      summary: '',
      confirmed: false,
      ready: false,
    });
    await runInfraConsultantTurn('reply', nextHistory, currentInfraConsultant.decision);
  }, [currentInfraConsultant, persistInfraConsultant, runInfraConsultantTurn]);

  const hydrateTerminalDeployResult = useCallback(async (baseResult: DeployApiResult | null) => {
    if (!baseResult?.success || String(baseResult.error || '').trim()) {
      throw new Error(String(baseResult?.error || 'Deployment runtime returned an error.'));
    }
    if (baseResult.mode === 'iac_pipeline') {
      return baseResult;
    }
    const existingInstanceId = getLiveRuntimeInstanceId(baseResult);
    if (existingInstanceId && existingInstanceId !== 'n/a') {
      return baseResult;
    }
    if (!selectedProject || !hasAwsSecrets) {
      throw new Error('Deployment completed, but live runtime details are missing for this repo.');
    }

    const response = await fetch('/api/pipeline/runtime-details', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: selectedProject.id,
        aws_access_key_id: aws.aws_access_key_id,
        aws_secret_access_key: aws.aws_secret_access_key,
        aws_session_token: aws.aws_session_token,
        aws_region: terraformRuntimeConfig.aws_region,
        instance_id: extractDeploymentSummary(baseResult).instanceId !== 'n/a' ? extractDeploymentSummary(baseResult).instanceId : undefined,
      }),
    });
    const data = await response.json().catch(() => ({})) as { success?: boolean; details?: AwsRuntimeLiveDetails; error?: string };
    const hydratedInstanceId = String(data.details?.instance?.instance_id || '').trim();
    if (!response.ok || data.success !== true || !data.details || !hydratedInstanceId || hydratedInstanceId === 'n/a') {
      throw new Error(data.error || 'Deployment completed, but live runtime details could not be verified.');
    }
    return mergeDeployResultWithRuntimeDetails(baseResult, data.details);
  }, [aws.aws_access_key_id, aws.aws_secret_access_key, aws.aws_session_token, hasAwsSecrets, selectedProject, terraformRuntimeConfig.aws_region]);

  const reconcileDeploymentStatus = useCallback(async (runIdOverride?: string) => {
    if (!selectedProject) return;
    const response = await fetch('/api/pipeline/deploy/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: selectedProject.id, project_name: selectedProject.name, run_id: runIdOverride || deployResult?.run_id }),
    });
    const data = await response.json().catch(() => ({})) as DeployStatusResponse;
    if (!response.ok || data.success !== true) {
      throw new Error(data.error || 'Failed to fetch deployment status.');
    }

    const runtimeStatus = String(data.status || 'idle').toLowerCase();
    const runtimeResult = data.result && typeof data.result === 'object'
      ? data.result as DeployApiResult
      : null;

    if (['pending', 'selecting_params', 'validating', 'planning', 'applying', 'running'].includes(runtimeStatus)) {
      patchState((prev) => ({
        ...prev,
        status: 'running',
        progress: Math.max(prev.progress, 55),
        deployResult: runtimeResult || prev.deployResult,
      }));
      return;
    }

    if (runtimeStatus === 'completed' && runtimeResult?.success) {
      try {
        const hydratedResult = await hydrateTerminalDeployResult(runtimeResult);
        const hydratedChecks = normalizeVerificationChecks(hydratedResult.verification_checks);
        if (hydratedResult.deployment_verified === false || (hydratedChecks.length > 0 && hydratedChecks.every((check) => !check.ok))) {
          throw new Error(hydratedResult.error || 'Deployment verification failed for the current repo.');
        }
        patchState((prev) => ({
          ...prev,
          status: 'done',
          progress: 100,
          deployResult: hydratedResult,
        }));
        getOrCreateActiveDeployment(selectedProject.id).inFlight = false;
        pushDeploymentHistory(hydratedResult, 'done');
        appendLog('Recovered completed deployment state from backend runtime.', 'success');
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : 'Deployment completed, but runtime verification failed.';
        const errorResult: DeployApiResult = {
          ...((runtimeResult || {}) as DeployApiResult),
          success: false,
          error: runtimeResult?.error || message,
        };
        patchState((prev) => ({
          ...prev,
          status: 'error',
          progress: 100,
          deployResult: errorResult,
        }));
        getOrCreateActiveDeployment(selectedProject.id).inFlight = false;
        pushDeploymentHistory(errorResult, 'error');
        appendLog(message, 'error');
      }
      return;
    }

    if (runtimeStatus === 'completed' || runtimeStatus === 'error') {
      const message = runtimeResult?.error || 'Deployment runtime returned an error.';
      patchState((prev) => ({
        ...prev,
        status: 'error',
        progress: 100,
        deployResult: runtimeResult || prev.deployResult || { success: false, error: message },
      }));
      getOrCreateActiveDeployment(selectedProject.id).inFlight = false;
      pushDeploymentHistory(runtimeResult, 'error');
      appendLog(message, 'error');
      return;
    }

    patchState((prev) => ({
      ...prev,
      status: 'error',
      progress: 100,
      deployResult: prev.deployResult || { success: false, error: 'No active deployment process found.' },
    }));
    getOrCreateActiveDeployment(selectedProject.id).inFlight = false;
    appendLog('No active deployment process found. Marking stale UI run as stopped.', 'error');
  }, [appendLog, deployResult?.run_id, hydrateTerminalDeployResult, patchState, pushDeploymentHistory, selectedProject]);

  const startDeploy = useCallback(async () => {
    if (!selectedProject) {
      setError('Select a repository before starting deployment.');
      return;
    }
    // Capture before any patchState — clearing deployResult would flip this to false via the listener.
    const confirmingPlan = requiresPlanConfirmation
      || deployUiPhase === 'awaiting_plan'
      || Boolean(deployResult?.requires_plan_confirmation)
      || String(deployResult?.status || '').trim().toLowerCase() === 'awaiting_plan_confirmation';

    if (deployStartBlockers.length > 0) {
      const message = deployStartBlockers.join(' ');
      setError(message);
      appendLog(message, 'error');
      return;
    }

    const activeDeployment = getOrCreateActiveDeployment(selectedProject.id, {
      status: deployStatus,
      progress: deployProgress,
      logs: deployLogs,
      deployResult,
      deploymentHistory,
    });

    if (!confirmingPlan && (activeDeployment.inFlight || deployRequestRef.current === selectedProject.id)) {
      setError('Deployment already running in background for this project.');
      appendLog('Deployment already running in background for this project.');
      return;
    }
    // Stale inFlight after plan gate: allow confirm to proceed.
    if (confirmingPlan) {
      activeDeployment.inFlight = false;
      if (deployRequestRef.current === selectedProject.id) {
        deployRequestRef.current = null;
      }
    }

    const clearHeartbeat = () => {
      if (deployHeartbeatRef.current !== null) {
        window.clearInterval(deployHeartbeatRef.current);
        deployHeartbeatRef.current = null;
      }
      deployStartedAtRef.current = null;
    };

    // Fresh console on first start; keep plan logs when confirming apply.
    socketNoticeKeysRef.current.clear();
    setSocketNotices([]);
    activeDeployment.inFlight = true;
    deployRequestRef.current = selectedProject.id;
    setError(null);
    setEndpointChecks([]);
    // Leave plan-confirm mode immediately so the primary button disables while apply runs.
    if (confirmingPlan) {
      setRequiresPlanConfirmation(false);
      setPendingPlanSummary(null);
    }
    setDeployUiPhase('starting');
    setDeployElapsedSec(0);
    if (deployHeartbeatRef.current !== null) {
      window.clearInterval(deployHeartbeatRef.current);
      deployHeartbeatRef.current = null;
    }
    deployStartedAtRef.current = Date.now();
    deployHeartbeatRef.current = window.setInterval(() => {
      const startedAt = deployStartedAtRef.current;
      if (!startedAt) return;
      const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      setDeployElapsedSec(elapsed);
      if (elapsed > 0 && elapsed % 5 === 0) {
        appendLog(`Deploy still in progress… ${elapsed}s elapsed (waiting on backend).`, 'info');
      }
    }, 1000);

    patchState((prev) => ({
      ...prev,
      status: 'running',
      progress: confirmingPlan ? Math.max(prev.progress || 0, 65) : 5,
      logs: confirmingPlan
        ? [
            ...prev.logs,
            { text: 'Plan confirmed. Submitting Terraform apply…', ts: timestampLabel(), type: 'info' as const },
          ]
        : [{ text: 'Deploy started. Running preflight checks…', ts: timestampLabel(), type: 'info' as const }],
      // Keep prior result for continuity, but strip plan-gate flags so UI leaves confirm mode.
      deployResult: confirmingPlan
        ? {
            ...((prev.deployResult || {}) as DeployApiResult),
            requires_plan_confirmation: false,
            status: 'applying',
          }
        : null,
    }));
    if (!hasAwsSecrets) {
      clearHeartbeat();
      setDeployUiPhase('error');
      setError('AWS credentials are required before deployment.');
      patchState({
        status: 'error',
        progress: 100,
        deployResult: { success: false, error: 'AWS credentials are required before deployment.' },
      });
      appendLog('AWS credentials are missing. Configure them first.', 'error');
      activeDeployment.inFlight = false;
      deployRequestRef.current = null;
      return;
    }
    setDeployUiPhase('waiting_api');
    appendLog(confirmingPlan ? 'Submitting confirmed apply request…' : 'Preparing runtime deploy payload…');
    try {
      patchState({ progress: confirmingPlan ? 70 : 20 });
      if (confirmingPlan) {
        appendLog('Plan confirmation acknowledged. Calling /api/pipeline/deploy with confirm_plan_summary=true…', 'info');
      } else {
        setPendingPlanSummary(null);
      }
      appendLog('Calling /api/pipeline/deploy — Terraform apply can take 1–5 minutes…');
      const canReuseSavedRun = shouldUseSavedRunForDeploy;
      const runtimeDeployFiles = canReuseSavedRun ? [] : deployableIacFiles;
      if (runtimeDeployFiles.length === 0 && !canReuseSavedRun) {
        throw new Error('No valid Terraform bundle is loaded in the current session. Regenerate infrastructure before deploy.');
      }
      const response = await fetch('/api/pipeline/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: selectedProject.id,
          provider: 'aws',
          runtime_apply: true,
          service_type: deploymentPlanToServiceType(deploymentPlan),
          repo_context: repoContext || {},
          user_customizations: {
            ...infraUserAnswers,
            consultant_decision: approvedConsultantDecision || undefined,
            deployment_profile: deploymentProfile || undefined,
            deployment_plan: deploymentPlan,
            selected_components: selectedDeploymentComponents,
            customization_source: savedIacMeta?.source_metadata || undefined,
            ...rdsResourceConfig,
            db_name: rdsResourceConfig?.db_identifier,
            db_username: rdsResourceConfig?.master_username,
            db_password: rdsResourceConfig?.master_password,
          },
          run_id: canReuseSavedRun ? activeSavedRun?.run_id : undefined,
          workspace: canReuseSavedRun ? activeSavedRun?.workspace : undefined,
          state_bucket: terraformRuntimeConfig.state_bucket.trim() || undefined,
          lock_table: terraformRuntimeConfig.lock_table.trim() || undefined,
          files: runtimeDeployFiles,
          aws_access_key_id: aws.aws_access_key_id,
          aws_secret_access_key: aws.aws_secret_access_key,
          aws_session_token: aws.aws_session_token || undefined,
          aws_region: terraformRuntimeConfig.aws_region,
          confirm_plan_summary: confirmingPlan,
          user_answers: infraUserAnswers,
          estimated_monthly_usd: effectiveCostTotal,
          budget_limit_usd: effectiveBudgetCap,
          budget_override: budgetOverride,
          customization_snapshot_id: customizationSnapshotId || undefined,
          tenant_id: customizationTenantId || undefined,
          iac_source: savedIacMeta?.source_metadata || undefined,
          secrets_manager_prefix: secretsManagerPrefix,
          environment: String((deploymentProfile as { environment?: string } | null)?.environment || 'prod'),
        }),
      });
      const data = await response.json().catch(() => ({})) as DeployApiResult & { detail?: unknown };
      if (!response.ok || !data.success) {
        const detail = typeof data.detail === 'string' ? data.detail.trim() : '';
        const message = [data.error || `Deployment failed (HTTP ${response.status}).`, detail].filter(Boolean).join(' ');
        clearHeartbeat();
        setDeployUiPhase('error');
        patchState((prev) => ({
          ...prev,
          status: 'error',
          progress: 100,
          deployResult: data || { success: false, error: message },
        }));
        pushDeploymentHistory(data || null, 'error');
        appendLog(message, 'error');
        setError(message);
        return;
      }
      const awaitingPlanConfirmation = Boolean(
        data.requires_plan_confirmation
        || String(data.status || '').trim().toLowerCase() === 'awaiting_plan_confirmation',
      );
      if (awaitingPlanConfirmation) {
        const summary = (data.plan_summary as Record<string, unknown> | null | undefined) || null;
        clearHeartbeat();
        setRequiresPlanConfirmation(true);
        setPendingPlanSummary(summary);
        setDeployUiPhase('awaiting_plan');
        patchState((prev) => ({
          ...prev,
          status: 'idle',
          progress: Math.max(prev.progress, 60),
          deployResult: data,
        }));
        appendLog(summarizePlanResources(summary), 'info');
        appendLog('Terraform plan is ready. Click Confirm Plan & Deploy to continue apply.', 'info');
        return;
      }

      setRequiresPlanConfirmation(false);
      setPendingPlanSummary(null);
      setDeployUiPhase('reconciling');
      patchState((prev) => ({
        ...prev,
        status: 'running',
        progress: Math.max(prev.progress, 80),
        deployResult: data,
      }));
      appendLog('Runtime apply request returned. Waiting for backend runtime to reach a terminal state…');
      try {
        if (data.mode === 'iac_pipeline' && data.run_id) {
          appendLog('IaC pipeline started. Polling for completion…');
          const POLL_INTERVAL_MS = 3_000;
          const MAX_POLL_MS = 30 * 60 * 1_000; // 30 minutes
          const pollStart = Date.now();
          while (Date.now() - pollStart < MAX_POLL_MS) {
            await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
            try {
              await reconcileDeploymentStatus(data.run_id);
            } catch {
              // transient error — keep polling
            }
            if (!getOrCreateActiveDeployment(selectedProject.id).inFlight) break;
          }
        } else if (data.run_id) {
          await reconcileDeploymentStatus(data.run_id);
        } else {
          appendLog('Backend accepted the deploy request, but no run identifier was returned yet. Use Reconcile Backend Status if this state persists.', 'info');
        }
      } catch {
        patchState((prev) => ({
          ...prev,
          status: 'running',
          progress: Math.max(prev.progress, 90),
          deployResult: data,
        }));
        appendLog('Backend confirmation is still pending. Use Reconcile Backend Status if this state persists.', 'info');
      }
      clearHeartbeat();
      const latest = getOrCreateActiveDeployment(selectedProject.id).state;
      setDeployUiPhase(latest.status === 'error' ? 'error' : latest.status === 'done' ? 'done' : 'reconciling');
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Deployment failed.';
      clearHeartbeat();
      setDeployUiPhase('error');
      patchState((prev) => ({
        ...prev,
        status: 'error',
        progress: 100,
        deployResult: prev.deployResult || { success: false, error: message },
      }));
      appendLog(message, 'error');
      setError(message);
    } finally {
      if (deployRequestRef.current === selectedProject.id) {
        deployRequestRef.current = null;
      }
      activeDeployment.inFlight = false;
      if (deployHeartbeatRef.current !== null) {
        window.clearInterval(deployHeartbeatRef.current);
        deployHeartbeatRef.current = null;
      }
    }
  }, [activeSavedRun, appendLog, approvedConsultantDecision, aws.aws_access_key_id, aws.aws_secret_access_key, aws.aws_session_token, budgetOverride, effectiveBudgetCap, effectiveCostTotal, customizationSnapshotId, customizationTenantId, deployLogs, deployProgress, deployResult, deployStartBlockers, deployStatus, deployUiPhase, deployableIacFiles, deploymentHistory, deploymentPlan, deploymentProfile, hasAwsSecrets, infraUserAnswers, patchState, pushDeploymentHistory, reconcileDeploymentStatus, rdsResourceConfig, repoContext, requiresPlanConfirmation, savedIacMeta?.source_metadata, secretsManagerPrefix, selectedDeploymentComponents, selectedProject, shouldUseSavedRunForDeploy, terraformRuntimeConfig.aws_region, terraformRuntimeConfig.lock_table, terraformRuntimeConfig.state_bucket]);

  const stopDeployment = useCallback(async () => {
    if (!selectedProject || stopLoading || deployStatus !== 'running') return;
    setStopLoading(true);
    try {
      appendLog('Stop requested. Terminating deployment process...');
      const response = await fetch('/api/pipeline/deploy/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: selectedProject.id, project_name: selectedProject.name }),
      });
      const data = await response.json().catch(() => ({})) as { success?: boolean; message?: string; error?: string };
      if (!response.ok || data.success !== true) {
        const backendMessage = String(data.error || data.message || '');
        if (/no active deployment process found/i.test(backendMessage)) {
          await reconcileDeploymentStatus();
          appendLog('No active deployment process found on backend. UI state reconciled.', 'info');
          return;
        }
        throw new Error(backendMessage || 'Failed to stop deployment process.');
      }
      deployRequestRef.current = null;
      getOrCreateActiveDeployment(selectedProject.id).inFlight = false;
      const stopMessage = data.message || 'Deployment process terminated.';
      patchState((prev) => ({
        ...prev,
        status: 'error',
        progress: 100,
        deployResult: {
          ...((prev.deployResult || {}) as DeployApiResult),
          success: false,
          error: stopMessage,
        },
      }));
      appendLog(stopMessage, 'success');
    } catch (reason) {
      appendLog(reason instanceof Error ? reason.message : 'Failed to stop deployment process.', 'error');
    } finally {
      setStopLoading(false);
    }
  }, [appendLog, deployStatus, patchState, reconcileDeploymentStatus, selectedProject, stopLoading]);

  const fetchRuntimeDetails = useCallback(async () => {
    if (!selectedProject || !hasAwsSecrets) return;
    const response = await fetch('/api/pipeline/runtime-details', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: selectedProject.id,
        aws_access_key_id: aws.aws_access_key_id,
        aws_secret_access_key: aws.aws_secret_access_key,
        aws_session_token: aws.aws_session_token,
        aws_region: terraformRuntimeConfig.aws_region,
        instance_id: deploySummary.instanceId !== 'n/a' ? deploySummary.instanceId : undefined,
      }),
    });
    const data = await response.json().catch(() => ({})) as { success?: boolean; details?: AwsRuntimeLiveDetails; error?: string };
    if (!response.ok || !data.success || !data.details) {
      throw new Error(data.error || 'Failed to fetch runtime details.');
    }
    mergeRuntimeDetailsIntoResult(data.details);
    appendLog('Live AWS runtime details updated.', 'success');
  }, [appendLog, aws.aws_access_key_id, aws.aws_secret_access_key, aws.aws_session_token, deploySummary.instanceId, hasAwsSecrets, mergeRuntimeDetailsIntoResult, selectedProject, terraformRuntimeConfig.aws_region]);

  const verifyLiveEndpoints = useCallback(async () => {
    setVerifyLoading(true);
    try {
      const response = await fetch('/api/pipeline/deploy/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cloudfront_url: deploySummary.cloudfrontUrl !== 'n/a' ? deploySummary.cloudfrontUrl : '',
          app_url: deploySummary.appUrl !== 'n/a' ? deploySummary.appUrl : '',
          alb_dns_name: deploySummary.albDns !== 'n/a' ? deploySummary.albDns : '',
          elastic_ip: deploySummary.elasticIp !== 'n/a' ? deploySummary.elasticIp : '',
          public_ip: deploySummary.publicIp !== 'n/a' ? deploySummary.publicIp : '',
        }),
      });
      const data = await response.json().catch(() => ({})) as {
        success?: boolean;
        checks?: EndpointVerificationCheck[];
        error?: string;
      };
      if (!response.ok || data.success !== true) {
        throw new Error(data.error || 'Endpoint verification failed.');
      }
      const checks = Array.isArray(data.checks) ? data.checks : [];
      const verified = checks.length > 0 && checks.some((check) => check.ok);
      setEndpointChecks(checks);
      patchState((prev) => ({
        ...prev,
        deployResult: {
          ...((prev.deployResult || { success: deployStatus === 'done' }) as DeployApiResult),
          deployment_verified: verified,
          verification_checks: checks,
        },
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Endpoint verification failed.');
    } finally {
      setVerifyLoading(false);
    }
  }, [deployStatus, deploySummary.albDns, deploySummary.appUrl, deploySummary.cloudfrontUrl, deploySummary.elasticIp, deploySummary.publicIp, patchState]);

  const downloadPpk = useCallback(async () => {
    if (!deploySummary.generatedPem) return;
    const response = await fetch('/api/pipeline/keypair/ppk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ private_key_pem: deploySummary.generatedPem, key_name: deploySummary.keyName, project_name: selectedProject?.name }),
    });
    const data = await response.json().catch(() => ({})) as { success?: boolean; file_name?: string; content_base64?: string; error?: string; hint?: string };
    if (!response.ok || !data.success || !data.content_base64) {
      throw new Error(data.hint ? `${data.error || 'PPK conversion failed.'} ${data.hint}` : (data.error || 'PPK conversion failed.'));
    }
    const bytes = Uint8Array.from(atob(data.content_base64), (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = data.file_name || `${deploySummary.keyName}.ppk`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [deploySummary.generatedPem, deploySummary.keyName, selectedProject?.name]);

  const destroyDeployment = useCallback(async () => {
    if (!selectedProject || destroyLoading) return;
    if (deployStatus === 'running') {
      appendLog('Stop deployment first, then run destroy.', 'error');
      return;
    }
    if (!hasAwsSecrets) {
      appendLog('AWS credentials are missing. Configure them first.', 'error');
      return;
    }
    setDestroyLoading(true);
    try {
      const response = await fetch('/api/pipeline/deploy/destroy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: selectedProject.id,
          aws_access_key_id: aws.aws_access_key_id,
          aws_secret_access_key: aws.aws_secret_access_key,
          aws_session_token: aws.aws_session_token,
          aws_region: terraformRuntimeConfig.aws_region,
        }),
      });
      const data = await response.json().catch(() => ({})) as {
        success?: boolean;
        details?: {
          instances_terminated?: string[];
          s3_buckets_deleted?: string[];
          cloudfront_deleted?: string[];
          cloudfront_pending_disable?: string[];
          security_groups_deleted?: string[];
          volumes_deleted?: string[];
          errors?: string[];
        };
        error?: string;
      };
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Destroy failed.');
      }
      deployRequestRef.current = null;
      getOrCreateActiveDeployment(selectedProject.id).inFlight = false;
      patchState((prev) => ({
        ...prev,
        status: 'idle',
        progress: 0,
        deployResult: null,
      }));
      setEndpointChecks([]);
      const details = data.details || {};
      appendLog(
        `Destroy complete: ec2=${(details.instances_terminated || []).length}, s3=${(details.s3_buckets_deleted || []).length}, cloudfront=${(details.cloudfront_deleted || []).length}, sg=${(details.security_groups_deleted || []).length}, ebs=${(details.volumes_deleted || []).length}`,
        'success',
      );
      if ((details.cloudfront_pending_disable || []).length > 0) {
        appendLog(
          `CloudFront pending disable/delete: ${(details.cloudfront_pending_disable || []).join(', ')}. Re-run destroy after distributions are disabled/deployed.`,
          'info',
        );
      }
      for (const warning of (details.errors || []).slice(0, 5)) {
        appendLog(`Destroy warning: ${warning}`, 'error');
      }
    } finally {
      setDestroyLoading(false);
    }
  }, [appendLog, aws.aws_access_key_id, aws.aws_secret_access_key, aws.aws_session_token, deployStatus, destroyLoading, hasAwsSecrets, patchState, selectedProject, terraformRuntimeConfig.aws_region]);

  useEffect(() => {
    if (!selectedProject || deployStatus !== 'running') return;
    const activeDeployment = getOrCreateActiveDeployment(selectedProject.id);
    if (activeDeployment.inFlight) return;
    let cancelled = false;

    const probe = async () => {
      if (cancelled) return;
      try {
        await reconcileDeploymentStatus();
      } catch {
        // best-effort reconciliation while backend apply is in flight
      }
    };

    const timerId = window.setInterval(() => {
      void probe();
    }, 10_000);

    void probe();

    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [deployProgress, deployStatus, reconcileDeploymentStatus, selectedProject]);

  const showRegenerateTerraformButton =
    Boolean(selectedProject) &&
    /provided terraform bundle (is|appears) outdated|stale terraform bundle|default-vpc conditional mode|key pair reuse variable is missing/i.test(String(error || ''));
  const useLiveConsultantQa = true;
  const canContinueFromQa = Boolean(currentInfraConsultant?.decision && currentInfraConsultant?.confirmed);
  const advisorBudget = Number(currentInfraConsultant?.budget_cap_usd || costEstimate.cap || 0);
  const advisorEstimate = Number(currentInfraConsultant?.advisor_cost_estimate?.subtotal_monthly_usd || currentInfraConsultant?.budget_gate?.total_usd || 0);
  const advisorGateStatus = String(currentInfraConsultant?.budget_gate?.status || '').toUpperCase();
  const applyBudgetCap = useCallback((cap: number) => {
    const nextCap = Math.max(1, Number(cap) || 0);
    persistInfraConsultant({
      workspace: expectedWorkspace,
      history: currentInfraConsultant?.history || [],
      repo_detection_summary: currentInfraConsultant?.repo_detection_summary || '',
      turn_count: currentInfraConsultant?.turn_count || 0,
      decision: currentInfraConsultant?.decision || null,
      summary: currentInfraConsultant?.summary || '',
      confirmed: false,
      ready: false,
      budget_cap_usd: nextCap,
      selected_tier: currentInfraConsultant?.selected_tier || 'recommended',
      upgrade_suggestions: currentInfraConsultant?.upgrade_suggestions || [],
      budget_gate: currentInfraConsultant?.budget_gate,
      advisor_cost_estimate: currentInfraConsultant?.advisor_cost_estimate,
      requirements: currentInfraConsultant?.requirements,
    });
    writeStoredJson(COST_ESTIMATE_KEY, { total_monthly_usd: costEstimate.total, budget_cap_usd: nextCap });
    const message = `My monthly budget is $${nextCap}`;
    const priorHistory = currentInfraConsultant?.history || [];
    const nextHistory: InfraConsultantMessage[] = [...priorHistory, { role: 'user', content: message }];
    void runInfraConsultantTurn('reply', nextHistory, currentInfraConsultant?.decision || null).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Failed to apply budget.');
    });
  }, [costEstimate.total, currentInfraConsultant, expectedWorkspace, persistInfraConsultant, runInfraConsultantTurn]);

  const applySelectedTier = useCallback((tier: 'baseline' | 'recommended' | 'resilient') => {
    persistInfraConsultant({
      ...(currentInfraConsultant || {
        workspace: expectedWorkspace,
        history: [],
        repo_detection_summary: '',
        turn_count: 0,
        decision: null,
        summary: '',
        confirmed: false,
      }),
      workspace: expectedWorkspace,
      selected_tier: tier,
      confirmed: false,
      ready: false,
    });
    const label = tier === 'baseline' ? 'baseline' : tier === 'resilient' ? 'more resilient' : 'recommended';
    const message = `Switch to the ${label} plan`;
    const priorHistory = currentInfraConsultant?.history || [];
    const nextHistory: InfraConsultantMessage[] = [...priorHistory, { role: 'user', content: message }];
    void runInfraConsultantTurn('reply', nextHistory, currentInfraConsultant?.decision || null).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Failed to switch plan tier.');
    });
  }, [currentInfraConsultant, expectedWorkspace, persistInfraConsultant, runInfraConsultantTurn]);

  const qaLiveConsultantView = (
    <div className="mx-auto max-w-6xl space-y-6">
      <StageHeader
        title="Setup Advisor"
        description="Tell us your budget and who will use the app. We'll design AWS for you in plain language."
        actions={(
          <>
            <button
              onClick={() => {
                persistInfraConsultant({
                  workspace: expectedWorkspace,
                  history: [],
                  repo_detection_summary: '',
                  turn_count: 0,
                  decision: null,
                  summary: '',
                  confirmed: false,
                  ready: false,
                  budget_cap_usd: currentInfraConsultant?.budget_cap_usd,
                  selected_tier: 'recommended',
                  upgrade_suggestions: [],
                });
                setInfraConsultantInput('');
                void runInfraConsultantTurn('start', []).catch((reason: unknown) => {
                  setError(reason instanceof Error ? reason.message : 'Failed to start infra consultant.');
                });
              }}
              disabled={infraConsultantLoading || !selectedProject || !repoContext || repoContext.workspace !== expectedWorkspace}
              className={secondaryButtonClass(infraConsultantLoading || !selectedProject || !repoContext || repoContext.workspace !== expectedWorkspace)}
            >
              {currentInfraConsultant?.history?.length ? 'Restart' : 'Start'}
            </button>
            <button
              onClick={() => setAndPersistStage('architecture')}
              disabled={!canContinueFromQa}
              className={primaryButtonClass(!canContinueFromQa)}
            >
              Continue to Architecture
              <ArrowRight className="h-4 w-4" />
            </button>
          </>
        )}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Surface>
          <SurfaceLabel>Monthly estimate</SurfaceLabel>
          <div className="text-lg font-semibold text-zinc-100">${advisorEstimate.toFixed(2)}</div>
        </Surface>
        <Surface>
          <SurfaceLabel>Your budget</SurfaceLabel>
          <div className="text-lg font-semibold text-zinc-100">${advisorBudget > 0 ? advisorBudget.toFixed(2) : '—'}</div>
        </Surface>
        <Surface>
          <SurfaceLabel>Fit</SurfaceLabel>
          <div className={`text-lg font-semibold ${
            advisorGateStatus === 'PASS' ? 'text-emerald-300' : advisorGateStatus === 'WARN' ? 'text-amber-300' : advisorGateStatus === 'FAIL' ? 'text-rose-300' : 'text-zinc-400'
          }`}
          >
            {advisorGateStatus === 'PASS' ? 'Fits' : advisorGateStatus === 'WARN' ? 'Tight' : advisorGateStatus === 'FAIL' ? 'Over budget' : 'Pending'}
          </div>
        </Surface>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Surface className="col-span-1 flex min-h-112 flex-col overflow-hidden xl:col-span-2" padded={false}>
          <div className="border-b border-white/10 px-5 py-4">
            <div className="text-sm font-semibold text-zinc-100">Conversation</div>
            <div className="mt-1 text-xs text-zinc-500">No AWS jargon required — talk about budget, users, and how important uptime is.</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {[25, 50, 100, 250].map((cap) => (
                <button
                  key={cap}
                  type="button"
                  onClick={() => applyBudgetCap(cap)}
                  disabled={infraConsultantLoading || Boolean(currentInfraConsultant?.confirmed)}
                  className={`rounded-md border px-3 py-1.5 text-xs transition-colors disabled:opacity-50 ${
                    advisorBudget === cap
                      ? 'border-zinc-300 bg-zinc-100 text-zinc-900'
                      : 'border-white/10 bg-[#16161a] text-zinc-300 hover:border-white/25'
                  }`}
                >
                  ${cap}/mo
                </button>
              ))}
            </div>
          </div>
          <div className="custom-scrollbar deployment-scrollbar flex-1 space-y-4 overflow-y-auto p-5">
            {currentInfraConsultant?.history?.length ? currentInfraConsultant.history.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className={`max-w-[88%] rounded-lg border px-4 py-3 text-sm leading-relaxed ${
                  message.role === 'assistant'
                    ? 'border-white/10 bg-[#16161a] text-zinc-200'
                    : 'ml-auto border-white/10 bg-zinc-100 text-zinc-900'
                }`}
              >
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
                  {message.role === 'assistant' ? 'Advisor' : 'You'}
                </div>
                <div className="whitespace-pre-wrap">{message.content}</div>
              </div>
            )) : (
              <div className="text-sm text-zinc-500">
                {infraConsultantLoading ? 'Reviewing your project...' : 'Chat starts automatically. Pick a budget chip to begin.'}
              </div>
            )}
          </div>
          <div className="border-t border-white/10 p-4 space-y-3">
            {currentInfraConsultant?.decision && currentInfraConsultant.ready ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Proposed setup</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(currentInfraConsultant.decision.components || []).map((item, index) => (
                      <span key={`proposed-${index}-${String(item)}`} className="rounded-md border border-white/10 bg-[#16161a] px-2 py-0.5 text-[11px] text-zinc-300">
                        {formatComponentName(String(item))}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => approveInfraConsultantDecision()}
                    disabled={infraConsultantLoading || currentInfraConsultant.confirmed}
                    className={primaryButtonClass(infraConsultantLoading || currentInfraConsultant.confirmed)}
                  >
                    {currentInfraConsultant.confirmed ? 'Approved' : 'Approve this setup'}
                  </button>
                  <button
                    onClick={() => void rejectInfraConsultantDecision().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Failed to continue the infra conversation.'))}
                    disabled={infraConsultantLoading}
                    className={secondaryButtonClass(infraConsultantLoading)}
                  >
                    Keep refining
                  </button>
                </div>
              </div>
            ) : null}
            <div className="flex gap-3">
              <textarea
                value={infraConsultantInput}
                onChange={(event) => setInfraConsultantInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void submitInfraConsultantMessage().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Failed to continue the infra conversation.'));
                  }
                }}
                placeholder="e.g. for customers, around 100 users, keep my data safe"
                disabled={infraConsultantLoading || Boolean(currentInfraConsultant?.confirmed)}
                className="min-h-18 flex-1 resize-none rounded-lg border border-white/10 bg-[#09090b] px-4 py-3 text-sm text-zinc-200 outline-none transition-colors placeholder:text-zinc-600 focus:border-white/25 disabled:opacity-50"
              />
              <button
                onClick={() => void submitInfraConsultantMessage().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Failed to continue the infra conversation.'))}
                disabled={infraConsultantLoading || !infraConsultantInput.trim() || Boolean(currentInfraConsultant?.confirmed)}
                className={`${primaryButtonClass(infraConsultantLoading || !infraConsultantInput.trim() || Boolean(currentInfraConsultant?.confirmed))} self-end`}
              >
                {infraConsultantLoading ? 'Thinking...' : 'Send'}
              </button>
            </div>
          </div>
        </Surface>
        <div className="space-y-6">
          <Surface>
            <SurfaceLabel>Agent service decision</SurfaceLabel>
            {currentInfraConsultant?.decision ? (
              <div className="space-y-3">
                <div className="rounded-md border border-white/10 bg-[#09090b] px-3 py-3">
                  <div className="text-sm font-semibold text-zinc-100">
                    {plainServiceDecisionLabel(inferDeploymentPlanFromDecision(currentInfraConsultant.decision)).label}
                  </div>
                  <div className="mt-1 text-xs leading-relaxed text-zinc-500">
                    {plainServiceDecisionLabel(inferDeploymentPlanFromDecision(currentInfraConsultant.decision)).hint}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {normalizeDecisionComponents(currentInfraConsultant.decision).map((item, index) => (
                      <span key={`decision-component-${index}-${item}`} className="rounded-md border border-white/10 bg-[#16161a] px-2 py-0.5 text-[11px] text-zinc-300">
                        {formatComponentName(item)}
                      </span>
                    ))}
                  </div>
                  {(deploymentServices.rds || deploymentServices.redis) ? (
                    <div className="mt-2 text-[11px] text-zinc-500">
                      Add-ons: {[deploymentServices.rds ? 'managed database' : null, deploymentServices.redis ? 'managed cache' : null].filter(Boolean).join(' · ')}
                    </div>
                  ) : null}
                </div>
                <details className="rounded-md border border-white/10 bg-[#09090b] px-3 py-2">
                  <summary className="cursor-pointer text-xs text-zinc-400">Override service type (optional)</summary>
                  <div className="mt-3 space-y-2">
                    {DEPLOYMENT_PLAN_OPTIONS.map((option) => {
                      const selected = deploymentPlan === option.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => handleDeploymentPlanChange(option.id)}
                          disabled={infraConsultantLoading || Boolean(currentInfraConsultant?.confirmed)}
                          className={`w-full rounded-md border px-3 py-2 text-left text-xs transition-colors disabled:opacity-50 ${
                            selected
                              ? 'border-zinc-300 bg-zinc-100 text-zinc-900'
                              : 'border-white/10 text-zinc-300 hover:border-white/25'
                          }`}
                        >
                          <div className="font-medium">{plainServiceDecisionLabel(option.id).label}</div>
                          <div className={selected ? 'text-zinc-600' : 'text-zinc-500'}>{plainServiceDecisionLabel(option.id).hint}</div>
                        </button>
                      );
                    })}
                    <div className="grid grid-cols-2 gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => handleDeploymentServiceToggle('rds')}
                        disabled={infraConsultantLoading || Boolean(currentInfraConsultant?.confirmed) || deploymentPlan === 's3_cloudfront'}
                        className={`rounded-md border px-2 py-2 text-left text-[11px] disabled:opacity-50 ${
                          deploymentServices.rds ? 'border-zinc-300 bg-zinc-100 text-zinc-900' : 'border-white/10 text-zinc-400'
                        }`}
                      >
                        Managed database
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeploymentServiceToggle('redis')}
                        disabled={infraConsultantLoading || Boolean(currentInfraConsultant?.confirmed) || deploymentPlan === 's3_cloudfront'}
                        className={`rounded-md border px-2 py-2 text-left text-[11px] disabled:opacity-50 ${
                          deploymentServices.redis ? 'border-zinc-300 bg-zinc-100 text-zinc-900' : 'border-white/10 text-zinc-400'
                        }`}
                      >
                        Managed cache
                      </button>
                    </div>
                  </div>
                </details>
              </div>
            ) : (
              <div className="text-sm text-zinc-500">The advisor will choose the service shape after budget and a few answers.</div>
            )}
          </Surface>

          {deploymentPlan === 'ec2' ? (
            <Surface>
              <SurfaceLabel>Suggested settings</SurfaceLabel>
              <div className="mb-3 text-xs text-zinc-500">Filled by the agent — change anything you want.</div>
              <div className="space-y-3">
                <label className="block text-xs text-zinc-400">
                  Server size
                  <select
                    value={ec2ResourceConfig.instance_type}
                    onChange={(event) => handleEc2ResourceConfigChange({ instance_type: event.target.value as Ec2ResourceConfig['instance_type'] })}
                    disabled={infraConsultantLoading || Boolean(currentInfraConsultant?.confirmed)}
                    className="mt-1 w-full rounded-md border border-white/10 bg-[#09090b] px-3 py-2 text-sm text-zinc-200 outline-none focus:border-white/25 disabled:opacity-50"
                  >
                    {EC2_INSTANCE_TYPES.map((item) => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs text-zinc-400">
                  Disk (GB)
                  <input
                    type="number"
                    min={20}
                    max={200}
                    value={ec2ResourceConfig.root_volume_size_gb}
                    onChange={(event) => handleEc2ResourceConfigChange({ root_volume_size_gb: Number(event.target.value) })}
                    disabled={infraConsultantLoading || Boolean(currentInfraConsultant?.confirmed)}
                    className="mt-1 w-full rounded-md border border-white/10 bg-[#09090b] px-3 py-2 text-sm text-zinc-200 outline-none focus:border-white/25 disabled:opacity-50"
                  />
                </label>
                <label className="block text-xs text-zinc-400">
                  App port
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={ec2ResourceConfig.app_port}
                    onChange={(event) => handleEc2ResourceConfigChange({ app_port: Number(event.target.value) })}
                    disabled={infraConsultantLoading || Boolean(currentInfraConsultant?.confirmed)}
                    className="mt-1 w-full rounded-md border border-white/10 bg-[#09090b] px-3 py-2 text-sm text-zinc-200 outline-none focus:border-white/25 disabled:opacity-50"
                  />
                </label>
              </div>
            </Surface>
          ) : null}

          {deploymentPlan === 'ecs_fargate' ? (
            <Surface>
              <SurfaceLabel>Suggested settings</SurfaceLabel>
              <div className="mb-3 text-xs text-zinc-500">Filled by the agent — change anything you want.</div>
              <div className="grid grid-cols-3 gap-2">
                <label className="block text-xs text-zinc-400">
                  CPU
                  <input
                    type="number"
                    value={ecsResourceConfig.cpu}
                    onChange={(event) => handleEcsResourceConfigChange({ cpu: Number(event.target.value) })}
                    disabled={infraConsultantLoading || Boolean(currentInfraConsultant?.confirmed)}
                    className="mt-1 w-full rounded-md border border-white/10 bg-[#09090b] px-2 py-2 text-sm text-zinc-200 outline-none disabled:opacity-50"
                  />
                </label>
                <label className="block text-xs text-zinc-400">
                  Memory
                  <input
                    type="number"
                    value={ecsResourceConfig.memory}
                    onChange={(event) => handleEcsResourceConfigChange({ memory: Number(event.target.value) })}
                    disabled={infraConsultantLoading || Boolean(currentInfraConsultant?.confirmed)}
                    className="mt-1 w-full rounded-md border border-white/10 bg-[#09090b] px-2 py-2 text-sm text-zinc-200 outline-none disabled:opacity-50"
                  />
                </label>
                <label className="block text-xs text-zinc-400">
                  Tasks
                  <input
                    type="number"
                    value={ecsResourceConfig.desired_count}
                    onChange={(event) => handleEcsResourceConfigChange({ desired_count: Number(event.target.value) })}
                    disabled={infraConsultantLoading || Boolean(currentInfraConsultant?.confirmed)}
                    className="mt-1 w-full rounded-md border border-white/10 bg-[#09090b] px-2 py-2 text-sm text-zinc-200 outline-none disabled:opacity-50"
                  />
                </label>
              </div>
            </Surface>
          ) : null}

          {deploymentServices.rds && deploymentPlan !== 's3_cloudfront' ? (
            <Surface>
              <SurfaceLabel>Suggested database</SurfaceLabel>
              <div className="mb-3 text-xs text-zinc-500">Agent pick — editable.</div>
              <div className="space-y-3">
                <label className="block text-xs text-zinc-400">
                  Engine
                  <select
                    value={rdsResourceConfig.engine}
                    onChange={(event) => handleRdsResourceConfigChange({ engine: event.target.value as RdsResourceConfig['engine'] })}
                    disabled={infraConsultantLoading || Boolean(currentInfraConsultant?.confirmed)}
                    className="mt-1 w-full rounded-md border border-white/10 bg-[#09090b] px-3 py-2 text-sm text-zinc-200 outline-none focus:border-white/25 disabled:opacity-50"
                  >
                    {RDS_ENGINES.map((item) => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs text-zinc-400">
                  Instance class
                  <select
                    value={rdsResourceConfig.instance_class}
                    onChange={(event) => handleRdsResourceConfigChange({ instance_class: event.target.value })}
                    disabled={infraConsultantLoading || Boolean(currentInfraConsultant?.confirmed)}
                    className="mt-1 w-full rounded-md border border-white/10 bg-[#09090b] px-3 py-2 text-sm text-zinc-200 outline-none focus:border-white/25 disabled:opacity-50"
                  >
                    {(RDS_ENGINE_META[rdsResourceConfig.engine]?.instanceClasses || [rdsResourceConfig.instance_class]).map((item) => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                </label>
              </div>
            </Surface>
          ) : null}

          {deploymentServices.redis && deploymentPlan !== 's3_cloudfront' ? (
            <Surface>
              <SurfaceLabel>Suggested cache</SurfaceLabel>
              <div className="mb-3 text-xs text-zinc-500">Agent pick — editable.</div>
              <label className="block text-xs text-zinc-400">
                Node type
                <select
                  value={redisResourceConfig.node_type}
                  onChange={(event) => handleRedisResourceConfigChange({ node_type: event.target.value })}
                  disabled={infraConsultantLoading || Boolean(currentInfraConsultant?.confirmed)}
                  className="mt-1 w-full rounded-md border border-white/10 bg-[#09090b] px-3 py-2 text-sm text-zinc-200 outline-none focus:border-white/25 disabled:opacity-50"
                >
                  {REDIS_NODE_TYPES.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </label>
            </Surface>
          ) : null}

          <Surface>
            <SurfaceLabel>Plan level</SurfaceLabel>
            <div className="space-y-2">
              {([
                { id: 'baseline' as const, label: 'Simple', hint: 'Lowest cost' },
                { id: 'recommended' as const, label: 'Balanced', hint: 'Best default' },
                { id: 'resilient' as const, label: 'Stay-online', hint: 'More protection' },
              ]).map((tier) => {
                const selected = (currentInfraConsultant?.selected_tier || 'recommended') === tier.id;
                return (
                  <button
                    key={tier.id}
                    type="button"
                    onClick={() => applySelectedTier(tier.id)}
                    disabled={infraConsultantLoading || Boolean(currentInfraConsultant?.confirmed)}
                    className={`w-full rounded-md border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${
                      selected
                        ? 'border-zinc-300 bg-zinc-100 text-zinc-900'
                        : 'border-white/10 bg-[#09090b] text-zinc-300 hover:border-white/25'
                    }`}
                  >
                    <div className="text-sm font-medium">{tier.label}</div>
                    <div className={`text-xs ${selected ? 'text-zinc-600' : 'text-zinc-500'}`}>{tier.hint}</div>
                  </button>
                );
              })}
            </div>
          </Surface>
          <Surface>
            <SurfaceLabel>Upgrade ideas</SurfaceLabel>
            {(currentInfraConsultant?.upgrade_suggestions || []).length > 0 ? (
              <div className="space-y-2">
                {(currentInfraConsultant?.upgrade_suggestions || []).map((item, index) => (
                  <button
                    key={`${item.tier || item.title}-${index}`}
                    type="button"
                    onClick={() => {
                      const extra = Number(item.extra_monthly_usd || 0);
                      if (extra > 0 && advisorBudget > 0) {
                        applyBudgetCap(Math.ceil(advisorBudget + extra));
                      } else if (item.tier === 'baseline' || item.tier === 'recommended' || item.tier === 'resilient') {
                        applySelectedTier(item.tier);
                      }
                    }}
                    disabled={infraConsultantLoading || Boolean(currentInfraConsultant?.confirmed)}
                    className="w-full rounded-md border border-white/10 bg-[#09090b] px-3 py-3 text-left transition-colors hover:border-white/25 disabled:opacity-50"
                  >
                    <div className="text-sm font-medium text-zinc-100">
                      +${Number(item.extra_monthly_usd || 0).toFixed(0)}/mo · {item.title || 'Upgrade'}
                    </div>
                    <div className="mt-1 text-xs leading-relaxed text-zinc-500">{item.plain_benefit || ''}</div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-sm text-zinc-500">Upgrade suggestions appear once a budget and plan exist.</div>
            )}
          </Surface>
          <Surface>
            <SurfaceLabel>Status</SurfaceLabel>
            <div className="text-sm text-zinc-200">
              {currentInfraConsultant?.confirmed ? 'Approved' : currentInfraConsultant?.ready ? 'Ready to approve' : infraConsultantLoading ? 'Working' : 'In progress'}
            </div>
            <div className="mt-2 text-xs text-zinc-500">
              Tier: <span className="text-zinc-300">{currentInfraConsultant?.selected_tier || 'recommended'}</span>
            </div>
          </Surface>
        </div>
      </div>
    </div>
  );
  const decisionNodePositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number; height: number }>();
    for (const node of decisionDiagram.nodes) {
      map.set(node.id, { x: node.x, y: node.y, height: getDecisionNodeHeight(node) });
    }
    return map;
  }, [decisionDiagram.nodes]);
  const decisionDiagramCanvas = (
    <svg viewBox={`0 0 980 ${decisionDiagram.hasPrivateTier ? 520 : 360}`} className="w-full rounded-xl bg-[#0c0c0e]">
      <defs>
        <marker id="decision-flow-arrow" markerWidth="7" markerHeight="5" refX="6" refY="2.5" orient="auto">
          <polygon points="0 0, 7 2.5, 0 5" fill="#52525b" />
        </marker>
        <linearGradient id="decision-canvas-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#141417" />
          <stop offset="100%" stopColor="#0c0c0e" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="980" height={decisionDiagram.hasPrivateTier ? 520 : 360} fill="url(#decision-canvas-fade)" />
      {decisionDiagram.hasVpcBoundary ? (
        <>
          <rect
            x="190"
            y="48"
            width="740"
            height={decisionDiagram.hasPrivateTier ? 420 : 260}
            rx="18"
            fill="rgba(255,255,255,0.015)"
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="1"
          />
          <text x="214" y="76" fill="#71717a" fontSize="11" style={{ fontFamily: 'var(--font-display, sans-serif)' }}>
            VPC · {decisionDiagram.awsRegion}
          </text>
          <rect
            x="220"
            y="100"
            width="680"
            height={decisionDiagram.hasPrivateTier ? 170 : 180}
            rx="14"
            fill="rgba(255,255,255,0.02)"
            stroke="rgba(255,255,255,0.08)"
          />
          <text x="240" y="124" fill="#52525b" fontSize="10" letterSpacing="0.08em" style={{ fontFamily: 'var(--font-mono, monospace)' }}>
            PUBLIC
          </text>
          {decisionDiagram.hasPrivateTier ? (
            <>
              <rect x="220" y="292" width="680" height="150" rx="14" fill="rgba(255,255,255,0.012)" stroke="rgba(255,255,255,0.06)" />
              <text x="240" y="316" fill="#52525b" fontSize="10" letterSpacing="0.08em" style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                PRIVATE{decisionDiagram.hasMultiAz ? ' · MULTI-AZ' : ''}
              </text>
            </>
          ) : null}
        </>
      ) : null}
      {decisionDiagram.edges.map((edge, index) => {
        const from = decisionNodePositions.get(edge.from);
        const to = decisionNodePositions.get(edge.to);
        if (!from || !to) return null;
        return (
          <line
            key={`${edge.from}-${edge.to}-${index}`}
            x1={from.x + 64}
            y1={from.y + (from.height / 2)}
            x2={to.x + 64}
            y2={to.y + (to.height / 2)}
            stroke="rgba(255,255,255,0.18)"
            strokeWidth="1.25"
            markerEnd="url(#decision-flow-arrow)"
          />
        );
      })}
      {Array.from(new Map(decisionDiagram.nodes.map((node) => [node.id, node])).values()).map((node) => {
        const details = node.details.slice(0, 2);
        const height = getDecisionNodeHeight(node);
        const isInternet = node.id === 'internet';
        return (
          <g key={node.id} transform={`translate(${node.x},${node.y})`}>
            <rect
              width="128"
              height={height}
              rx="12"
              fill={isInternet ? '#16161a' : '#111113'}
              stroke={isInternet ? 'rgba(255,255,255,0.16)' : `${node.color}55`}
              strokeWidth="1"
            />
            <circle cx="18" cy="18" r="3.5" fill={node.color} opacity="0.9" />
            <text
              x="64"
              y={details.length ? 22 : height / 2 + 4}
              textAnchor="middle"
              fill="#f4f4f5"
              fontSize="12"
              fontWeight="600"
              style={{ fontFamily: 'var(--font-display, sans-serif)' }}
            >
              {node.label}
            </text>
            {details.map((line, index) => (
              <text
                key={`${node.id}-detail-${index}`}
                x="64"
                y={40 + index * 14}
                textAnchor="middle"
                fill="#a1a1aa"
                fontSize="10"
                style={{ fontFamily: 'var(--font-mono, monospace)' }}
              >
                {line}
              </text>
            ))}
          </g>
        );
      })}
    </svg>
  );
  const decisionCostRows = decisionCostEstimate?.line_items || [];
  const decisionCostSubtotal = Number(decisionCostEstimate?.subtotal_monthly_usd || 0);
  const decisionCostVariance = String(decisionCostEstimate?.variance_note || 'Estimated monthly cost can vary by +/-20% depending on runtime usage.');
  const decisionCostBasedOnDecision = decisionCostEstimate?.based_on_decision !== false;
  return (
    <div className="deployment-workspace flex h-screen overflow-hidden bg-[#09090b] font-sans text-zinc-300">
      <style dangerouslySetInnerHTML={{ __html: DEPLOYMENT_WORKSPACE_STYLE }} />
      <aside className="flex h-full w-64 shrink-0 flex-col border-r border-white/10 bg-[#09090b]">
        <div className="flex h-14 items-center border-b border-white/10 px-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md border border-white/10 bg-[#16161a] text-[10px] font-bold tracking-[0.12em] text-zinc-100" style={{ fontFamily: 'var(--font-display)' }}>
              DL
            </div>
            <div>
              <div className="text-sm font-semibold tracking-[0.08em] text-zinc-50" style={{ fontFamily: 'var(--font-display)' }}>DeplAI</div>
              <div className="text-[10px] uppercase tracking-[0.16em] text-zinc-600">Deployment</div>
            </div>
          </div>
        </div>
        <div className="deployment-scrollbar custom-scrollbar flex-1 space-y-0.5 overflow-y-auto px-2.5 py-4">
          {(() => {
            const activeIndex = SIDEBAR_STAGES.findIndex((s) => s.id === activeStage);
            return SIDEBAR_STAGES.map((stage, idx) => {
              const isActive = activeStage === stage.id;
              const isDone = idx < activeIndex;
              return (
                <button
                  key={stage.id}
                  onClick={() => setAndPersistStage(stage.id)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                    isActive
                      ? 'bg-[#16161a] text-zinc-50 ring-1 ring-white/10'
                      : isDone
                        ? 'text-zinc-400 hover:bg-white/[0.03]'
                        : 'text-zinc-600 hover:bg-white/[0.03]'
                  }`}
                >
                  <div className="flex shrink-0 items-center justify-center">
                    {isActive
                      ? <CircleDashed className="h-4 w-4 animate-spin text-zinc-300" />
                      : isDone
                        ? <div className="flex h-4 w-4 items-center justify-center rounded-full bg-zinc-200"><svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1.5 4l2 2 3-3" stroke="#09090b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
                        : <div className="h-4 w-4 rounded-full border border-zinc-700" />}
                  </div>
                  <div>
                    <div className="text-[13px] font-medium">{stage.label}</div>
                    <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-600">{stage.details}</div>
                  </div>
                </button>
              );
            });
          })()}
        </div>
      </aside>
      <div className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center justify-between border-b border-white/10 bg-[#09090b] px-6">
          <div className="flex items-center gap-2 text-sm">
            <button onClick={() => router.push('/dashboard')} className="font-medium text-zinc-500 hover:text-zinc-200">Dashboard</button>
            <ChevronRight className="h-4 w-4 text-zinc-700" />
            <span className="font-medium text-zinc-100">{SIDEBAR_STAGES.find((stage) => stage.id === activeStage)?.label}</span>
          </div>
          {selectedProject && (
            <div className="flex items-center gap-3">
              <span className="rounded-md border border-white/10 bg-[#111113] px-3 py-1.5 font-mono text-xs text-zinc-400">{selectedProject.name}</span>
              <button onClick={() => router.push('/dashboard')} className="text-xs font-semibold text-zinc-500 hover:text-zinc-200">Exit</button>
            </div>
          )}
        </header>
        <div className="deployment-scrollbar custom-scrollbar flex-1 overflow-y-auto p-6 lg:p-8">
          {error && (
            <div className="mx-auto mb-6 flex max-w-5xl items-center justify-between gap-4 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-300">
              <div>{error}</div>
              {showRegenerateTerraformButton ? (
                <button
                  onClick={() => {
                    setAndPersistStage('terraform');
                    resetCurrentIacSessionArtifacts();
                    void generateTerraform().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Infrastructure generation failed.'));
                  }}
                  className="shrink-0 rounded-md border border-red-400/30 bg-red-500/20 px-4 py-2 text-xs font-semibold text-red-100 hover:bg-red-500/30"
                >
                  Regenerate Terraform
                </button>
              ) : null}
            </div>
          )}
          {activeStage === 'analysis' && (
            <div className="mx-auto max-w-5xl space-y-6">
              {!projectsLoaded ? (
                <div className="flex min-h-[400px] items-center justify-center">
                  <div className="animate-pulse text-sm font-medium text-zinc-400">Loading workspace data...</div>
                </div>
              ) : selectedProject ? (
                <>
                  <StageHeader
                    title="Repository Analysis"
                    description={
                      analysisLoading
                        ? 'Scanning the repository for frameworks, data stores, and container/orchestration signals.'
                        : 'Inventory of what this project already uses — frameworks, databases, containers, and cluster config.'
                    }
                    actions={(
                      <button
                        onClick={() => setAndPersistStage('qa')}
                        disabled={analysisLoading || !repoContext || repoContext.workspace !== expectedWorkspace}
                        className={primaryButtonClass(analysisLoading || !repoContext || repoContext.workspace !== expectedWorkspace)}
                      >
                        {analysisLoading ? 'Scanning Repository...' : 'Continue to Questions'}
                        <ArrowRight className="h-4 w-4" />
                      </button>
                    )}
                  />

                  {analysisLoading ? (
                    <Surface>
                      <div className="text-sm text-zinc-400">Scanning codebase and waiting for Agentic Layer...</div>
                    </Surface>
                  ) : repoContext ? (
                    <div className="space-y-4">
                      <Surface>
                        <SurfaceLabel>Runtime</SurfaceLabel>
                        <div className="text-base text-zinc-100">{String(repoContext.language?.runtime || 'Unknown')}</div>
                        <div className="mt-2 space-y-1 text-sm text-zinc-500">
                          <div>Workspace: <span className="font-mono text-zinc-300">{repoContext.workspace}</span></div>
                          {String(repoContext.build?.build_command || '').trim() ? (
                            <div>Build: <span className="font-mono text-zinc-300">{String(repoContext.build?.build_command)}</span></div>
                          ) : null}
                          {String(repoContext.build?.start_command || '').trim() ? (
                            <div>Start: <span className="font-mono text-zinc-300">{String(repoContext.build?.start_command)}</span></div>
                          ) : null}
                          {String(repoContext.health?.endpoint || '').trim() ? (
                            <div>Health: <span className="font-mono text-zinc-300">{String(repoContext.health?.endpoint)}</span></div>
                          ) : null}
                        </div>
                      </Surface>

                      <Surface>
                        <SurfaceLabel>Frameworks & dependencies</SurfaceLabel>
                        {analysisFrameworkDetails.length > 0 ? (
                          <ul className="space-y-2 text-sm text-zinc-300">
                            {analysisFrameworkDetails.map((item, index) => (
                              <li key={`${item.name}-${item.role || 'unknown'}-${index}`} className="flex flex-wrap gap-x-3 gap-y-1">
                                <span className="font-medium text-zinc-100">{item.name}</span>
                                {item.role ? <span className="text-zinc-500">{item.role}</span> : null}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="text-sm text-zinc-500">None detected</div>
                        )}
                      </Surface>

                      <Surface>
                        <SurfaceLabel>Data stores</SurfaceLabel>
                        {analysisDataStoreDetails.length > 0 ? (
                          <ul className="space-y-2 text-sm text-zinc-300">
                            {analysisDataStoreDetails.map((item, index) => (
                              <li key={`${item.type}-${item.version || 'unknown'}-${index}`} className="flex flex-wrap gap-x-3 gap-y-1">
                                <span className="font-medium text-zinc-100">{item.type}</span>
                                {item.version ? <span className="font-mono text-zinc-500">{item.version}</span> : null}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="text-sm text-zinc-500">None detected</div>
                        )}
                      </Surface>

                      <Surface>
                        <SurfaceLabel>Containers & orchestration</SurfaceLabel>
                        <ul className="space-y-2 text-sm text-zinc-300">
                          <li>Dockerfile: {analysisInfraHints.hasDockerfile ? 'yes' : 'no'}</li>
                          <li>Docker Compose: {analysisInfraHints.hasCompose ? 'yes' : 'no'}</li>
                          <li>Kubernetes manifests: {analysisInfraHints.hasKubernetes ? 'yes' : 'no'}</li>
                          <li>Helm charts: {analysisInfraHints.hasHelm ? 'yes' : 'no'}</li>
                          {analysisInfraHints.isMonorepo ? <li>Monorepo layout detected</li> : null}
                          {analysisInfraHints.isServerless ? <li>Serverless config detected</li> : null}
                        </ul>
                        {analysisInfraHints.composeImages.length > 0 ? (
                          <div className="mt-4">
                            <div className="mb-2 text-xs text-zinc-500">Compose / referenced images</div>
                            <ul className="space-y-1 font-mono text-xs text-zinc-400">
                              {analysisInfraHints.composeImages.map((image, index) => (
                                <li key={`compose-image-${index}-${image}`}>{image}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </Surface>

                      {analysisProcessLines.length > 0 ? (
                        <Surface>
                          <SurfaceLabel>Processes</SurfaceLabel>
                          <ul className="space-y-2 font-mono text-xs text-zinc-400">
                            {analysisProcessLines.map((line, index) => (
                              <li key={`process-${index}-${line}`}>{line}</li>
                            ))}
                          </ul>
                        </Surface>
                      ) : null}

                      {(analysisSecretNames.length > 0 || analysisConfigNames.length > 0 || analysisFlagLines.length > 0) ? (
                        <Surface>
                          <SurfaceLabel>Secrets, config & flags</SurfaceLabel>
                          <div className="space-y-2 text-sm text-zinc-300">
                            {analysisSecretNames.length > 0 ? (
                              <div>Required secrets: <span className="font-mono text-xs text-zinc-400">{analysisSecretNames.join(', ')}</span></div>
                            ) : null}
                            {analysisConfigNames.length > 0 ? (
                              <div>Config values: <span className="font-mono text-xs text-zinc-400">{analysisConfigNames.join(', ')}</span></div>
                            ) : null}
                            {analysisFlagLines.map((line, index) => (
                              <div key={`flag-${index}-${line}`} className="text-amber-300/90">{line}</div>
                            ))}
                          </div>
                        </Surface>
                      ) : null}

                      {String(repoContext.summary || '').trim() ? (
                        <Surface>
                          <SurfaceLabel>Summary</SurfaceLabel>
                          <p className="text-sm leading-relaxed text-zinc-400">{String(repoContext.summary)}</p>
                        </Surface>
                      ) : null}
                    </div>
                  ) : (
                    <Surface>
                      <div className="text-sm text-zinc-500">No analysis yet. Re-open this stage after selecting a repository.</div>
                    </Surface>
                  )}
                </>
              ) : (
                <Surface>
                  <h1 className="mb-2 text-2xl font-semibold text-zinc-100">Choose a Repository from the Dashboard</h1>
                  <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
                    Deployment Track only runs against a specific repository. Start from a repo card on the dashboard so the AWS deployment flow is bound to the correct project.
                  </p>
                  <div className="mt-6">
                    <button onClick={() => router.push('/dashboard')} className={primaryButtonClass(false)}>
                      Back to Dashboard
                    </button>
                  </div>
                </Surface>
              )}
            </div>
          )}

          {activeStage === 'qa' && (
            useLiveConsultantQa ? qaLiveConsultantView : (
            <div className="mx-auto max-w-6xl space-y-6">
              <div className="border-b border-[#1A1A1A] py-6">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Deployment Questions</h1>
                    <p className="text-sm text-zinc-400">
                      {reviewLoading
                        ? 'Preparing deployment questions from repository analysis.'
                        : 'Answer the required deployment questions so DeplAI can generate an AWS architecture and Terraform plan.'}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] px-4 py-3">
                      <div className="text-xs font-semibold tracking-wide text-zinc-500">Required</div>
                      <div className="mt-1 text-xl font-semibold text-zinc-100">{answeredRequiredCount}/{requiredQuestions.length || 0}</div>
                    </div>
                    <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] px-4 py-3">
                    </div>
                  </div>
                </div>
              </div>
              {reviewLoading ? (
                <>
                  <div className="space-y-4">
                    {Array.from({ length: 4 }).map((_, index) => (
                      <div key={index} className="animate-pulse rounded-2xl border border-[#1A1A1A] bg-[#050505] p-6">
                        <div className="mb-4 h-3 w-24 rounded bg-[#111111]" />
                        <div className="mb-3 h-6 w-3/4 rounded bg-[#111111]" />
                        <div className="h-10 w-full rounded bg-[#111111]" />
                      </div>
                    ))}
                  </div>
                  <div className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-6 text-sm text-zinc-400">
                    Building the deployment questionnaire from repository analysis...
                  </div>
                </>
              ) : review ? (
                <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
                  <div className="space-y-6">
                    <div className="grid gap-4 md:grid-cols-3">
                      <div className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-5">
                        <div className="text-xs font-semibold tracking-wide text-zinc-500">Repository</div>
                        <div className="mt-2 text-sm font-medium text-zinc-100">{selectedProject?.name || 'Unknown project'}</div>
                        <div className="mt-2 text-xs text-zinc-500">{String(repoContext?.language?.runtime || 'Unknown runtime')}</div>
                      </div>
                      <div className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-5">
                        <div className="text-xs font-semibold tracking-wide text-zinc-500">Detected Stack</div>
                        <div className="mt-2 text-sm text-zinc-200">
                          {analysisFrameworkNames.length > 0 ? analysisFrameworkNames.join(' / ') : 'Frameworks not detected'}
                        </div>
                        <div className="mt-2 text-xs text-zinc-500">
                          {analysisDataStoreNames.length > 0 ? `Data: ${analysisDataStoreNames.join(', ')}` : 'No managed datastore detected'}
                        </div>
                      </div>
                      <div className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-5">
                        <div className="text-xs font-semibold tracking-wide text-zinc-500">Question Scope</div>
                        <div className="mt-2 text-sm text-zinc-200">{reviewQuestions.length} total questions</div>
                        <div className="mt-2 text-xs text-zinc-500">{optionalQuestionCount} optional</div>
                      </div>
                    </div>

                    {groupedQuestions.map(([category, questions]) => (
                      <section key={category} className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-6">
                        <div className="mb-5 flex items-center justify-between gap-4">
                          <div>
                            <div className="text-xs font-semibold tracking-wide text-zinc-500">{category}</div>
                            <div className="mt-1 text-sm text-zinc-400">
                              {questions.filter((question) => String(answers[question.id] || '').trim()).length}/{questions.length} answered
                            </div>
                          </div>
                          <div className="h-2 w-28 overflow-hidden rounded-full bg-[#111111]">
                            <div
                              className="h-full rounded-full bg-indigo-500"
                              style={{
                                width: `${Math.round((questions.filter((question) => String(answers[question.id] || '').trim()).length / Math.max(questions.length, 1)) * 100)}%`,
                              }}
                            />
                          </div>
                        </div>

                        <div className="space-y-4">
                          {questions.map((question, index) => {
                            const answer = String(answers[question.id] || '').trim();
                            const suggested = String(question.default || '').trim();
                            const isRequired = question.required !== false;
                            const isNext = nextRequiredQuestion?.id === question.id;
                            return (
                              <div
                                key={question.id}
                                className={`rounded-2xl border p-5 transition-colors ${
                                  isNext
                                    ? 'border-indigo-500/40 bg-indigo-500/5'
                                    : answer
                                      ? 'border-zinc-700 bg-zinc-800/50'
                                      : 'border-[#1A1A1A] bg-black/40'
                                }`}
                              >
                                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                                  <div>
                                    <div className="mb-2 flex flex-wrap items-center gap-2">
                                      <span className="rounded-full border border-[#262626] bg-[#111111] px-2.5 py-1 text-xs font-semibold tracking-wide text-zinc-500">
                                        Question {index + 1}
                                      </span>
                                      <span
                                        className={`rounded-full border px-2.5 py-1 text-xs font-semibold tracking-wide ${
                                          isRequired
                                            ? 'border-amber-500/20 bg-amber-500/10 text-amber-300'
                                            : 'border-zinc-700 bg-[#111111] text-zinc-500'
                                        }`}
                                      >
                                        {isRequired ? 'Required' : 'Optional'}
                                      </span>
                                      {isNext ? (
                                        <span className="rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2.5 py-1 text-xs font-semibold tracking-wide text-indigo-300">
                                          Next
                                        </span>
                                      ) : null}
                                    </div>
                                    <h2 className="text-base font-medium leading-relaxed text-zinc-100">{question.question}</h2>
                                  </div>
                                  {answer ? (
                                    <div className="inline-flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-800/50 px-3 py-1 text-xs font-medium text-zinc-200">
                                      <CheckCircle2 className="h-3.5 w-3.5" />
                                      Answered
                                    </div>
                                  ) : null}
                                </div>

                                {Array.isArray(question.options) && question.options.length > 0 ? (
                                  <div className="grid gap-3 md:grid-cols-2">
                                    {question.options.map((option) => {
                                      const selected = answer === option.value;
                                      const suggestedOption = !answer && suggested === option.value;
                                      return (
                                        <button
                                          key={option.value}
                                          type="button"
                                          onClick={() => updateAnswer(question.id, option.value)}
                                          className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                                            selected
                                              ? 'border-indigo-500 bg-indigo-500/10 text-white'
                                              : 'border-[#262626] bg-[#050505] text-zinc-300 hover:border-[#3f3f46] hover:bg-[#0A0A0A]'
                                          }`}
                                        >
                                          <div className="flex items-start justify-between gap-3">
                                            <div>
                                              <div className="text-sm font-medium">{option.label}</div>
                                              {option.description ? (
                                                <div className="mt-1 text-xs leading-relaxed text-zinc-500">{option.description}</div>
                                              ) : null}
                                            </div>
                                            {selected ? (
                                              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-indigo-300" />
                                            ) : suggestedOption ? (
                                              <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-xs uppercase tracking-widest text-zinc-500">
                                                Suggested
                                              </span>
                                            ) : null}
                                          </div>
                                        </button>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <div className="space-y-3">
                                    <input
                                      value={answer}
                                      onChange={(event) => updateAnswer(question.id, event.target.value)}
                                      placeholder={questionInputPlaceholder(question.id, question.default)}
                                      className="w-full rounded-xl border border-[#262626] bg-[#050505] px-4 py-3 text-sm text-zinc-200 outline-none transition-colors placeholder:text-zinc-600 focus:border-indigo-500/50"
                                    />
                                    {suggested ? (
                                      <div className="text-xs text-zinc-500">
                                        Suggested default: <span className="font-mono text-zinc-300">{suggested}</span>
                                      </div>
                                    ) : null}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    ))}
                  </div>

                  <div className="space-y-4 lg:sticky lg:top-8 lg:self-start">
                    <div className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-6">
                      <div className="mb-4 text-xs font-semibold tracking-wide text-zinc-500">Readiness</div>
                      <div className="mb-3 text-3xl font-semibold text-zinc-100">{reviewCompletionPercent}%</div>
                      <div className="h-2 overflow-hidden rounded-full bg-[#111111]">
                        <div className="h-full rounded-full bg-indigo-500" style={{ width: `${reviewCompletionPercent}%` }} />
                      </div>
                      <div className="mt-4 space-y-2 text-xs text-zinc-400">
                        <div>Required answered: <span className="font-mono text-zinc-200">{answeredRequiredCount}/{requiredQuestions.length || 0}</span></div>
                        <div>Total answered: <span className="font-mono text-zinc-200">{answeredQuestionCount}/{reviewQuestions.length || 0}</span></div>
                        {nextRequiredQuestion ? (
                          <div>Next question: <span className="text-zinc-200">{nextRequiredQuestion.question}</span></div>
                        ) : (
                          <div className="text-zinc-200">All required deployment questions are complete.</div>
                        )}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-6">
                      <div className="mb-4 text-xs font-semibold tracking-wide text-zinc-500">Repository Signal</div>
                      <div className="space-y-3 text-sm text-zinc-300">
                        <div>
                          <div className="text-zinc-500">Workspace</div>
                          <div className="mt-1 font-mono text-xs text-zinc-200">{review.context_json.workspace}</div>
                        </div>
                        <div>
                          <div className="text-zinc-500">Runtime</div>
                          <div className="mt-1 text-zinc-200">{String(repoContext?.language?.runtime || 'Unknown')}</div>
                        </div>
                        <div>
                          <div className="text-zinc-500">Build Command</div>
                          <div className="mt-1 font-mono text-xs text-zinc-200">{String(repoContext?.build?.build_command || 'not detected')}</div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-6">
                      <div className="mb-4 text-xs font-semibold tracking-wide text-zinc-500">What Happens Next</div>
                      <div className="space-y-2 text-sm text-zinc-400">
                        <div>1. Generate AWS architecture and cost estimate.</div>
                        <div>2. Review architecture and cost.</div>
                        <div>3. Generate Terraform and continue to deployment.</div>
                      </div>
                      <button
                        onClick={() => void generatePlan().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Failed to generate deployment profile.'))}
                        disabled={!allQuestionsAnswered}
                        className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-[#111111] disabled:text-zinc-500"
                      >
                        Generate Architecture & Cost
                        <ArrowRight className="h-4 w-4" />
                      </button>
                      {!allQuestionsAnswered ? (
                        <div className="mt-3 text-xs text-zinc-500">
                          Finish the required questions to unlock the plan.
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-[#1A1A1A] bg-[#050505] p-8 text-sm text-zinc-400">
                  The deployment questionnaire could not be loaded. Return to repository analysis and retry.
                </div>
              )}
            </div>
            )
          )}
          {activeStage === 'architecture' && (
            <div className="mx-auto max-w-6xl space-y-6">
              <StageHeader
                title="Architecture"
                description={`Approved ${currentInfraConsultant?.selected_tier || 'recommended'} setup for ${decisionDiagram.awsRegion}.`}
                actions={(
                  <button
                    onClick={() => setAndPersistStage('cost_estimation')}
                    disabled={!decisionForVisualization}
                    className={primaryButtonClass(!decisionForVisualization)}
                  >
                    Continue to Cost
                    <ArrowRight className="h-4 w-4" />
                  </button>
                )}
              />
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
                <Surface className="xl:col-span-2" padded={false}>
                  <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                    <div>
                      <div className="text-sm font-semibold text-zinc-100">Topology</div>
                      <div className="mt-1 text-xs text-zinc-500">
                        {decisionDiagram.components.length > 0
                          ? decisionDiagram.components.map((item) => formatComponentName(item)).join(' · ')
                          : 'Waiting for an approved decision'}
                      </div>
                    </div>
                  </div>
                  <div className="p-4">
                    {decisionDiagram.nodes.length > 0 ? decisionDiagramCanvas : (
                      <div className="rounded-xl border border-dashed border-white/10 bg-[#0c0c0e] px-6 py-16 text-center text-sm text-zinc-500">
                        Approve a consultant decision to see the topology.
                      </div>
                    )}
                  </div>
                </Surface>
                <div className="space-y-6">
                  <Surface>
                    <SurfaceLabel>Stack</SurfaceLabel>
                    {decisionDiagram.components.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {decisionDiagram.components.map((item, index) => (
                          <span
                            key={`stack-${index}-${item}`}
                            className="rounded-md border border-white/10 bg-[#16161a] px-2.5 py-1 text-xs text-zinc-200"
                          >
                            {formatComponentName(item)}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="text-sm text-zinc-500">No components yet.</div>
                    )}
                  </Surface>
                  <Surface>
                    <SurfaceLabel>Why this shape</SurfaceLabel>
                    {consultantNotesList.length > 0 ? (
                      <ul className="space-y-3 text-sm leading-relaxed text-zinc-400">
                        {consultantNotesList.map((note, index) => (
                          <li key={`note-${index}-${note}`} className="border-l border-white/15 pl-3">{note}</li>
                        ))}
                      </ul>
                    ) : (
                      <div className="text-sm text-zinc-500">
                        Built from the approved chat decision for this repository.
                      </div>
                    )}
                  </Surface>
                </div>
              </div>
            </div>
          )}
          {activeStage === 'cost_estimation' && (
            <div className="mx-auto max-w-6xl space-y-6">
              <StageHeader
                title="Cost Estimation"
                description="Priced from your approved setup. Check the monthly total against your budget before generating infrastructure."
                actions={(
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setAndPersistStage('qa')}
                      className={secondaryButtonClass(false)}
                    >
                      <ArrowLeft className="h-4 w-4" />
                      Go back and make changes
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!lockDecisionForTerraform()) {
                          setError('Approve a setup in Questions before generating infrastructure.');
                          return;
                        }
                        setAndPersistStage('terraform');
                      }}
                      disabled={!canContinueToTerraform}
                      className={primaryButtonClass(!canContinueToTerraform)}
                    >
                      Continue to Infrastructure
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  </div>
                )}
              />
              {!decisionCostBasedOnDecision ? (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  Estimate used safe defaults because decision stack_config was incomplete.
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
                <Surface className="xl:col-span-2" padded={false}>
                  <div className="flex items-end justify-between border-b border-white/10 px-5 py-4">
                    <div>
                      <div className="text-sm font-semibold text-zinc-100">Monthly breakdown</div>
                      <div className="mt-1 text-xs text-zinc-500">{decisionCostVariance}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">Subtotal</div>
                      <div className="font-mono text-2xl font-semibold text-zinc-50">${decisionCostSubtotal.toFixed(2)}</div>
                    </div>
                  </div>
                  <div className="p-5">
                    {decisionCostLoading ? (
                      <div className="text-sm text-zinc-500">Fetching AWS public pricing data...</div>
                    ) : decisionCostRows.length > 0 ? (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-white/10 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
                            <th className="px-2 py-3">Component</th>
                            <th className="px-2 py-3">Hourly</th>
                            <th className="px-2 py-3">Monthly</th>
                          </tr>
                        </thead>
                        <tbody>
                          {decisionCostRows.map((row) => (
                            <tr key={`${row.component}-${row.label}`} className="border-b border-white/5">
                              <td className="px-2 py-3 text-zinc-200">{formatCostComponentLabel(row.component, row.label)}</td>
                              <td className="px-2 py-3 font-mono text-zinc-400">${Number(row.hourly_usd || 0).toFixed(4)}</td>
                              <td className="px-2 py-3 font-mono text-zinc-100">${Number(row.monthly_usd || 0).toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="text-sm text-zinc-500">{decisionCostError || 'Cost estimation is not available yet.'}</div>
                    )}
                  </div>
                </Surface>
                <div className="space-y-6">
                  <Surface>
                    <SurfaceLabel>Budget fit</SurfaceLabel>
                    <div className="space-y-2 text-sm text-zinc-300">
                      <div>Cap: <span className="font-mono text-zinc-100">${Number(currentInfraConsultant?.budget_cap_usd || costEstimate.cap).toFixed(2)}</span></div>
                      <div>Estimate: <span className="font-mono text-zinc-100">${Number(decisionCostEstimate?.subtotal_monthly_usd || costEstimate.total).toFixed(2)}</span></div>
                      <div className="text-xs text-zinc-500">
                        {Number(decisionCostEstimate?.subtotal_monthly_usd || costEstimate.total) <= Number(currentInfraConsultant?.budget_cap_usd || costEstimate.cap)
                          ? 'This setup fits the approved budget.'
                          : `Over budget by $${Math.max(0, Number(decisionCostEstimate?.subtotal_monthly_usd || costEstimate.total) - Number(currentInfraConsultant?.budget_cap_usd || costEstimate.cap)).toFixed(2)}/mo.`}
                      </div>
                    </div>
                  </Surface>
                  <Surface>
                    <SurfaceLabel>Need a different setup?</SurfaceLabel>
                    <p className="mb-3 text-xs leading-relaxed text-zinc-500">
                      Go back to the advisor to change services, sizes, or budget, then re-approve before continuing.
                    </p>
                    <button
                      type="button"
                      onClick={() => setAndPersistStage('qa')}
                      className={`${secondaryButtonClass(false)} w-full`}
                    >
                      <ArrowLeft className="h-4 w-4" />
                      Go back and make changes
                    </button>
                  </Surface>
                  <Surface>
                    <SurfaceLabel>Ready for infrastructure</SurfaceLabel>
                    <div className="space-y-2 text-xs text-zinc-400">
                      <div>Budget cap: <span className="font-mono text-zinc-200">${effectiveBudgetCap.toFixed(2)}</span></div>
                      <div>Estimate total: <span className="font-mono text-zinc-200">${effectiveCostTotal.toFixed(2)}</span></div>
                      <div className="text-zinc-300">
                        {canContinueToTerraform
                          ? 'You can continue to generate Terraform from this estimate.'
                          : 'Approve a setup in Questions first, then return here.'}
                      </div>
                    </div>
                  </Surface>
                </div>
              </div>
            </div>
          )}
          {activeStage === 'terraform' && (
            <div className="mx-auto flex max-w-6xl flex-col gap-6">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Infrastructure Generation</h1>
                  <p className="text-sm text-zinc-400">Repo-specific Terraform generation runs here from the confirmed consultant decision.</p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => {
                      resetCurrentIacSessionArtifacts();
                      void generateTerraform().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Infrastructure generation failed.'));
                    }}
                    disabled={terraformGenerating || !approvedConsultantDecision}
                    className="rounded-md border border-[#262626] bg-[#111111] px-5 py-2 text-sm font-semibold text-zinc-200 hover:bg-[#181818] disabled:bg-[#111111] disabled:text-zinc-500"
                  >
                    {terraformGenerating ? 'Generating...' : 'Regenerate'}
                  </button>
                  <button
                    onClick={() => void createIacPr()}
                    disabled={terraformGenerating || iacPrCreating || deployableIacFiles.length === 0 || Boolean(iacPrUrl)}
                    className="rounded-md border border-zinc-700 bg-zinc-800/50 px-5 py-2 text-sm font-semibold text-zinc-200 hover:bg-zinc-800/50 disabled:border-[#262626] disabled:bg-[#111111] disabled:text-zinc-500"
                  >
                    {iacPrUrl ? 'PR ready' : iacPrCreating ? 'Creating PR...' : 'Create PR'}
                  </button>
                  {iacPrUrl ? (
                    <button
                      onClick={() => window.open(iacPrUrl, '_blank', 'noopener,noreferrer')}
                      className="flex items-center gap-2 rounded-md border border-[#262626] bg-[#111111] px-5 py-2 text-sm font-semibold text-zinc-200 hover:bg-[#181818]"
                    >
                      <ExternalLink className="h-4 w-4" />
                      Open PR
                    </button>
                  ) : null}
                  <button
                    onClick={async () => {
                      if (!approvedConsultantDecision) return;
                      if (!hasSuccessfulGeneration) {
                        await generateTerraform();
                      }
                      setAndPersistStage('aws_config', { force: true });
                    }}
                    disabled={terraformGenerating || !approvedConsultantDecision}
                    className="rounded-md bg-zinc-100 px-5 py-2 text-sm font-semibold text-black hover:bg-white disabled:bg-[#111111] disabled:text-zinc-500"
                  >
                    {terraformGenerating ? 'Generating...' : hasSuccessfulGeneration ? 'Continue' : 'Generate & Continue'}
                  </button>
                </div>
              </div>
              {!hasSuccessfulGeneration ? (
                <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 px-4 py-3 text-xs text-zinc-200">
                  Terraform stage only shows generation status and artifacts. Use Questions to refine consultant decisions.
                </div>
              ) : null}
              <div className="grid grid-cols-3 gap-6">
                <div className="space-y-6">
                  <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-5">
                    <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500">Generator</div>
                    <div className="text-lg font-semibold text-zinc-100">{terraformRendererSummary.primary}</div>
                    <div className="mt-1 text-sm text-zinc-400">{terraformRendererSummary.secondary}</div>
                    <div className="mt-3 space-y-2 text-xs text-zinc-500">
                      <div>Runtime: <span className="font-mono text-zinc-300">{terraformRendererSummary.runtime}</span></div>
                      <div>Status: <span className="font-mono text-zinc-300">{terraformRunLabel}</span></div>
                      <div>Run ID: <span className="font-mono text-zinc-300">{shouldUseSavedRunForDeploy ? activeSavedRun?.run_id : (hasCurrentIacMeta ? 'bundle-only' : 'pending')}</span></div>
                      <div>Workspace: <span className="font-mono text-zinc-300">{(shouldUseSavedRunForDeploy ? activeSavedRun?.workspace : savedIacMeta?.workspace) || expectedWorkspace || 'pending'}</span></div>
                      <div>Files: <span className="font-mono text-zinc-300">{iacFiles.length}</span></div>
                      <div>Socket: <span className={`font-mono ${deploySocketState === 'connected' ? 'text-zinc-200' : deploySocketState === 'connecting' ? 'text-zinc-200' : deploySocketState === 'error' ? 'text-amber-400' : 'text-zinc-300'}`}>{deploySocketState}</span></div>
                    </div>
                    {socketNotices.length > 0 ? (
                      <div className="mt-4 space-y-2">
                        <div className="text-xs font-semibold tracking-wide text-zinc-500">Connection Notices</div>
                        {socketNotices.map((notice) => (
                          <div key={notice.key} className={`rounded-md border px-3 py-2 text-xs ${notice.tone === 'error' ? 'border-amber-500/20 bg-amber-500/10 text-amber-200' : 'border-zinc-700 bg-zinc-800/50 text-zinc-200'}`}>
                            <div>{notice.text}</div>
                            <div className="mt-1 font-mono text-xs opacity-70">{notice.ts}</div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {sessionIacTruncated ? (
                      <div className="mt-4 rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
                        This cached generation preview is truncated. Regenerate before creating a PR or deploying from session files.
                      </div>
                    ) : null}
                    {iacPrUrl ? (
                      <div className="mt-4 rounded-md border border-zinc-700 bg-zinc-800/50 p-3 text-xs text-zinc-200">
                        Pull request creation is available and does not block AWS Config or deploy readiness.
                      </div>
                    ) : null}
                  </div>
                  <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-5">
                    <div className="mb-3 text-xs font-semibold tracking-wide text-zinc-500">Workers</div>
                    <div className="space-y-2 text-xs">
                      {terraformWorkerStates.length > 0 ? terraformWorkerStates.map((worker) => (
                        <div key={worker.worker_id} className="rounded-md border border-[#1A1A1A] bg-black px-3 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="font-medium text-zinc-200">{worker.worker_role || worker.worker_id}</div>
                              <div className="font-mono text-sm text-zinc-500">{worker.worker_id}</div>
                            </div>
                            <span className={`rounded border px-2 py-0.5 text-xs font-semibold uppercase tracking-widest ${
                              worker.worker_status === 'completed'
                                ? 'border-zinc-700 bg-zinc-800/50 text-zinc-200'
                                : worker.worker_status === 'failed'
                                  ? 'border-red-500/20 bg-red-500/10 text-red-300'
                                  : 'border-zinc-700 bg-zinc-800/50 text-zinc-200'
                            }`}>
                              {worker.worker_status || 'running'}
                            </span>
                          </div>
                        </div>
                      )) : (
                        <div className="text-zinc-500">Only workers whose latest activity is still in terraform generation appear here.</div>
                      )}
                    </div>
                  </div>
                  <div className="flex h-80 flex-col overflow-hidden rounded-lg border border-[#1A1A1A] bg-[#050505]">
                    <div className="flex items-center justify-between border-b border-[#1A1A1A] bg-black px-4 py-2.5 font-mono text-xs text-zinc-500">
                      <div className="flex items-center gap-2">
                        <Terminal className="h-4 w-4 text-zinc-400" />
                        Generation feed
                      </div>
                      <div>{terraformGenerationLogs.length} events</div>
                    </div>
                    <div className="custom-scrollbar flex-1 overflow-y-auto bg-black p-4 font-mono text-[12px]">
                      {terraformGenerationLogs.length > 0 ? terraformGenerationLogs.slice(-40).map((log, index) => (
                        <div key={`${log.ts}-${index}`} className="mb-2 flex gap-3">
                          <span className="shrink-0 text-zinc-600">{String(index + 1).padStart(2, '0')}</span>
                          <div className="min-w-0">
                            <div className="mb-1 flex flex-wrap items-center gap-2">
                              {log.worker_id && <span className="rounded border border-[#262626] bg-[#111111] px-2 py-0.5 text-xs uppercase tracking-widest text-zinc-400">{log.worker_id}</span>}
                              {log.worker_status && <span className={`rounded border px-2 py-0.5 text-xs uppercase tracking-widest ${
                                log.worker_status === 'completed'
                                  ? 'border-zinc-700 bg-zinc-800/50 text-zinc-200'
                                  : log.worker_status === 'failed'
                                    ? 'border-red-500/20 bg-red-500/10 text-red-300'
                                    : 'border-zinc-700 bg-zinc-800/50 text-zinc-200'
                              }`}>{log.worker_status}</span>}
                              {log.model && <span className="font-mono text-xs text-zinc-600">{log.model}</span>}
                            </div>
                            <div className={log.type === 'success' ? 'font-medium text-zinc-200' : log.type === 'error' ? 'text-red-400' : 'text-zinc-300'}>{log.text}</div>
                          </div>
                        </div>
                      )) : (
                        <div className="text-zinc-500">{hasSuccessfulGeneration ? 'Generation already succeeded for this workspace. Regenerate to start a new attempt.' : 'The generation feed will populate as soon as live terraform-generation events arrive.'}</div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="col-span-2 flex gap-6">
                  <div className="custom-scrollbar h-130 w-64 shrink-0 overflow-y-auto rounded-lg border border-[#1A1A1A] bg-[#050505] p-3 text-sm">
                    {iacFiles.map((file) => (
                      <button
                        key={file.path}
                        onClick={() => setSelectedFile(file.path)}
                        className={`mb-2 block w-full rounded px-2 py-1 text-left ${activeIacFilePath === file.path ? 'bg-[#111111] text-zinc-200' : 'text-zinc-300 hover:bg-[#111111]'}`}
                      >
                        {file.path}
                      </button>
                    ))}
                  </div>
                  <div className="flex h-130 flex-1 flex-col rounded-lg border border-[#1A1A1A] bg-[#050505]">
                    <div className="flex items-center justify-between border-b border-[#1A1A1A] bg-black px-4 py-2.5">
                      <div className="font-mono text-sm text-zinc-400">{activeIacFilePath || 'Generated files'}</div>
                      <div className="text-xs font-semibold tracking-wide text-zinc-500">Editable</div>
                    </div>
                    <textarea
                      value={(iacFiles.find((file) => file.path === activeIacFilePath) || iacFiles[0])?.content || ''}
                      onChange={(event) => {
                        if (!activeIacFilePath) return;
                        updateIacFileContent(activeIacFilePath, event.target.value);
                      }}
                      disabled={!activeIacFilePath}
                      placeholder="Generate infrastructure to view and edit files."
                      spellCheck={false}
                      className="custom-scrollbar flex-1 resize-none bg-[#050505] p-5 font-mono text-[13px] leading-relaxed text-zinc-300 outline-none"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
          {activeStage === 'aws_config' && (
            <div className="mx-auto max-w-5xl space-y-6">
              <StageHeader
                title="AWS Config"
                description="Credentials and Terraform runtime for deploy handoff. Temporary ASIA keys require a session token."
              />
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
                <Surface className="space-y-5 xl:col-span-2">
                  <div className="space-y-3">
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Access key</span>
                      <input value={aws.aws_access_key_id} onChange={(event) => setAws((prev) => ({ ...prev, aws_access_key_id: event.target.value }))} placeholder="AKIA… or ASIA…" className="w-full rounded-md border border-white/10 bg-[#09090b] px-4 py-2.5 font-mono text-sm text-zinc-200 outline-none focus:border-white/25" />
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Secret key</span>
                      <input type="password" value={aws.aws_secret_access_key} onChange={(event) => setAws((prev) => ({ ...prev, aws_secret_access_key: event.target.value }))} placeholder="AWS_SECRET_ACCESS_KEY" className="w-full rounded-md border border-white/10 bg-[#09090b] px-4 py-2.5 font-mono text-sm text-zinc-200 outline-none focus:border-white/25" />
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
                        Session token {needsSessionToken ? '(required for ASIA)' : '(optional)'}
                      </span>
                      <input type="password" value={aws.aws_session_token} onChange={(event) => setAws((prev) => ({ ...prev, aws_session_token: event.target.value }))} placeholder={needsSessionToken ? 'Required for temporary STS credentials' : 'Optional for long-lived AKIA credentials'} className="w-full rounded-md border border-white/10 bg-[#09090b] px-4 py-2.5 font-mono text-sm text-zinc-200 outline-none focus:border-white/25" />
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Region</span>
                      <input value={terraformRuntimeConfig.aws_region} onChange={(event) => setTerraformRuntimeConfig((prev) => ({ ...prev, aws_region: event.target.value }))} placeholder="eu-north-1" className="w-full rounded-md border border-white/10 bg-[#09090b] px-4 py-2.5 font-mono text-sm text-zinc-200 outline-none focus:border-white/25" />
                    </label>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">State bucket</span>
                        <input value={terraformRuntimeConfig.state_bucket} onChange={(event) => setTerraformRuntimeConfig((prev) => ({ ...prev, state_bucket: event.target.value }))} placeholder="optional" className="w-full rounded-md border border-white/10 bg-[#09090b] px-4 py-2.5 font-mono text-sm text-zinc-200 outline-none focus:border-white/25" />
                      </label>
                      <label className="block">
                        <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Lock table</span>
                        <input value={terraformRuntimeConfig.lock_table} onChange={(event) => setTerraformRuntimeConfig((prev) => ({ ...prev, lock_table: event.target.value }))} placeholder="optional" className="w-full rounded-md border border-white/10 bg-[#09090b] px-4 py-2.5 font-mono text-sm text-zinc-200 outline-none focus:border-white/25" />
                      </label>
                    </div>
                  </div>
                  {hasAwsSecrets && !canContinueToAwsConfig && (
                    <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                      Infrastructure generation is required before deploying. Complete the Infrastructure Generation step first.
                    </div>
                  )}
                  {needsSessionToken && !aws.aws_session_token.trim() && (
                    <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                      This access key starts with ASIA. Provide AWS_SESSION_TOKEN or STS GetCallerIdentity will fail.
                    </div>
                  )}
                  <div className="rounded-md border border-white/10 bg-[#111113] px-3 py-2 text-[11px] leading-relaxed text-zinc-400">
                    Operator AWS keys are kept in <span className="font-mono text-zinc-300">sessionStorage</span> only
                    (never localStorage), expire after {needsSessionToken ? '1 hour' : '2 hours'}, and are wiped from this browser when the tab closes.
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <button onClick={() => setAndPersistStage('app_secrets')} disabled={!hasAwsSecrets || !canContinueToAwsConfig} className={`${accentButtonClass(!hasAwsSecrets || !canContinueToAwsConfig)} w-full`}>
                      <Rocket className="h-4 w-4" /> Continue to App Secrets
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        clearSavedAws();
                        setAws({
                          aws_access_key_id: '',
                          aws_secret_access_key: '',
                          aws_session_token: '',
                          aws_region: terraformRuntimeConfig.aws_region || DEFAULT_AWS_REGION,
                        });
                      }}
                      disabled={!hasAwsSecrets}
                      className={`${secondaryButtonClass(!hasAwsSecrets)} w-full sm:w-auto whitespace-nowrap`}
                    >
                      Clear credentials
                    </button>
                  </div>
                </Surface>
                <div className="space-y-4">
                  <Surface>
                    <SurfaceLabel>Runtime Inputs</SurfaceLabel>
                    <div className="mt-1 space-y-2 text-xs text-zinc-400">
                      <div>Deploy source: <span className="font-mono text-zinc-200">{shouldUseSavedRunForDeploy ? 'saved run' : 'session files'}</span></div>
                      <div>Workspace: <span className="font-mono text-zinc-200">{shouldUseSavedRunForDeploy ? (activeSavedRun?.workspace || expectedWorkspace || 'pending') : (expectedWorkspace || 'local session')}</span></div>
                      {customizationSnapshotId ? (
                        <div>Customization snapshot: <span className="font-mono text-zinc-200">{customizationSnapshotId}</span></div>
                      ) : null}
                      <div>AWS region: <span className="font-mono text-zinc-200">{terraformRuntimeConfig.aws_region || DEFAULT_AWS_REGION}</span></div>
                      <div>Estimated monthly: <span className="font-mono text-zinc-200">${effectiveCostTotal.toFixed(2)}</span></div>
                      <div>Budget cap: <span className="font-mono text-zinc-200">${effectiveBudgetCap.toFixed(2)}</span></div>
                    </div>
                  </Surface>
                  <div className={`rounded-xl border px-3 py-2 text-xs ${hasAwsSecrets && canContinueToAwsConfig ? 'border-white/10 bg-[#16161a] text-zinc-200' : hasAwsSecrets ? 'border-white/10 bg-[#111113] text-zinc-400' : 'border-amber-500/20 bg-amber-500/10 text-amber-300'}`}>
                    {hasAwsSecrets && canContinueToAwsConfig
                      ? needsSessionToken
                        ? 'Temporary credentials ready with session token.'
                        : 'Long-lived credentials ready. Session token not required.'
                      : hasAwsSecrets
                        ? 'Credentials saved. Complete infrastructure generation to unlock deploy.'
                        : 'Enter AWS access key and secret key to unlock deployment.'}
                  </div>
                  {sessionIacTruncated && !activeSavedRun && (
                    <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                      Session-cached generation files are truncated preview data and cannot be deployed. Regenerate infrastructure to produce a fresh bundle.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          {activeStage === 'app_secrets' && selectedProject && (
            <AppSecretsPanel
              projectId={selectedProject.id}
              projectName={selectedProject.name}
              aws={aws}
              awsRegion={terraformRuntimeConfig.aws_region || DEFAULT_AWS_REGION}
              secretsPrefix={secretsManagerPrefix}
              environment={String((deploymentProfile as { environment?: string } | null)?.environment || 'prod')}
              requiredKeys={requiredAppSecretKeys}
              publicAppUrl={publicAppUrlForSecrets}
              oauthCallbackPaths={oauthCallbackPaths}
              hasAwsCredentials={hasAwsSecrets}
              initialMeta={appSecretsMeta}
              onMetaChange={setAppSecretsMeta}
              onContinueToDeploy={() => setAndPersistStage('deploy', { force: true })}
              onBackToAwsConfig={() => setAndPersistStage('aws_config', { force: true })}
              canContinueToDeploy={canContinueToAwsConfig}
            />
          )}
          {activeStage === 'deploy' && (
            <div className="mx-auto max-w-5xl space-y-6">
              <StageHeader
                title={
                  deployIsLive
                    ? 'Deployment In Progress'
                    : deployStatus === 'done'
                      ? 'Deployment Complete'
                      : deployStatus === 'error' || deployUiPhase === 'error'
                        ? 'Deployment Failed'
                        : deployUiPhase === 'awaiting_plan' || requiresPlanConfirmation
                          ? 'Confirm Terraform Plan'
                          : 'Ready to Deploy'
                }
                description={
                  deployIsLive
                    ? 'Backend is applying Terraform now. Live lines appear below even if WebSocket is still connecting.'
                    : 'Live console from pipeline WebSocket events and backend status reconciliation.'
                }
                meta={(
                  <div className="flex items-center gap-2">
                    <MetaChip
                      label="WS"
                      value={deploySocketState}
                      tone={deploySocketState === 'connected' ? 'ok' : deploySocketState === 'error' ? 'warn' : 'neutral'}
                    />
                    <MetaChip
                      label="Phase"
                      value={deployPhaseLabel}
                      tone={deployIsLive ? 'warn' : deployStatus === 'error' || deployUiPhase === 'error' ? 'danger' : deployStatus === 'done' ? 'ok' : 'neutral'}
                    />
                  </div>
                )}
              />
              {(deployIsLive || deployUiPhase === 'awaiting_plan' || error || backendErrorMessage) && (
                <div
                  className={`mb-6 rounded-xl border px-4 py-3 text-sm ${
                    deployStatus === 'error' || deployUiPhase === 'error' || error
                      ? 'border-red-500/20 bg-red-500/10 text-red-200'
                      : deployUiPhase === 'awaiting_plan' || requiresPlanConfirmation
                        ? 'border-amber-500/20 bg-amber-500/10 text-amber-100'
                        : 'border-white/10 bg-[#16161a] text-zinc-200'
                  }`}
                >
                  <div className="flex items-center gap-2 font-semibold">
                    {deployIsLive ? <CircleDashed className="h-4 w-4 animate-spin" /> : null}
                    <span>{deployPhaseLabel}</span>
                  </div>
                  {(error || backendErrorMessage) ? (
                    <div className="mt-2 text-sm leading-relaxed opacity-90">{error || backendErrorMessage}</div>
                  ) : deployIsLive ? (
                    <div className="mt-2 text-sm text-zinc-400">
                      Request accepted. Waiting on `/api/pipeline/deploy` — this commonly takes 1–5 minutes. Watch `deployment.log` for heartbeat lines every 5s.
                    </div>
                  ) : (
                    <div className="mt-2 text-sm text-amber-200/80">
                      Review the plan summary in the log, then click Confirm Plan & Deploy.
                    </div>
                  )}
                </div>
              )}
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
                <Surface className="flex h-125 flex-col overflow-hidden xl:col-span-2" padded={false}>
                  <div className="flex items-center justify-between border-b border-white/10 bg-[#0c0c0e] px-4 py-2.5 font-mono text-xs">
                    <div className="flex items-center gap-2.5">
                      <Terminal className="h-3.5 w-3.5 text-zinc-500" />
                      <span className="font-semibold tracking-wider text-zinc-400">deployment.log</span>
                    </div>
                    <span className="rounded bg-[#16161a] px-2 py-0.5 text-xs font-mono text-zinc-500">{deployLogs.length} events</span>
                  </div>
                  <div className="custom-scrollbar deployment-scrollbar flex-1 overflow-y-auto bg-[#09090b] p-4 font-mono text-[12px]">
                    {deployLogs.length === 0 && (
                      <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-zinc-600">
                        <span>Waiting for deployment events...</span>
                        <span className="text-zinc-700">Click Start Deploy — the first log line should appear immediately.</span>
                      </div>
                    )}
                    {socketNotices.map((notice) => (
                      <div key={notice.key} className={`mb-1 px-2 py-0.5 ${notice.tone === 'error' ? 'text-red-400' : 'text-amber-300/80'}`}>
                        [ws] {notice.text}
                      </div>
                    ))}
                    {deployLogs.map((log, index) => (
                      <div key={`${log.ts}-${index}`} className={`mb-0.5 flex gap-3 rounded px-2 py-0.5 ${index % 2 === 0 ? 'bg-transparent' : 'bg-white/[0.02]'}`}>
                        <span className="mt-0.5 shrink-0 select-none text-xs text-zinc-700">{String(index + 1).padStart(2, '0')}</span>
                        <span className={`flex-1 leading-relaxed ${
                          log.type === 'success' ? 'text-zinc-200'
                          : log.type === 'error' ? 'text-red-400'
                          : log.text.startsWith('✓') || log.text.includes('created') ? 'text-zinc-200'
                          : log.text.startsWith('+') || log.text.includes('Creating') ? 'text-zinc-300'
                          : log.text.includes('Error') || log.text.includes('failed') ? 'text-red-400'
                          : log.text.startsWith('[') ? 'text-amber-300/80'
                          : 'text-zinc-500'
                        }`}>
                          {log.text}
                        </span>
                      </div>
                    ))}
                    <div ref={logEndRef} />
                  </div>
                </Surface>
                <Surface className="space-y-4">
                  <div>
                    <SurfaceLabel>Execution</SurfaceLabel>
                    <div className="mt-1 text-3xl font-semibold text-zinc-100">{deployProgress}%</div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5">
                      <div
                        className={`h-full rounded-full ${deployStatus === 'done'
                          ? 'bg-zinc-300'
                          : deployStatus === 'error' || deployUiPhase === 'error'
                            ? 'bg-red-500'
                            : deployIsLive
                              ? 'animate-pulse bg-zinc-100'
                              : 'bg-zinc-100'
                        }`}
                        style={{ width: `${Math.max(deployProgress, deployIsLive ? 5 : 0)}%` }}
                      />
                    </div>
                    <div className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
                      <span>Status:</span>
                      <span className={`rounded-full px-2 py-0.5 font-mono text-xs font-semibold ${
                        deployStatus === 'done' ? 'border border-white/10 bg-[#16161a] text-zinc-200'
                        : deployStatus === 'error' || deployUiPhase === 'error' ? 'border border-red-500/20 bg-red-500/10 text-red-400'
                        : deployIsLive ? 'animate-pulse border border-amber-500/20 bg-amber-500/10 text-amber-200'
                        : 'border border-white/10 bg-[#16161a] text-zinc-300'
                      }`}>{deployIsLive ? 'running' : deployProgress >= 100 && deployStatus === 'running' ? 'executing build' : deployStatus}</span>
                    </div>
                    <div className="mt-2 text-xs text-zinc-500">{deployPhaseLabel}</div>
                    {deployProgress >= 100 && deployStatus === 'running' && (
                      <div className="mt-3 rounded-md border border-white/10 bg-[#16161a] px-3 py-2 text-sm text-zinc-300">
                        Build script running on EC2. This can take 30–60 min. Watch the terminal.
                      </div>
                    )}
                  </div>
                  {!costEstimateIsFresh && hasApprovedDecisionForCost ? (
                    <div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
                      <div>Refreshing cost estimate for the current setup…</div>
                      <button
                        type="button"
                        onClick={() => {
                          if (!decisionForVisualization) return;
                          decisionCostRequestKeyRef.current = null;
                          void fetchDecisionCostEstimate(decisionForVisualization).catch((reason: unknown) => {
                            setDecisionCostError(reason instanceof Error ? reason.message : 'Failed to refresh cost estimate.');
                          });
                        }}
                        disabled={decisionCostLoading || !decisionForVisualization}
                        className="mt-2 text-amber-100 underline disabled:opacity-50"
                      >
                        {decisionCostLoading ? 'Refreshing…' : 'Refresh now'}
                      </button>
                    </div>
                  ) : null}
                  {effectiveCostTotal > effectiveBudgetCap && (
                    <div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
                      <div className="font-semibold text-amber-300">Budget guardrail</div>
                      <div className="mt-1">Estimated monthly cost ${effectiveCostTotal.toFixed(2)} exceeds cap ${effectiveBudgetCap.toFixed(2)}.</div>
                      <label className="mt-3 flex items-start gap-3 text-left">
                        <input
                          type="checkbox"
                          checked={budgetOverride}
                          onChange={(event) => setBudgetOverride(event.target.checked)}
                          disabled={deployStatus === 'running'}
                          className="mt-0.5 h-4 w-4 rounded border-[#3f3f46] bg-black text-zinc-200 focus:ring-zinc-400/40"
                        />
                        <span>
                          <span className="block font-medium text-amber-100">Override budget guardrail for this deploy</span>
                          <span className="mt-1 block text-sm text-amber-200/80">Use only when you intentionally approve costs above the configured cap.</span>
                        </span>
                      </label>
                    </div>
                  )}
                  <div className="space-y-3">
                    <button
                      onClick={() => void startDeploy()}
                      disabled={deployButtonDisabled}
                      className={`${accentButtonClass(deployButtonDisabled)} w-full`}
                    >
                      {deployIsLive ? <CircleDashed className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                      {deployIsLive
                        ? `Deploying… ${deployElapsedSec}s`
                        : awaitingPlanIdle
                          ? 'Confirm Plan & Deploy'
                          : deployStatus === 'done'
                            ? 'Re-run Deploy'
                            : 'Start Deploy'}
                    </button>
                    {deployStartBlockers.length > 0 && (
                      <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 space-y-1">
                        {deployStartBlockers.map((blocker) => (
                          <div key={blocker}>{blocker}</div>
                        ))}
                      </div>
                    )}
                    <button onClick={() => void stopDeployment()} disabled={!deployIsLive || stopLoading} className="w-full rounded-md border border-red-500/20 bg-red-500/10 px-6 py-2.5 font-semibold text-red-300 hover:bg-red-500/20 disabled:border-white/5 disabled:bg-transparent disabled:text-zinc-600">
                      {stopLoading ? 'Stopping...' : 'Stop Deployment'}
                    </button>
                    <button onClick={() => void reconcileDeploymentStatus().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Failed to reconcile deployment status.'))} className={`${secondaryButtonClass(false)} w-full`}>
                      Reconcile Backend Status
                    </button>
                    {deployStatus !== 'running' && deployResult && (
                      <button onClick={() => setAndPersistStage('outputs')} className={`${primaryButtonClass(false)} w-full`}>
                        {deployStatus === 'error' ? 'View Results' : 'View Outputs'} <ArrowRight className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </Surface>
              </div>
              {deployResult?.mode === 'iac_pipeline' && deployResult?.run_id ? (
                <ApplyLogViewer runId={deployResult.run_id} onComplete={onIacPipelineComplete} onError={onIacPipelineError} />
              ) : null}
              {(() => {
                const termInstanceId = deploySummary.instanceId && deploySummary.instanceId !== 'n/a' 
                  ? deploySummary.instanceId 
                  : String(iacResourceOutputs?.outputs?.find(o => o.key === 'instance_id' || o.key === 'ec2_instance_id')?.value || 'n/a');
                const rawPublicIp = (deploySummary.publicIp && deploySummary.publicIp !== 'n/a') ? deploySummary.publicIp : String(iacResourceOutputs?.outputs?.find(o => o.key === 'public_ip')?.value || '');
                const rawPrivateKey = (deploySummary.generatedPem && deploySummary.generatedPem !== 'n/a') ? deploySummary.generatedPem : String(iacResourceOutputs?.outputs?.find(o => o.key === 'private_key_pem')?.value || '');
                // Sanitize: only pass real values, not placeholder strings
                const sanitize = (v: string) => (!v || v === 'n/a' || v === 'N/A' || v === 'null' || v === 'undefined' ? undefined : v);
                const termPublicIp = sanitize(rawPublicIp);
                const termPrivateKey = sanitize(rawPrivateKey);
                
                return deployResult?.success && termInstanceId !== 'n/a' ? (
                  <div className="mt-6">
                    <AwsConsoleTerminal 
                      instanceId={termInstanceId} 
                      publicIp={termPublicIp}
                      privateKey={termPrivateKey}
                      region={terraformRuntimeConfig.aws_region || DEFAULT_AWS_REGION} 
                      projectName={selectedProject?.name}
                    />
                  </div>
                ) : null;
              })()}
            </div>
          )}
          {activeStage === 'outputs' && (
            <div className="mx-auto max-w-5xl space-y-6">
              <StageHeader
                title={outputBanner.title}
                description={outputBanner.description}
                meta={(
                  <MetaChip
                    label="Status"
                    value={outputBanner.label}
                    tone={outputBanner.tone === 'success' ? 'ok' : outputBanner.tone === 'error' ? 'danger' : 'warn'}
                  />
                )}
              />
              {backendErrorMessage && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-300">
                  {backendErrorMessage}
                </div>
              )}
              {!backendErrorMessage && !hasLiveRuntimeDetails && deployResult?.success && deployResult.mode !== 'iac_pipeline' && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200">
                  Live runtime details are missing for this repo. Fetch the latest runtime details to hydrate outputs before treating this deploy as successful.
                </div>
              )}
              {deployResult?.mode === 'iac_pipeline' && deployResult.run_id && iacResourceOutputs ? (
                <ResourceCard
                  runId={deployResult.run_id}
                  serviceType={deployResult.service_type || 'aws'}
                  outputs={iacResourceOutputs}
                  keypair={iacKeypair}
                  awsCredentials={{
                    access_key_id: aws.aws_access_key_id,
                    secret_access_key: aws.aws_secret_access_key,
                    region: terraformRuntimeConfig.aws_region || DEFAULT_AWS_REGION,
                  }}
                  onDestroyed={handleIacDestroyed}
                />
              ) : null}
              {(() => {
                const termInstanceId = deploySummary.instanceId && deploySummary.instanceId !== 'n/a' 
                  ? deploySummary.instanceId 
                  : String(iacResourceOutputs?.outputs?.find(o => o.key === 'instance_id' || o.key === 'ec2_instance_id')?.value || 'n/a');
                const rawPublicIp = (deploySummary.publicIp && deploySummary.publicIp !== 'n/a') ? deploySummary.publicIp : String(iacResourceOutputs?.outputs?.find(o => o.key === 'public_ip')?.value || '');
                const rawPrivateKey = (deploySummary.generatedPem && deploySummary.generatedPem !== 'n/a') ? deploySummary.generatedPem : String(iacResourceOutputs?.outputs?.find(o => o.key === 'private_key_pem')?.value || '');
                // Sanitize: only pass real values, not placeholder strings
                const sanitize = (v: string) => (!v || v === 'n/a' || v === 'N/A' || v === 'null' || v === 'undefined' ? undefined : v);
                const termPublicIp = sanitize(rawPublicIp);
                const termPrivateKey = sanitize(rawPrivateKey);
                
                return termInstanceId !== 'n/a' ? (
                  <AwsConsoleTerminal 
                    instanceId={termInstanceId} 
                    publicIp={termPublicIp}
                    privateKey={termPrivateKey}
                    region={terraformRuntimeConfig.aws_region || DEFAULT_AWS_REGION} 
                    projectName={selectedProject?.name}
                  />
                ) : null;
              })()}
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <Surface>
                  <SurfaceLabel>Security</SurfaceLabel>
                  <div className="flex gap-2">
                    <button
                      onClick={() => deploySummary.generatedPem && downloadTextFile(`${deploySummary.keyName}.pem`, deploySummary.generatedPem.endsWith('\n') ? deploySummary.generatedPem : `${deploySummary.generatedPem}\n`)}
                      disabled={!deploySummary.generatedPem}
                      className={`${secondaryButtonClass(!deploySummary.generatedPem)} flex-1 text-[12px]`}
                    >
                      <Download className="h-4 w-4" /> Download .PEM
                    </button>
                    <button
                      onClick={() => void downloadPpk().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'PPK conversion failed.'))}
                      disabled={!deploySummary.generatedPem}
                      className={`${secondaryButtonClass(!deploySummary.generatedPem)} flex-1 text-[12px]`}
                    >
                      <Download className="h-4 w-4" /> Download .PPK
                    </button>
                  </div>
                  {!deploySummary.generatedPem && (
                    <div className="mt-4 rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
                      {keyPairDownloadMessage}
                    </div>
                  )}
                </Surface>
                <Surface>
                  <SurfaceLabel>Front-door endpoints</SurfaceLabel>
                  <div className="space-y-0">
                    {(() => {
                      const termInstanceId = deploySummary.instanceId && deploySummary.instanceId !== 'n/a' ? deploySummary.instanceId : String(iacResourceOutputs?.outputs?.find(o => o.key === 'instance_id' || o.key === 'ec2_instance_id')?.value || 'n/a');
                      const termPublicIp = (deploySummary.publicIp && deploySummary.publicIp !== 'n/a') ? deploySummary.publicIp : String(iacResourceOutputs?.outputs?.find(o => o.key === 'public_ip')?.value || 'n/a');
                      const termAlbDns = (deploySummary.albDns && deploySummary.albDns !== 'n/a') ? deploySummary.albDns : String(iacResourceOutputs?.outputs?.find(o => o.key === 'alb_dns_name' || o.key === 'load_balancer_dns_name')?.value || 'n/a');
                      const termElasticIp = (deploySummary.elasticIp && deploySummary.elasticIp !== 'n/a') ? deploySummary.elasticIp : String(iacResourceOutputs?.outputs?.find(o => o.key === 'elastic_ip' || o.key === 'eip_public_ip')?.value || 'n/a');
                      const termAppUrl = (deploySummary.appUrl && deploySummary.appUrl !== 'n/a')
                        ? deploySummary.appUrl
                        : (termAlbDns !== 'n/a'
                          ? `http://${termAlbDns}`
                          : termElasticIp !== 'n/a'
                            ? `http://${termElasticIp}`
                            : termPublicIp !== 'n/a'
                              ? `http://${termPublicIp}`
                              : 'n/a');
                      return (
                        <>
                          <EndpointRow label="App URL" value={termAppUrl} primary />
                          <EndpointRow label="ALB DNS" value={termAlbDns} />
                          <EndpointRow label="Elastic IP" value={termElasticIp} />
                          <EndpointRow label="Public IP" value={termPublicIp} />
                          <EndpointRow label="CloudFront" value={deploySummary.cloudfrontUrl} />
                          <EndpointRow label="RDS endpoint" value={deploySummary.rdsEndpoint} />
                          <EndpointRow label="Instance" value={termInstanceId} />
                          <div className="flex items-center justify-between border-t border-white/5 pt-3 text-sm">
                            <span className="text-zinc-500">Verification</span>
                            <span className={`font-medium ${outputBanner.tone === 'success' ? 'text-zinc-200' : outputBanner.tone === 'error' ? 'text-red-300' : 'text-amber-300'}`}>{outputBanner.label}</span>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </Surface>
              </div>
              {(publicAppUrlForSecrets || oauthCallbackPaths.length > 0 || requiredAppSecretKeys.some((key) => /GOOGLE|GITHUB|OAUTH|NEXTAUTH/i.test(key))) && (
                <Surface>
                  <SurfaceLabel>OAuth callback URLs to register</SurfaceLabel>
                  <p className="mt-2 text-xs text-zinc-400">
                    After the app is reachable, register these redirect URLs in Google / GitHub (or other) OAuth consoles. Update client secrets in App Secrets if needed, then reboot the instance so EC2 reloads Secrets Manager values.
                  </p>
                  {publicAppUrlForSecrets ? (
                    <p className="mt-3 break-all font-mono text-sm text-zinc-200">{publicAppUrlForSecrets}</p>
                  ) : (
                    <p className="mt-3 text-xs text-amber-200">App URL not available yet — deploy first, then register callbacks.</p>
                  )}
                  {oauthCallbackPaths.length > 0 && (
                    <ul className="mt-3 space-y-1 font-mono text-xs text-zinc-400">
                      {oauthCallbackPaths.map((path) => (
                        <li key={path}>
                          {publicAppUrlForSecrets ? `${publicAppUrlForSecrets.replace(/\/$/, '')}${path}` : path}
                        </li>
                      ))}
                    </ul>
                  )}
                  {appSecretsMeta.some((row) => row.required && !row.is_set) && (
                    <div className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                      Missing Google/GitHub (or other) keys in App Secrets — login providers will fail until those values are saved.
                    </div>
                  )}
                </Surface>
              )}
              <div className="flex gap-3">
                <button onClick={() => void fetchRuntimeDetails().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Failed to fetch runtime details.'))} disabled={!canFetchRuntimeDetails} className="flex items-center gap-2 rounded-md border border-[#262626] bg-[#111111] px-4 py-2 text-sm font-semibold text-zinc-300 hover:bg-[#181818] disabled:border-[#262626] disabled:bg-[#111111] disabled:text-zinc-500">
                  <RefreshCw className="h-4 w-4" /> Fetch Latest Runtime Details
                </button>
                <button onClick={() => void verifyLiveEndpoints()} disabled={verifyLoading || !canVerifyLiveEndpoints} className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800/50 px-4 py-2 text-sm font-semibold text-zinc-200 hover:bg-zinc-800/50 disabled:border-[#262626] disabled:bg-[#111111] disabled:text-zinc-500">
                  <ExternalLink className="h-4 w-4" /> {verifyLoading ? 'Verifying...' : 'Verify Live Endpoints'}
                </button>
                <button onClick={() => void destroyDeployment().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Destroy failed.'))} disabled={destroyLoading || !hasAwsSecrets} className="flex items-center gap-2 rounded-md border border-red-500/20 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/20 disabled:border-[#262626] disabled:bg-[#111111] disabled:text-zinc-500">
                  <Server className="h-4 w-4" /> {destroyLoading ? 'Destroying...' : 'Destroy Infrastructure'}
                </button>
              </div>
              <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6">
                <h3 className="mb-4 text-sm font-semibold text-zinc-200">Endpoint Verification</h3>
                {effectiveEndpointChecks.length > 0 ? (
                  <div className="space-y-3">
                    {effectiveEndpointChecks.map((check) => (
                      <div key={`${check.label}-${check.url || 'empty'}`} className="rounded-md border border-[#1A1A1A] bg-black p-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-sm font-medium text-zinc-200">{check.label}</div>
                            <div className="mt-1 font-mono text-sm text-zinc-500">{check.url || 'n/a'}</div>
                          </div>
                          <span className={`rounded border px-2.5 py-1 text-sm font-medium ${check.ok ? 'border-zinc-700 bg-zinc-800/50 text-zinc-200' : 'border-red-500/20 bg-red-500/10 text-red-300'}`}>
                            {check.ok ? `HTTP ${check.status ?? 200}` : (check.status ? `HTTP ${check.status}` : 'Unreachable')}
                          </span>
                        </div>
                        <div className="mt-3 text-xs leading-relaxed text-zinc-400">{check.detail}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-[#262626] bg-black px-4 py-6 text-sm text-zinc-500">
                    {canVerifyLiveEndpoints ? 'No live verification has been recorded yet. Run `Verify Live Endpoints` to test the deployed URLs.' : 'Verification is unavailable until the current repo has a successful deploy payload and live runtime details.'}
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6">
                <h3 className="mb-4 text-sm font-semibold text-zinc-200">Deployment History</h3>
                <div className="space-y-3">
                  {deploymentHistory.map((entry) => (
                    <div key={entry.id} className="rounded-md border border-[#1A1A1A] bg-black p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-zinc-200">{new Date(entry.createdAt).toLocaleString()}</p>
                          <p className="mt-1 font-mono text-sm text-zinc-400">EC2: {entry.instanceId}</p>
                        </div>
                        <span className={`rounded border px-2.5 py-1 text-sm font-medium ${entry.status === 'done' ? 'border-zinc-700 bg-zinc-800/50 text-zinc-200' : 'border-red-500/20 bg-red-500/10 text-red-400'}`}>
                          {entry.status === 'done' ? 'Success' : 'Error'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: `.custom-scrollbar::-webkit-scrollbar{width:6px}.custom-scrollbar::-webkit-scrollbar-track{background:transparent}.custom-scrollbar::-webkit-scrollbar-thumb{background-color:#262626;border-radius:10px}.custom-scrollbar::-webkit-scrollbar-thumb:hover{background-color:#3f3f46}` }} />
    </div>
  );
}



