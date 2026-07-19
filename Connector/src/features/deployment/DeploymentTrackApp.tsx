'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, CheckCircle2, ChevronRight, CircleDashed, Download, ExternalLink, RefreshCw, Rocket, Server, Terminal } from 'lucide-react';
import { ResourceCard } from '@/components/pipeline/ResourceCard';
import { ApplyLogViewer } from '@/components/pipeline/ApplyLogViewer';
import { AwsConsoleTerminal } from '@/components/pipeline/AwsConsoleTerminal';
import { buildDeploymentWorkspace } from '@/lib/deployment-planning-contract';
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

type PipelineStageId = 'analysis' | 'qa' | 'architecture' | 'cost_estimation' | 'terraform' | 'aws_config' | 'deploy' | 'outputs';

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
    versions: ['17.2', '16.6', '15.10', '14.15', '13.18'],
    defaultVersion: '16.6',
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
    versions: ['PostgreSQL 17.2', 'PostgreSQL 16.6', 'PostgreSQL 15.10', 'PostgreSQL 14.15'],
    defaultVersion: 'PostgreSQL 17.2',
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
    } else {
      normalized[component] = toRecord(value);
    }
  }
  normalized.ec2 = {
    ...toRecord(normalized.ec2),
    ...ec2Config,
  };
  return normalized;
}

function deploymentPlanToServiceType(planId: DeploymentPlanId): string {
  if (planId === 's3_cloudfront') return 's3';
  if (planId === 'ecs_fargate') return 'ecs';
  return 'ec2';
}

function deploymentPlanComponents(planId: DeploymentPlanId, services: DeploymentServiceSelection): string[] {
  const components = planId === 's3_cloudfront'
    ? ['s3_cloudfront']
    : planId === 'ecs_fargate'
      ? ['vpc', 'alb', 'ecs']
      : ['vpc', 'ec2'];
  if (services.rds) components.push('rds');
  if (services.redis) components.push('elasticache');
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
  const components = deploymentPlanComponents(planId, services);
  const baseStackConfig = normalizeDecisionStackConfigForUi(decision, ec2Config);
  const stackConfig: Record<string, unknown> = {};
  for (const component of components) {
    stackConfig[component] = toRecord(baseStackConfig[component]);
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
  if (compact.includes('vpc') || compact.includes('network')) {
    return 'vpc';
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
  if (key.includes('vpc') || key.includes('alb') || key.includes('nat') || key.includes('subnet')) return 'networking';
  if (key.includes('ecs') || key.includes('ec2') || key.includes('lambda') || key.includes('compute')) return 'compute';
  if (key.includes('rds') || key.includes('redis') || key.includes('cache') || key.includes('db') || key.includes('s3')) return 'data';
  if (key.includes('waf') || key.includes('iam') || key.includes('account')) return 'security';
  return 'observability';
}

function decisionColor(category: DecisionDiagramNode['category']): string {
  if (category === 'networking') return '#3b82f6';
  if (category === 'compute') return '#f97316';
  if (category === 'data') return '#22c55e';
  if (category === 'security') return '#ef4444';
  return '#9ca3af';
}

function componentDetails(component: string, stackConfig: Record<string, unknown>): string[] {
  const config = toRecord(stackConfig[component] || (component === 'ec2' ? stackConfig['ec2-instance'] : undefined));
  const details: string[] = [];
  const key = String(component || '').toLowerCase();

  if (key === 'ecs' || key === 'ec2') {
    const desired = toPositiveNumber(config.desired_count);
    const cpu = toPositiveNumber(config.cpu);
    const memory = toPositiveNumber(config.memory);
    const instanceType = String(config.instance_type || '').trim();
    const appPort = toPositiveNumber(config.app_port);
    const rootVolume = toPositiveNumber(config.root_volume_size_gb);
    if (instanceType) details.push(instanceType);
    if (rootVolume) details.push(`root=${rootVolume}GB`);
    if (appPort) details.push(`port=${appPort}`);
    if (desired) details.push(`desired=${desired}`);
    if (cpu) details.push(`cpu=${cpu}`);
    if (memory) details.push(`memory=${memory}MB`);
    return details.slice(0, 3);
  }

  if (key === 'rds') {
    const instance = String(config.instance_class || '').trim();
    const engine = String(config.engine || '').trim();
    const multiAz = config.multi_az === true;
    if (instance) details.push(instance);
    if (engine) details.push(engine);
    details.push(multiAz ? 'multi-az=true' : 'multi-az=false');
    return details.slice(0, 3);
  }

  if (key === 'elasticache') {
    const nodeType = String(config.node_type || '').trim();
    const engine = String(config.engine || '').trim();
    if (nodeType) details.push(nodeType);
    if (engine) details.push(engine);
    return details.slice(0, 3);
  }

  if (key === 'vpc') {
    const cidr = String(config.cidr_block || '').trim();
    if (cidr) details.push(cidr);
    details.push(config.nat_gateway_enabled === true ? 'nat=true' : 'nat=false');
    return details.slice(0, 3);
  }

  if (key === 's3_cloudfront') {
    const origin = String(config.origin_type || 's3').trim();
    details.push(`origin=${origin}`);
    return details;
  }

  for (const [name, value] of Object.entries(config)) {
    if (details.length >= 3) break;
    if (value === null || value === undefined || value === '') continue;
    details.push(`${name}=${String(value)}`);
  }
  return details;
}

function getDecisionNodeHeight(node: DecisionDiagramNode): number {
  return 54 + Math.min(3, node.details.length) * 12;
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
  const hasVpcBoundary = orderedComponents.includes('vpc');

  const nodes: DecisionDiagramNode[] = [];
  const edges: DecisionDiagramEdge[] = [];
  const entryNodeByComponent = new Map<string, string>();
  const pushNode = (node: DecisionDiagramNode) => {
    if (!nodes.some((item) => item.id === node.id)) nodes.push(node);
  };
  const pushEdge = (edge: DecisionDiagramEdge) => {
    if (!edges.some((item) => item.from === edge.from && item.to === edge.to && item.label === edge.label)) {
      edges.push(edge);
    }
  };

  pushNode({ id: 'internet', label: 'Internet', x: 80, y: 220, color: '#3b82f6', category: 'networking', details: [] });

  const gridPosition = (index: number) => {
    const columns = 4;
    const x = 240 + (index % columns) * 170;
    const y = 80 + Math.floor(index / columns) * 120;
    return { x, y };
  };

  let renderIndex = 0;
  for (const component of orderedComponents) {
    const category = decisionCategory(component);
    const color = decisionColor(category);
    const label = formatComponentName(component);
    const details = componentDetails(component, stackConfig);
    const position = gridPosition(renderIndex);

    if (component === 'rds' && hasMultiAz) {
      const primaryId = 'rds-primary';
      const replicaId = 'rds-replica';
      pushNode({
        id: primaryId,
        label: 'RDS Primary',
        x: position.x,
        y: position.y,
        color,
        category,
        details,
      });
      pushNode({
        id: replicaId,
        label: 'RDS Replica',
        x: Math.min(position.x + 150, 890),
        y: position.y,
        color,
        category,
        details: ['standby'],
      });
      pushEdge({ from: primaryId, to: replicaId, label: 'replication' });
      entryNodeByComponent.set(component, primaryId);
      renderIndex += 2;
      continue;
    }

    const nodeId = component.replace(/[^a-zA-Z0-9_\-]/g, '_');
    pushNode({
      id: nodeId,
      label,
      x: position.x,
      y: position.y,
      color,
      category,
      details,
    });
    entryNodeByComponent.set(component, nodeId);
    renderIndex += 1;
  }

  const chainNodes = orderedComponents
    .map((component) => entryNodeByComponent.get(component) || '')
    .filter(Boolean);
  if (chainNodes.length > 0) {
    pushEdge({ from: 'internet', to: chainNodes[0], label: 'request' });
    for (let index = 1; index < chainNodes.length; index += 1) {
      const prev = chainNodes[index - 1];
      const current = chainNodes[index];
      if (!prev || !current || prev === current) continue;
      pushEdge({ from: prev, to: current, label: 'flow' });
    }
  }

  return {
    awsRegion: String(awsRegion || DEFAULT_AWS_REGION).trim() || DEFAULT_AWS_REGION,
    components,
    nodes,
    edges,
    hasVpcBoundary,
    hasMultiAz,
  };
}

export default function DeploymentTrackApp() {
  const router = useRouter();
  const searchParams = useSearchParams();
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
  const [, setPendingPlanSummary] = useState<Record<string, unknown> | null>(null);
  const [deploymentHistory, setDeploymentHistory] = useState<DeployStateSnapshot['deploymentHistory']>([]);
  const [deploySocketState, setDeploySocketState] = useState<PipelineSocketState>('idle');
  const [socketNotices, setSocketNotices] = useState<SocketNotice[]>([]);
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
    () => (Array.isArray(decisionForVisualization?.consultant_notes)
      ? decisionForVisualization.consultant_notes.map((item) => String(item || '').trim()).filter(Boolean)
      : []),
    [decisionForVisualization?.consultant_notes],
  );
  const decisionSignature = useMemo(
    () => (decisionForVisualization ? JSON.stringify(decisionForVisualization) : ''),
    [decisionForVisualization],
  );
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
  const hasAwsSecrets = Boolean(aws.aws_access_key_id.trim() && aws.aws_secret_access_key.trim());
  const costEstimate = readCostEstimate();
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
    () => deploySummary.cloudfrontUrl !== 'n/a' || deploySummary.publicIp !== 'n/a',
    [deploySummary.cloudfrontUrl, deploySummary.publicIp],
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
  const outputBannerClassName = useMemo(() => {
    if (outputBanner.tone === 'success') return 'border-zinc-700 bg-zinc-800/50 text-zinc-200';
    if (outputBanner.tone === 'error') return 'border-red-500/20 bg-red-500/10 text-red-300';
    return 'border-amber-500/20 bg-amber-500/10 text-amber-300';
  }, [outputBanner.tone]);
  const savedRun = readSavedIacRun();
  const savedIacMeta = readSavedIacMeta();
  const activeSavedRun = useMemo(
    () => getCurrentSavedRun(savedRun, savedIacMeta, selectedProjectId, expectedWorkspace),
    [expectedWorkspace, savedIacMeta, savedRun, selectedProjectId],
  );
  const sessionIacTruncated = useMemo(() => hasTruncatedIacFiles(iacFiles), [iacFiles]);
  const deployableIacFiles = useMemo(() => getDeployableIacFiles(iacFiles), [iacFiles]);
  const shouldUseSavedRunForDeploy = Boolean(activeSavedRun?.run_id);
  const deployStartBlockers = useMemo(() => {
    const blockers: string[] = [];
    if (deployStatus === 'running') {
      blockers.push('Deployment is already running. Stop it or wait for completion.');
    }
    if (!selectedProject) {
      blockers.push('Select a repository before starting deploy.');
    }
    if (!hasAwsSecrets) {
      blockers.push('Add AWS credentials in AWS Config (access key + secret key).');
    }
    if (deployableIacFiles.length === 0 && !shouldUseSavedRunForDeploy) {
      blockers.push('Generate infrastructure after selecting a deployment target and managed services.');
    }
    if (costEstimate.total > costEstimate.cap && !budgetOverride) {
      blockers.push('Estimated monthly cost exceeds the budget cap. Approve the budget override to deploy.');
    }
    return blockers;
  }, [budgetOverride, costEstimate.cap, costEstimate.total, deployStatus, deployableIacFiles.length, hasAwsSecrets, selectedProject, shouldUseSavedRunForDeploy]);
  const canStartDeploy = deployStartBlockers.length === 0;
  const activeIacFilePath = selectedFile || iacFiles[0]?.path || '';
  const hasCurrentIacMeta = useMemo(
    () => matchesCurrentIacWorkspace(savedIacMeta, selectedProjectId, expectedWorkspace),
    [expectedWorkspace, savedIacMeta, selectedProjectId],
  );
  const hasSuccessfulGeneration = useMemo(
    () => hasSuccessfulTerraformGeneration(selectedProjectId, expectedWorkspace, savedIacMeta, activeSavedRun, iacFiles),
    [activeSavedRun, expectedWorkspace, iacFiles, savedIacMeta, selectedProjectId],
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
  const canOpenCloudfront = Boolean(hasLiveRuntimeDetails && deploySummary.cloudfrontUrl !== 'n/a');
  const canOpenApp = Boolean(hasLiveRuntimeDetails && deploySummary.appUrl !== 'n/a');
  const canContinueToAwsConfig = Boolean(approvedConsultantDecision || hasSuccessfulGeneration);
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
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [deployLogs]);

  useEffect(() => {
    writeSavedAws(aws);
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
    if (nextStage === 'terraform' && !approvedConsultantDecision && !hasSuccessfulGeneration) {
      return;
    }
    setActiveStage(nextStage);
    if (selectedProjectId) {
      saveDeployUiStage(selectedProjectId, nextStage);
      localStorage.setItem(`${CURRENT_STAGE_STORAGE_PREFIX}${selectedProjectId}`, nextStage);
    }
  }, [approvedConsultantDecision, canContinueToAwsConfig, hasSuccessfulGeneration, selectedProjectId]);

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
          consultant_decision: currentInfraConsultant?.decision || undefined,
          architecture_json: deploymentProfile || architectureView || consultantArchitectureSeed,
          deployment_profile: deploymentProfile || consultantArchitectureSeed,
          repository_context: repoContext || undefined,
          user_answers: infraUserAnswers,
          aws_region: terraformRuntimeConfig.aws_region.trim() || DEFAULT_AWS_REGION,
          qa_summary: qaSummary,
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

      persistInfraConsultant({
        workspace: expectedWorkspace,
        history: nextHistory,
        repo_detection_summary: String(data.repo_detection_summary || currentInfraConsultant?.repo_detection_summary || ''),
        turn_count: Number(data.consultant_turn_count || (currentInfraConsultant?.turn_count || 0)),
        decision: nextDecision,
        summary: nextSummary,
        confirmed: false,
      });
    } finally {
      setInfraConsultantLoading(false);
    }
  }, [
    consultantArchitectureSeed,
    architectureView,
    currentInfraConsultant?.repo_detection_summary,
    currentInfraConsultant?.decision,
    currentInfraConsultant?.turn_count,
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
        budget_cap_usd: Number(costEstimate.cap || 100),
      });
    } finally {
      setDecisionCostLoading(false);
    }
  }, [costEstimate.cap, selectedProject, terraformRuntimeConfig.aws_region]);

  useEffect(() => {
    if (!decisionForVisualization || !selectedProject) return;
    if (!['architecture', 'cost_estimation'].includes(activeStage)) return;
    if (!currentInfraConsultant?.confirmed && !approvedConsultantDecision) return;

    const requestKey = `${selectedProject.id}:${expectedWorkspace}:${decisionSignature}`;
    if (decisionCostRequestKeyRef.current === requestKey && decisionCostEstimate) return;
    decisionCostRequestKeyRef.current = requestKey;
    void fetchDecisionCostEstimate(decisionForVisualization).catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : 'Failed to estimate AWS monthly cost.';
      setDecisionCostError(message);
      setError(message);
    });
  }, [
    activeStage,
    approvedConsultantDecision,
    currentInfraConsultant?.confirmed,
    decisionCostEstimate,
    decisionForVisualization,
    decisionSignature,
    expectedWorkspace,
    fetchDecisionCostEstimate,
    selectedProject,
  ]);

  const generateTerraform = useCallback(async (): Promise<boolean> => {
    if (!selectedProject) return false;
    setError(null);
    setIacPrUrl(null);
    setTerraformGenerating(true);
    appendLog('Starting infrastructure generation from the confirmed deployment profile.', 'info', { stage: 'terraform_generation' });
    try {
      const response = await fetch('/api/pipeline/iac', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const message = reason instanceof Error ? reason.message : 'Infrastructure generation failed.';
      appendLog(message, 'error', { stage: 'terraform_generation' });
      throw reason;
    } finally {
      setTerraformGenerating(false);
    }
  }, [appendLog, approvalPayload, approvedConsultantDecision, architectureView, consultantArchitectureSeed, deploymentProfile, expectedWorkspace, infraUserAnswers, qaSummary, repoContext, selectedProject, terraformRuntimeConfig.aws_region, terraformRuntimeConfigWasStored]);

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
    const nextHistory: InfraConsultantMessage[] = [...priorHistory, { role: 'user', content: message }];
    persistInfraConsultant({
      workspace: expectedWorkspace,
      history: nextHistory,
      repo_detection_summary: currentInfraConsultant?.repo_detection_summary || '',
      turn_count: currentInfraConsultant?.turn_count || 0,
      decision: null,
      summary: '',
      confirmed: false,
    });
    setInfraConsultantInput('');
    await runInfraConsultantTurn(
      (currentInfraConsultant?.turn_count || 0) >= 20 ? 'force_decision' : 'reply',
      nextHistory,
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
    persistInfraConsultant({
      ...currentInfraConsultant,
      decision: approvedDecision,
      summary: summarizeInfraConsultantDecision(approvedDecision),
      confirmed: true,
    });
    persistApprovedDecision({
      workspace: expectedWorkspace,
      decision: approvedDecision,
      locked_at: new Date().toISOString(),
    });
  }, [currentInfraConsultant, deploymentSelectionDecision, expectedWorkspace, persistApprovedDecision, persistInfraConsultant]);

  const rejectInfraConsultantDecision = useCallback(async () => {
    if (!currentInfraConsultant) return;
    const nextHistory: InfraConsultantMessage[] = [
      ...currentInfraConsultant.history,
      { role: 'user', content: 'No. Keep refining the plan and ask the next thing you need to make this production-safe.' },
    ];
    persistInfraConsultant({
      ...currentInfraConsultant,
      history: nextHistory,
      decision: null,
      summary: '',
      confirmed: false,
    });
    await runInfraConsultantTurn('reply', nextHistory);
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
    const activeDeployment = getOrCreateActiveDeployment(selectedProject.id, {
      status: deployStatus,
      progress: deployProgress,
      logs: deployLogs,
      deployResult,
      deploymentHistory,
    });

    if (activeDeployment.inFlight) {
      activeDeployment.inFlight = false;
    }
    if (deployRequestRef.current === selectedProject.id) {
      deployRequestRef.current = null;
    }

    if (activeDeployment.inFlight) {
      setError('Deployment already running in background for this project.');
      appendLog('Deployment already running in background for this project.');
      return;
    }

    // Start each deploy attempt with a fresh websocket/log console instead of appending
    // lines from a previous failed/completed run.
    socketNoticeKeysRef.current.clear();
    setSocketNotices([]);
    patchState((prev) => ({
      ...prev,
      progress: 0,
      logs: [],
      deployResult: null,
    }));

    appendLog('Deploy button clicked. Running preflight checks...');
    activeDeployment.inFlight = true;
    if (!hasAwsSecrets) {
      setError('AWS credentials are required before deployment.');
      patchState({
        status: 'error',
        progress: 100,
        deployResult: { success: false, error: 'AWS credentials are required before deployment.' },
      });
      appendLog('AWS credentials are missing. Configure them first.', 'error');
      activeDeployment.inFlight = false;
      return;
    }
    deployRequestRef.current = selectedProject.id;
    setError(null);
    patchState((prev) => ({
      ...prev,
      status: 'running',
      progress: prev.status === 'running' ? Math.max(prev.progress, 5) : 5,
    }));
    setEndpointChecks([]);
    appendLog('Preparing runtime deploy payload...');
    try {
      patchState({ progress: 20 });
      if (requiresPlanConfirmation) {
        appendLog('Plan confirmation acknowledged. Submitting confirmed apply request...', 'info');
      } else {
        setPendingPlanSummary(null);
      }
      appendLog('Calling /api/pipeline/deploy for runtime apply...');
      const runtimeDeployFiles = deployableIacFiles;
      const canReuseSavedRun = shouldUseSavedRunForDeploy && runtimeDeployFiles.length === 0;
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
          confirm_plan_summary: requiresPlanConfirmation,
          user_answers: infraUserAnswers,
          estimated_monthly_usd: costEstimate.total,
          budget_limit_usd: costEstimate.cap,
          budget_override: budgetOverride,
        }),
      });
      const data = await response.json().catch(() => ({})) as DeployApiResult;
      if (!response.ok || !data.success) {
        const message = data.error || 'Deployment failed.';
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
        setRequiresPlanConfirmation(true);
        setPendingPlanSummary(summary);
        patchState((prev) => ({
          ...prev,
          status: 'idle',
          progress: Math.max(prev.progress, 60),
          deployResult: data,
        }));
        appendLog(summarizePlanResources(summary), 'info');
        appendLog('Review the plan summary and click Start Deploy again to confirm and continue.', 'info');
        return;
      }

      setRequiresPlanConfirmation(false);
      setPendingPlanSummary(null);
      patchState((prev) => ({
        ...prev,
        status: 'running',
        progress: Math.max(prev.progress, 80),
        deployResult: data,
      }));
      appendLog('Runtime apply request returned. Waiting for backend runtime to reach a terminal state...');
      try {
        if (data.mode === 'iac_pipeline' && data.run_id) {
          appendLog('IaC pipeline started. Polling for completion...');
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
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Deployment failed.';
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
    }
  }, [activeSavedRun, appendLog, approvedConsultantDecision, aws.aws_access_key_id, aws.aws_secret_access_key, aws.aws_session_token, budgetOverride, costEstimate.cap, costEstimate.total, deployLogs, deployProgress, deployResult, deployStatus, deployableIacFiles, deploymentHistory, deploymentPlan, deploymentProfile, hasAwsSecrets, infraUserAnswers, patchState, pushDeploymentHistory, reconcileDeploymentStatus, repoContext, requiresPlanConfirmation, selectedDeploymentComponents, selectedProject, shouldUseSavedRunForDeploy, terraformRuntimeConfig.aws_region, terraformRuntimeConfig.lock_table, terraformRuntimeConfig.state_bucket]);

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
  }, [deployStatus, deploySummary.appUrl, deploySummary.cloudfrontUrl, deploySummary.publicIp, patchState]);

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
  const qaLiveConsultantView = (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="border-b border-[#1A1A1A] py-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Infrastructure Consultant Chat</h1>
            <p className="text-sm text-zinc-400">Live conversation replaces the static form. Confirm the consultant decision, then continue to Architecture Diagram and Cost.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
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
                });
                setInfraConsultantInput('');
                void runInfraConsultantTurn('start', []).catch((reason: unknown) => {
                  setError(reason instanceof Error ? reason.message : 'Failed to start infra consultant.');
                });
              }}
              disabled={infraConsultantLoading || !selectedProject || !repoContext || repoContext.workspace !== expectedWorkspace}
              className="rounded-md border border-[#262626] bg-[#111111] px-4 py-2 text-sm font-semibold text-zinc-200 hover:bg-[#181818] disabled:bg-[#111111] disabled:text-zinc-500"
            >
              {currentInfraConsultant?.history?.length ? 'Restart Chat' : 'Start Chat'}
            </button>
            <button
              onClick={() => setAndPersistStage('architecture')}
              disabled={!canContinueFromQa}
              className="flex items-center gap-2 rounded-md bg-zinc-100 px-5 py-2 text-sm font-semibold text-black hover:bg-white disabled:bg-[#111111] disabled:text-zinc-500"
            >
              Continue to Architecture
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 flex min-h-112 flex-col overflow-hidden rounded-lg border border-[#262626] bg-[#0a0a0a]">
          <div className="border-b border-[#262626] px-5 py-4">
            <div className="text-sm font-semibold text-zinc-100">Infra Consultant</div>
            <div className="mt-1 text-xs text-zinc-500">One question at a time. The assistant will challenge unsafe assumptions before it returns a final component plan.</div>
          </div>
          <div className="custom-scrollbar flex-1 space-y-4 overflow-y-auto p-5">
            {currentInfraConsultant?.history?.length ? currentInfraConsultant.history.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className={`max-w-[88%] rounded-2xl border px-4 py-3 text-sm leading-relaxed ${
                  message.role === 'assistant'
                    ? 'border-zinc-700 bg-zinc-800/50 text-zinc-200'
                    : 'ml-auto border-[#262626] bg-[#111111] text-zinc-200'
                }`}
              >
                <div className="mb-2 text-xs font-semibold text-zinc-400">
                  {message.role === 'assistant' ? 'Consultant' : 'You'}
                </div>
                <div className="whitespace-pre-wrap">{message.content}</div>
              </div>
            )) : (
              <div className="text-sm text-zinc-500">
                {infraConsultantLoading ? 'Consultant is reviewing the repo and opening the conversation...' : 'Chat will start automatically in Questions stage.'}
              </div>
            )}
          </div>
          <div className="border-t border-[#262626] p-4">
            {currentInfraConsultant?.decision ? (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => approveInfraConsultantDecision()}
                  disabled={infraConsultantLoading || currentInfraConsultant.confirmed}
                  className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-semibold text-black hover:bg-white disabled:bg-[#111111] disabled:text-zinc-500"
                >
                  {currentInfraConsultant.confirmed ? 'Build Approved' : 'Build this'}
                </button>
                <button
                  onClick={() => void rejectInfraConsultantDecision().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Failed to continue the infra conversation.'))}
                  disabled={infraConsultantLoading}
                  className="rounded-md border border-[#262626] bg-[#111111] px-4 py-2 text-sm font-semibold text-zinc-200 hover:bg-[#181818] disabled:text-zinc-500"
                >
                  No, keep refining
                </button>
                {currentInfraConsultant.confirmed ? (
                  <div className="text-xs text-zinc-300">Approved. Continue to Architecture Diagram and Cost.</div>
                ) : (
                  <div className="text-xs text-zinc-500">Review the decision summary and confirm when you are ready.</div>
                )}
              </div>
            ) : (
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
                  placeholder="Reply to the consultant"
                  className="min-h-18 flex-1 resize-none rounded-xl border border-[#262626] bg-[#111] px-4 py-3 text-sm text-zinc-200 outline-none transition-colors placeholder:text-zinc-600 focus:border-zinc-500"
                />
                <button
                  onClick={() => void submitInfraConsultantMessage().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Failed to continue the infra conversation.'))}
                  disabled={infraConsultantLoading || !infraConsultantInput.trim()}
                  className="self-end rounded-xl bg-white px-5 py-3 text-sm font-semibold text-black hover:bg-zinc-200 disabled:bg-[#111111] disabled:text-zinc-500"
                >
                  {infraConsultantLoading ? 'Thinking...' : 'Send'}
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="space-y-6">
          <div className="rounded-lg border border-[#262626] bg-[#0a0a0a] p-5">
            <div className="mb-3 text-xs font-semibold text-zinc-400">Service Decision</div>
            <div className="space-y-3">
              {DEPLOYMENT_PLAN_OPTIONS.map((option) => {
                const selected = deploymentPlan === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => handleDeploymentPlanChange(option.id)}
                    disabled={infraConsultantLoading || deployStatus === 'running'}
                    className={`w-full rounded-md border px-3 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                      selected
                        ? 'border-zinc-400 bg-zinc-800 text-zinc-100'
                        : 'border-[#262626] bg-black text-zinc-300 hover:border-zinc-600 hover:bg-[#0A0A0A]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold">{option.label}</div>
                        <div className="mt-1 text-xs leading-relaxed text-zinc-500">{option.description}</div>
                      </div>
                      {selected ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-indigo-300" /> : null}
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => handleDeploymentServiceToggle('rds')}
                disabled={infraConsultantLoading || deployStatus === 'running'}
                className={`rounded-md border px-3 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  deploymentServices.rds
                    ? 'border-blue-500/40 bg-blue-500/10 text-blue-300'
                    : 'border-[#262626] bg-black text-zinc-400 hover:border-zinc-600'
                }`}
              >
                <div className="font-semibold">RDS</div>
                <div className="mt-1 text-sm text-zinc-500">Managed SQL</div>
              </button>
              <button
                type="button"
                onClick={() => handleDeploymentServiceToggle('redis')}
                disabled={infraConsultantLoading || deployStatus === 'running'}
                className={`rounded-md border px-3 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  deploymentServices.redis
                    ? 'border-blue-500/40 bg-blue-500/10 text-blue-300'
                    : 'border-[#262626] bg-black text-zinc-400 hover:border-zinc-600'
                }`}
              >
                <div className="font-semibold">Redis</div>
                <div className="mt-1 text-sm text-zinc-500">Managed cache</div>
              </button>
            </div>
            {deploymentServices.rds ? (() => {
              const rdsMeta = RDS_ENGINE_META[rdsResourceConfig.engine];
              const isAurora = rdsMeta.supportsAurora;
              const isServerless = isAurora && rdsResourceConfig.instance_class === 'db.serverless';
              const isSelfManaged = rdsResourceConfig.credentials_mode !== 'secrets_manager';
              const showPassword = isSelfManaged && !rdsResourceConfig.auto_generate_password;

              // Per-engine instance size tiers (non-Aurora only)
              const instanceSizeTiers = [
                { id: 'production' as const, label: 'Production', hint: rdsMeta.instanceClasses.find(c => c.includes('r8g')) || rdsMeta.instanceClasses[rdsMeta.instanceClasses.length - 1], cost: 'High availability' },
                { id: 'dev_test' as const, label: 'Dev/Test', hint: rdsMeta.instanceClasses.find(c => c.includes('t3.medium')) || rdsMeta.instanceClasses[2] || rdsMeta.instanceClasses[0], cost: 'Lower cost' },
                { id: 'free_tier' as const, label: 'Free tier', hint: rdsMeta.instanceClasses[0], cost: 'Free eligible' },
              ].filter(t => !(t.id === 'free_tier' && !['postgres', 'mysql'].includes(rdsResourceConfig.engine)));

              // Instance class derived from tier
              const tierToClass: Record<string, string> = {
                production: rdsMeta.instanceClasses[rdsMeta.instanceClasses.length - 1],
                dev_test: rdsMeta.instanceClasses.find(c => c.includes('t3.medium') || c.includes('t4g.small')) || rdsMeta.instanceClasses[1] || rdsMeta.instanceClasses[0],
                free_tier: rdsMeta.instanceClasses[0],
              };

              return (
                <div className="mt-4 space-y-0 overflow-hidden rounded-lg border border-[#262626] bg-[#0a0a0a]">
                  {/* Header */}
                  <div className="flex items-center justify-between border-b border-[#262626] px-4 py-3">
                    <div className="text-sm font-bold uppercase tracking-widest text-zinc-400">Database Configuration</div>
                    {isAurora && (
                      <div className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-300 ring-1 ring-inset ring-zinc-700">
                        Aurora Cluster
                      </div>
                    )}
                  </div>

                  <div className="space-y-5 p-4">

                    {/* ── Engine Type ── */}
                    <div>
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Engine type</div>
                      <div className="grid grid-cols-2 gap-1.5">
                        {RDS_ENGINES.map((eng) => {
                          const meta = RDS_ENGINE_META[eng];
                          const isSelected = rdsResourceConfig.engine === eng;
                          return (
                            <button
                              key={eng}
                              type="button"
                              disabled={infraConsultantLoading || deployStatus === 'running'}
                              onClick={() => handleRdsResourceConfigChange({
                                engine: eng,
                                engine_version: meta.defaultVersion,
                                instance_class: meta.defaultInstanceClass,
                                allocated_storage: meta.defaultStorage,
                                multi_az: false,
                                instance_size_tier: 'free_tier',
                                aurora_mode: meta.supportsAurora ? 'serverless' : undefined,
                                master_username: ['oracle-ee', 'sqlserver-ex'].includes(eng) ? 'admin' : 'postgres',
                                storage_type: 'gp3',
                              })}
                              className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                                isSelected
                                  ? 'border-blue-500/40 bg-blue-500/10 ring-1 ring-inset ring-blue-500/20'
                                  : 'border-[#262626] bg-[#111] hover:border-zinc-500'
                              }`}
                            >
                              <div className="min-w-0 flex-1">
                                <div className={`truncate text-sm font-semibold leading-tight ${isSelected ? 'text-blue-300' : 'text-zinc-300'}`}>{meta.label}</div>
                                <div className="mt-0.5 truncate text-xs text-zinc-500">{meta.defaultVersion}</div>
                              </div>
                              {isSelected && (
                                <div className="size-1.5 shrink-0 rounded-full bg-blue-400" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* ── License note ── */}
                    {rdsMeta.licenseNote && (
                      <div className="rounded-md border border-amber-500/20 bg-amber-950/30 px-3 py-2 text-sm leading-relaxed text-amber-300/80">
                        ⚠ {rdsMeta.licenseNote}
                      </div>
                    )}

                    {/* ── DB Instance Type (Aurora only: Serverless vs Provisioned) ── */}
                    {isAurora && (
                      <div>
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">DB instance type</div>
                        <div className="grid grid-cols-2 gap-1.5">
                          {[
                            { mode: 'serverless' as const, label: 'Serverless v2', desc: 'Auto vertical scaling' },
                            { mode: 'provisioned' as const, label: 'Provisioned', desc: 'Fixed instance class' },
                          ].map(({ mode, label, desc }) => {
                            const active = mode === 'serverless' ? isServerless : !isServerless;
                            return (
                              <button
                                key={mode}
                                type="button"
                                disabled={infraConsultantLoading || deployStatus === 'running'}
                                onClick={() => handleRdsResourceConfigChange({
                                  instance_class: mode === 'serverless' ? 'db.serverless' : (rdsMeta.instanceClasses.find(c => c !== 'db.serverless') || rdsMeta.defaultInstanceClass),
                                  aurora_mode: mode,
                                })}
                                className={`rounded-md border px-3 py-2.5 text-left text-xs transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                                  active
                                    ? 'border-blue-500/40 bg-blue-500/10 ring-1 ring-inset ring-blue-500/20'
                                    : 'border-[#262626] bg-[#111] hover:border-zinc-500'
                                }`}
                              >
                                <div className={`font-semibold ${active ? 'text-blue-300' : 'text-zinc-300'}`}>{label}</div>
                                <div className="mt-0.5 text-xs text-zinc-500">{desc}</div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* ── DB Instance Size (non-Aurora) ── */}
                    {!isAurora && (
                      <div>
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">DB instance size</div>
                        <div className="space-y-1.5">
                          {instanceSizeTiers.map(({ id, label, hint, cost }) => {
                            const active = rdsResourceConfig.instance_size_tier === id;
                            return (
                              <button
                                key={id}
                                type="button"
                                disabled={infraConsultantLoading || deployStatus === 'running'}
                                onClick={() => handleRdsResourceConfigChange({ instance_size_tier: id, instance_class: tierToClass[id] || rdsMeta.defaultInstanceClass })}
                                className={`w-full rounded-md border px-3 py-2.5 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                                  active
                                    ? 'border-blue-500/40 bg-blue-500/10 ring-1 ring-inset ring-blue-500/20'
                                    : 'border-[#262626] bg-[#111] hover:border-zinc-500'
                                }`}
                              >
                                <div className="flex items-center justify-between">
                                  <span className={`text-xs font-semibold ${active ? 'text-blue-300' : 'text-zinc-300'}`}>{label}</span>
                                  <span className="text-xs text-zinc-500">{cost}</span>
                                </div>
                                <div className="mt-0.5 font-mono text-xs text-zinc-500">{hint}</div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* ── Engine version + Instance class (provisioned Aurora or non-Aurora) ── */}
                    <div className="grid grid-cols-2 gap-3">
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium text-zinc-400">Engine version</span>
                        <select
                          value={rdsResourceConfig.engine_version}
                          onChange={(event) => handleRdsResourceConfigChange({ engine_version: event.target.value })}
                          disabled={infraConsultantLoading || deployStatus === 'running'}
                          className="w-full rounded-md border border-[#262626] bg-[#111] px-2.5 py-2 text-xs text-zinc-200 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {rdsMeta.versions.map((v) => (<option key={v} value={v}>{v}</option>))}
                        </select>
                      </label>
                      {(!isAurora || !isServerless) && (
                        <label className="block">
                          <span className="mb-1 block text-sm font-medium text-zinc-400">Instance class</span>
                          <select
                            value={rdsResourceConfig.instance_class}
                            onChange={(event) => handleRdsResourceConfigChange({ instance_class: event.target.value })}
                            disabled={infraConsultantLoading || deployStatus === 'running'}
                            className="w-full rounded-md border border-[#262626] bg-[#111] px-2.5 py-2 text-xs text-zinc-200 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {rdsMeta.instanceClasses.filter(c => c !== 'db.serverless').map((cls) => (<option key={cls} value={cls}>{cls}</option>))}
                          </select>
                        </label>
                      )}
                    </div>

                    {/* ── Aurora Serverless ACU settings ── */}
                    {isAurora && isServerless && (
                      <div>
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Capacity settings</div>
                        <div className="grid grid-cols-3 gap-3">
                          <label className="block">
                            <span className="mb-1 block text-sm font-medium text-zinc-400">Min ACU</span>
                            <input
                              type="number"
                              min={0}
                              max={rdsResourceConfig.aurora_max_acu ?? 256}
                              step={0.5}
                              value={rdsResourceConfig.aurora_min_acu ?? 0}
                              onChange={(e) => handleRdsResourceConfigChange({ aurora_min_acu: Number(e.target.value) })}
                              disabled={infraConsultantLoading || deployStatus === 'running'}
                              className="w-full rounded-md border border-[#262626] bg-[#111] px-2.5 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                            />
                            <div className="mt-0.5 text-xs text-zinc-600">0 = scale to 0</div>
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-sm font-medium text-zinc-400">Max ACU</span>
                            <input
                              type="number"
                              min={1}
                              max={256}
                              step={0.5}
                              value={rdsResourceConfig.aurora_max_acu ?? 4}
                              onChange={(e) => handleRdsResourceConfigChange({ aurora_max_acu: Number(e.target.value) })}
                              disabled={infraConsultantLoading || deployStatus === 'running'}
                              className="w-full rounded-md border border-[#262626] bg-[#111] px-2.5 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                            />
                            <div className="mt-0.5 text-xs text-zinc-600">1–256 in 0.5</div>
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-sm font-medium text-zinc-400">Pause (s)</span>
                            <input
                              type="number"
                              min={300}
                              max={86400}
                              value={rdsResourceConfig.aurora_pause_after_inactivity ?? 300}
                              onChange={(e) => handleRdsResourceConfigChange({ aurora_pause_after_inactivity: Number(e.target.value) })}
                              disabled={infraConsultantLoading || deployStatus === 'running'}
                              className="w-full rounded-md border border-[#262626] bg-[#111] px-2.5 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                            />
                            <div className="mt-0.5 text-xs text-zinc-600">300–86400</div>
                          </label>
                        </div>
                      </div>
                    )}

                    {/* ── Storage (non-Aurora) ── */}
                    {!isAurora && (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          <label className="block">
                            <span className="mb-1 block text-sm font-medium text-zinc-400">Storage type</span>
                            <select
                              value={rdsResourceConfig.storage_type}
                              onChange={(e) => handleRdsResourceConfigChange({ storage_type: e.target.value as 'gp3' | 'gp2' | 'io1' | 'standard' })}
                              disabled={infraConsultantLoading || deployStatus === 'running'}
                              className="w-full rounded-md border border-[#262626] bg-[#111] px-2.5 py-2 text-xs text-zinc-200 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <option value="gp3">General Purpose SSD (gp3)</option>
                              <option value="gp2">General Purpose SSD (gp2)</option>
                              <option value="io1">Provisioned IOPS (io1)</option>
                              <option value="standard">Magnetic (standard)</option>
                            </select>
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-sm font-medium text-zinc-400">Allocated storage (GB)</span>
                            <input
                              type="number"
                              min={rdsMeta.minStorage}
                              max={4096}
                              value={rdsResourceConfig.allocated_storage}
                              onChange={(e) => handleRdsResourceConfigChange({ allocated_storage: Number(e.target.value) })}
                              disabled={infraConsultantLoading || deployStatus === 'running'}
                              className="w-full rounded-md border border-[#262626] bg-[#111] px-2.5 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                            />
                          </label>
                        </div>
                        <label className="flex cursor-pointer items-center gap-2.5">
                          <input
                            type="checkbox"
                            checked={rdsResourceConfig.storage_autoscaling ?? true}
                            onChange={(e) => handleRdsResourceConfigChange({ storage_autoscaling: e.target.checked })}
                            disabled={infraConsultantLoading || deployStatus === 'running'}
                            className="size-3.5 rounded border-zinc-600 bg-black accent-zinc-500"
                          />
                          <span className="text-sm text-zinc-400">Enable storage autoscaling</span>
                        </label>
                        {rdsResourceConfig.storage_autoscaling && (
                          <label className="block">
                            <span className="mb-1 block text-sm font-medium text-zinc-400">Maximum storage threshold (GB)</span>
                            <input
                              type="number"
                              min={rdsResourceConfig.allocated_storage}
                              max={65536}
                              value={rdsResourceConfig.max_allocated_storage}
                              onChange={(e) => handleRdsResourceConfigChange({ max_allocated_storage: Number(e.target.value) })}
                              disabled={infraConsultantLoading || deployStatus === 'running'}
                              className="w-full rounded-md border border-[#262626] bg-[#111] px-2.5 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                            />
                          </label>
                        )}
                      </div>
                    )}

                    {/* ── Aurora cluster storage ── */}
                    {isAurora && (
                      <div>
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Cluster storage configuration</div>
                        <div className="grid grid-cols-2 gap-1.5">
                          {[
                            { mode: 'standard' as const, label: 'Aurora Standard', desc: 'Pay per request' },
                            { mode: 'io_optimized' as const, label: 'Aurora I/O-Optimized', desc: 'Predictable pricing' },
                          ].map(({ mode, label, desc }) => {
                            const active = rdsResourceConfig.aurora_cluster_storage_type === mode;
                            return (
                              <button
                                key={mode}
                                type="button"
                                disabled={infraConsultantLoading || deployStatus === 'running'}
                                onClick={() => handleRdsResourceConfigChange({ aurora_cluster_storage_type: mode })}
                                className={`rounded-md border px-3 py-2.5 text-left text-xs transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                                  active
                                    ? 'border-blue-500/40 bg-blue-500/10 ring-1 ring-inset ring-blue-500/20'
                                    : 'border-[#262626] bg-[#111] hover:border-zinc-500'
                                }`}
                              >
                                <div className={`font-semibold ${active ? 'text-blue-300' : 'text-zinc-300'}`}>{label}</div>
                                <div className="mt-0.5 text-xs text-zinc-500">{desc}</div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* ── High Availability & Backups ── */}
                    <div className="grid grid-cols-2 gap-3">
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium text-zinc-400">Backups (days)</span>
                        <input
                          type="number"
                          min={0}
                          max={35}
                          value={rdsResourceConfig.backup_retention_period}
                          onChange={(e) => handleRdsResourceConfigChange({ backup_retention_period: Number(e.target.value) })}
                          disabled={infraConsultantLoading || deployStatus === 'running'}
                          className="w-full rounded-md border border-[#262626] bg-[#111] px-2.5 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                        />
                      </label>
                      {isAurora ? (
                        <label className="block">
                          <span className="mb-1 block text-sm font-medium text-zinc-400">Aurora Replicas</span>
                          <select
                            value={rdsResourceConfig.aurora_replica_count}
                            onChange={(e) => handleRdsResourceConfigChange({ aurora_replica_count: Number(e.target.value) })}
                            disabled={infraConsultantLoading || deployStatus === 'running'}
                            className="w-full rounded-md border border-[#262626] bg-[#111] px-2.5 py-2 text-xs text-zinc-200 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <option value={0}>0 (Single instance)</option>
                            <option value={1}>1 (Multi-AZ)</option>
                            <option value={2}>2 (High availability)</option>
                            <option value={3}>3 (Scale read)</option>
                          </select>
                        </label>
                      ) : (
                        rdsMeta.supportsMultiAz && (
                          <label className="block">
                            <span className="mb-1 block text-sm font-medium text-zinc-400">Availability</span>
                            <select
                              value={rdsResourceConfig.multi_az ? 'true' : 'false'}
                              onChange={(e) => handleRdsResourceConfigChange({ multi_az: e.target.value === 'true' })}
                              disabled={infraConsultantLoading || deployStatus === 'running'}
                              className="w-full rounded-md border border-[#262626] bg-[#111] px-2.5 py-2 text-xs text-zinc-200 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <option value="false">Single DB instance</option>
                              <option value="true">Multi-AZ deployment</option>
                            </select>
                          </label>
                        )
                      )}
                    </div>

                    {/* ── Public Access & Deletion Protection ── */}
                    <div className="grid grid-cols-2 gap-3">
                      <label className="flex cursor-pointer items-center gap-2.5">
                        <input
                          type="checkbox"
                          checked={rdsResourceConfig.publicly_accessible ?? false}
                          onChange={(e) => handleRdsResourceConfigChange({ publicly_accessible: e.target.checked })}
                          disabled={infraConsultantLoading || deployStatus === 'running'}
                          className="size-3.5 rounded border-zinc-600 bg-black accent-zinc-500"
                        />
                        <span className="text-sm text-zinc-400">Publicly accessible</span>
                      </label>
                      <label className="flex cursor-pointer items-center gap-2.5">
                        <input
                          type="checkbox"
                          checked={rdsResourceConfig.deletion_protection ?? false}
                          onChange={(e) => handleRdsResourceConfigChange({ deletion_protection: e.target.checked })}
                          disabled={infraConsultantLoading || deployStatus === 'running'}
                          className="size-3.5 rounded border-zinc-600 bg-black accent-zinc-500"
                        />
                        <span className="text-sm text-zinc-400">Deletion protection</span>
                      </label>
                    </div>

                    {/* ── DB Identifier + Master Username ── */}
                    <div className="grid grid-cols-2 gap-3">
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium text-zinc-400">DB identifier</span>
                        <input
                          type="text"
                          value={rdsResourceConfig.db_identifier ?? 'database-1'}
                          onChange={(e) => handleRdsResourceConfigChange({ db_identifier: e.target.value })}
                          placeholder="database-1"
                          disabled={infraConsultantLoading || deployStatus === 'running'}
                          className="w-full rounded-md border border-[#262626] bg-[#111] px-2.5 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium text-zinc-400">Master username</span>
                        <input
                          type="text"
                          value={rdsResourceConfig.master_username ?? 'admin'}
                          onChange={(e) => handleRdsResourceConfigChange({ master_username: e.target.value })}
                          placeholder="admin"
                          disabled={infraConsultantLoading || deployStatus === 'running'}
                          className="w-full rounded-md border border-[#262626] bg-[#111] px-2.5 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                        />
                      </label>
                    </div>

                    {/* ── Credentials management ── */}
                    <div>
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Credentials management</div>
                      <div className="grid grid-cols-2 gap-1.5">
                        {[
                          { mode: 'secrets_manager' as const, label: 'AWS Secrets Manager', desc: 'Most secure' },
                          { mode: 'self_managed' as const, label: 'Self managed', desc: 'Manage your own password' },
                        ].map(({ mode, label, desc }) => {
                          const active = rdsResourceConfig.credentials_mode === mode;
                          return (
                            <button
                              key={mode}
                              type="button"
                              disabled={infraConsultantLoading || deployStatus === 'running'}
                              onClick={() => handleRdsResourceConfigChange({ credentials_mode: mode })}
                              className={`rounded-md border px-3 py-2.5 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                                active
                                  ? 'border-blue-500/40 bg-blue-500/10 ring-1 ring-inset ring-blue-500/20'
                                  : 'border-[#262626] bg-[#111] hover:border-zinc-500'
                              }`}
                            >
                              <div className={`text-sm font-semibold ${active ? 'text-blue-300' : 'text-zinc-300'}`}>{label}</div>
                              <div className="mt-0.5 text-xs text-zinc-500">{desc}</div>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* ── Auto-generate password + Password fields (self managed only) ── */}
                    {isSelfManaged && (
                      <div className="space-y-3">
                        <label className="flex cursor-pointer items-center gap-2.5">
                          <input
                            type="checkbox"
                            checked={rdsResourceConfig.auto_generate_password ?? false}
                            onChange={(e) => handleRdsResourceConfigChange({ auto_generate_password: e.target.checked })}
                            disabled={infraConsultantLoading || deployStatus === 'running'}
                            className="size-3.5 rounded border-zinc-600 bg-black accent-zinc-500"
                          />
                          <span className="text-sm text-zinc-400">Auto generate password</span>
                        </label>
                        {showPassword && (
                          <div className="grid grid-cols-1 gap-3">
                            <label className="block">
                              <span className="mb-1 block text-sm font-medium text-zinc-400">Master password</span>
                              <input
                                type="password"
                                value={rdsResourceConfig.master_password ?? ''}
                                onChange={(e) => handleRdsResourceConfigChange({ master_password: e.target.value })}
                                placeholder="Min 8 characters"
                                disabled={infraConsultantLoading || deployStatus === 'running'}
                                className="w-full rounded-md border border-[#262626] bg-[#111] px-2.5 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                              />
                              <div className="mt-0.5 text-xs text-zinc-600">At least 8 printable ASCII characters. Cannot contain / {`"`} @</div>
                            </label>
                          </div>
                        )}
                      </div>
                    )}

                  </div>
                </div>
              );
            })() : null}

            {deploymentServices.redis ? (

              <div className="mt-4 rounded-md border border-[#262626] bg-[#0a0a0a] p-4">
                <div className="mb-3 text-xs font-semibold tracking-wide text-zinc-400">Redis Settings</div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-xs font-medium text-zinc-400">
                    <span className="mb-1 block">Node type</span>
                    <select
                      value={redisResourceConfig.node_type}
                      onChange={(event) => handleRedisResourceConfigChange({ node_type: event.target.value })}
                      disabled={infraConsultantLoading || deployStatus === 'running'}
                      className="w-full rounded-md border border-[#262626] bg-[#111] px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {REDIS_NODE_TYPES.map((node) => (<option key={node} value={node}>{node}</option>))}
                    </select>
                  </label>
                  <label className="block text-xs font-medium text-zinc-400">
                    <span className="mb-1 block">Engine version</span>
                    <select
                      value={redisResourceConfig.engine_version}
                      onChange={(event) => handleRedisResourceConfigChange({ engine_version: event.target.value })}
                      disabled={infraConsultantLoading || deployStatus === 'running'}
                      className="w-full rounded-md border border-[#262626] bg-[#111] px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {REDIS_ENGINE_VERSIONS.map((version) => (<option key={version} value={version}>{version}</option>))}
                    </select>
                  </label>
                </div>
              </div>
            ) : null}
            <div className="mt-4 rounded-md border border-[#1A1A1A] bg-black px-3 py-2 text-xs text-zinc-500">
              Components: <span className="font-mono text-zinc-300">{selectedDeploymentComponents.map(formatComponentName).join(' / ')}</span>
            </div>
            {currentInfraConsultant?.confirmed ? (
              <div className="mt-3 text-xs text-zinc-200">This service decision is approved for Architecture, Cost, and Terraform.</div>
            ) : (
              <div className="mt-3 text-xs text-zinc-500">Choose services here, then approve the consultant decision.</div>
            )}
          </div>
          {deploymentPlan === 'ec2' ? (
            <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-5">
              <div className="mb-3 text-xs font-semibold tracking-wide text-zinc-500">Advanced EC2 Settings</div>
              <div className="space-y-4">
                <label className="block text-xs font-medium text-zinc-400">
                  <span className="mb-1 block">Instance type</span>
                  <select
                    value={ec2ResourceConfig.instance_type}
                    onChange={(event) => handleEc2ResourceConfigChange({ instance_type: event.target.value })}
                    disabled={infraConsultantLoading || deployStatus === 'running'}
                    className="w-full rounded-md border border-[#262626] bg-black px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {EC2_INSTANCE_TYPES.map((instanceType) => (
                      <option key={instanceType} value={instanceType}>{instanceType}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs font-medium text-zinc-400">
                  <span className="mb-1 block">Root volume GB</span>
                  <input
                    type="number"
                    min={20}
                    max={200}
                    value={ec2ResourceConfig.root_volume_size_gb}
                    onChange={(event) => handleEc2ResourceConfigChange({ root_volume_size_gb: Number(event.target.value) })}
                    disabled={infraConsultantLoading || deployStatus === 'running'}
                    className="w-full rounded-md border border-[#262626] bg-black px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:border-indigo-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </label>
                <label className="block text-xs font-medium text-zinc-400">
                  <span className="mb-1 block">App port</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={ec2ResourceConfig.app_port}
                    onChange={(event) => handleEc2ResourceConfigChange({ app_port: Number(event.target.value) })}
                    disabled={infraConsultantLoading || deployStatus === 'running'}
                    className="w-full rounded-md border border-[#262626] bg-black px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:border-indigo-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </label>
                <label className="block text-xs font-medium text-zinc-400">
                  <span className="mb-1 block">SSH CIDR allowlist</span>
                  <textarea
                    value={ec2ResourceConfig.ssh_ingress_cidr_blocks.join(', ')}
                    onChange={(event) => handleEc2ResourceConfigChange({ ssh_ingress_cidr_blocks: normalizeCidrList(event.target.value) })}
                    disabled={infraConsultantLoading || deployStatus === 'running'}
                    placeholder="203.0.113.10/32"
                    className="min-h-18 w-full resize-none rounded-md border border-[#262626] bg-black px-3 py-2 font-mono text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-indigo-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </label>
              </div>
              <div className="mt-4 rounded-md border border-[#1A1A1A] bg-black px-3 py-2 text-xs text-zinc-500">
                Selected EC2: <span className="font-mono text-zinc-300">{ec2ResourceConfig.instance_type}</span>
                <span className="text-zinc-700"> / </span>
                <span className="font-mono text-zinc-300">{ec2ResourceConfig.root_volume_size_gb}GB</span>
                <span className="text-zinc-700"> / </span>
                <span className="font-mono text-zinc-300">:{ec2ResourceConfig.app_port}</span>
              </div>
            </div>
          ) : null}
          {deploymentPlan === 'ecs_fargate' ? (
            <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-5">
              <div className="mb-3 text-xs font-semibold tracking-wide text-zinc-500">ECS Fargate Settings</div>
              <div className="space-y-4">
                <label className="block text-xs font-medium text-zinc-400">
                  <span className="mb-1 block">Task CPU</span>
                  <select
                    value={ecsResourceConfig.cpu}
                    onChange={(event) => handleEcsResourceConfigChange({ cpu: Number(event.target.value) })}
                    disabled={infraConsultantLoading || deployStatus === 'running'}
                    className="w-full rounded-md border border-[#262626] bg-black px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {ECS_CPU_OPTIONS.map((cpu) => (<option key={cpu} value={cpu}>{cpu} ({cpu / 1024} vCPU)</option>))}
                  </select>
                </label>
                <label className="block text-xs font-medium text-zinc-400">
                  <span className="mb-1 block">Task memory (MB)</span>
                  <select
                    value={ecsResourceConfig.memory}
                    onChange={(event) => handleEcsResourceConfigChange({ memory: Number(event.target.value) })}
                    disabled={infraConsultantLoading || deployStatus === 'running'}
                    className="w-full rounded-md border border-[#262626] bg-black px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {ECS_MEMORY_OPTIONS.map((memory) => (<option key={memory} value={memory}>{memory}</option>))}
                  </select>
                </label>
                <label className="block text-xs font-medium text-zinc-400">
                  <span className="mb-1 block">Desired task count</span>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={ecsResourceConfig.desired_count}
                    onChange={(event) => handleEcsResourceConfigChange({ desired_count: Number(event.target.value) })}
                    disabled={infraConsultantLoading || deployStatus === 'running'}
                    className="w-full rounded-md border border-[#262626] bg-black px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:border-indigo-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </label>
              </div>
              <div className="mt-4 rounded-md border border-[#1A1A1A] bg-black px-3 py-2 text-xs text-zinc-500">
                Selected ECS: <span className="font-mono text-zinc-300">{ecsResourceConfig.cpu} CPU</span>
                <span className="text-zinc-700"> / </span>
                <span className="font-mono text-zinc-300">{ecsResourceConfig.memory}MB</span>
                <span className="text-zinc-700"> / </span>
                <span className="font-mono text-zinc-300">x{ecsResourceConfig.desired_count}</span>
              </div>
            </div>
          ) : null}
          {deploymentPlan === 's3_cloudfront' ? (
            <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-5">
              <div className="mb-3 text-xs font-semibold tracking-wide text-zinc-500">CloudFront Settings</div>
              <div className="space-y-4">
                <label className="block text-xs font-medium text-zinc-400">
                  <span className="mb-1 block">Price class</span>
                  <select
                    value={staticSiteResourceConfig.price_class}
                    onChange={(event) => handleStaticSiteResourceConfigChange({ price_class: event.target.value as StaticSiteResourceConfig['price_class'] })}
                    disabled={infraConsultantLoading || deployStatus === 'running'}
                    className="w-full rounded-md border border-[#262626] bg-black px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <option value="PriceClass_100">PriceClass_100 (NA + EU)</option>
                    <option value="PriceClass_200">PriceClass_200 (+ Asia)</option>
                    <option value="PriceClass_All">PriceClass_All (global)</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-xs font-medium text-zinc-400">
                  <input
                    type="checkbox"
                    checked={staticSiteResourceConfig.spa_fallback}
                    onChange={(event) => handleStaticSiteResourceConfigChange({ spa_fallback: event.target.checked })}
                    disabled={infraConsultantLoading || deployStatus === 'running'}
                    className="h-4 w-4 rounded border-[#262626] bg-black"
                  />
                  <span>SPA fallback (route 403/404 to index.html)</span>
                </label>
              </div>
            </div>
          ) : null}
          <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-5">
            <div className="mb-3 text-xs font-semibold tracking-wide text-zinc-500">Decision Status</div>
            <div className="text-lg font-semibold text-zinc-100">
              {currentInfraConsultant?.decision ? (currentInfraConsultant.confirmed ? 'Approved' : 'Ready for confirmation') : infraConsultantLoading ? 'Consulting' : 'In progress'}
            </div>
            <div className="mt-2 text-xs text-zinc-500">Turns: <span className="font-mono text-zinc-300">{currentInfraConsultant?.turn_count || 0}/20</span></div>
            <div className="mt-4 text-xs leading-relaxed text-zinc-400">
              {currentInfraConsultant?.decision
                ? <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-zinc-400">{consultantDecisionSummary || 'Consultant produced a decision. Review and confirm to continue.'}</pre>
                : 'The consultant continues asking until a production-safe component decision is complete.'}
            </div>
          </div>
          <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-5">
            <div className="mb-3 text-xs font-semibold tracking-wide text-zinc-500">Repo Detection Summary</div>
            <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-zinc-500">
              {normalizeRepoDetectionSummaryText(currentInfraConsultant?.repo_detection_summary) || 'Waiting for consultant context.'}
            </pre>
          </div>
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
    <svg viewBox="0 0 980 560" className="w-full rounded-lg bg-black">
      <defs>
        <marker id="decision-flow-arrow" markerWidth="8" markerHeight="6" refX="6" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="#3f3f46" />
        </marker>
      </defs>
      {decisionDiagram.hasVpcBoundary ? (
        <>
          <rect x="180" y="40" width="760" height="470" rx="14" fill="#0a0a0a" stroke="#1e3a8a" strokeWidth="1.5" />
          <text x="200" y="62" fill="#60a5fa" fontSize="11" fontFamily="monospace">VPC ({decisionDiagram.awsRegion})</text>
          <rect x="220" y="110" width="320" height="155" rx="12" fill="#0b1220" stroke="#2563eb" strokeOpacity="0.55" />
          <text x="238" y="132" fill="#60a5fa" fontSize="10" fontFamily="monospace">Public subnet</text>
          <rect x="220" y="290" width="700" height="190" rx="12" fill="#0f1410" stroke="#22c55e" strokeOpacity="0.5" />
          <text x="238" y="312" fill="#86efac" fontSize="10" fontFamily="monospace">Private subnet{decisionDiagram.hasMultiAz ? ' (Multi-AZ)' : ''}</text>
        </>
      ) : null}
      {decisionDiagram.edges.map((edge, index) => {
        const from = decisionNodePositions.get(edge.from);
        const to = decisionNodePositions.get(edge.to);
        if (!from || !to) return null;
        return (
          <g key={`${edge.from}-${edge.to}-${index}`}>
            <line
              x1={from.x + 64}
              y1={from.y + (from.height / 2)}
              x2={to.x + 64}
              y2={to.y + (to.height / 2)}
              stroke="#3f3f46"
              strokeWidth="1.4"
              markerEnd="url(#decision-flow-arrow)"
            />
            {edge.label ? (
              <text
                x={(from.x + to.x) / 2 + 58}
                y={(from.y + to.y) / 2 + 18}
                textAnchor="middle"
                fill="#6b7280"
                fontSize="10"
                fontFamily="monospace"
              >
                {edge.label}
              </text>
            ) : null}
          </g>
        );
      })}
      {decisionDiagram.nodes.map((node) => {
        const details = node.details.slice(0, 3);
        const height = getDecisionNodeHeight(node);
        return (
          <g key={node.id} transform={`translate(${node.x},${node.y})`}>
            <rect width="128" height={height} rx="10" fill={`${node.color}1a`} stroke={node.color} strokeOpacity="0.8" />
            <text x="64" y="18" textAnchor="middle" fill={node.color} fontSize="9" fontFamily="monospace" fontWeight="700">
              {node.category.toUpperCase()}
            </text>
            <text x="64" y="34" textAnchor="middle" fill="#e5e7eb" fontSize="11" fontFamily="-apple-system,sans-serif">
              {node.label}
            </text>
            {details.map((line, index) => (
              <text
                key={`${node.id}-detail-${index}`}
                x="64"
                y={48 + index * 11}
                textAnchor="middle"
                fill="#a1a1aa"
                fontSize="9"
                fontFamily="monospace"
              >
                {line}
              </text>
            ))}
          </g>
        );
      })}
      <text x="490" y="546" textAnchor="middle" fill="#52525b" fontSize="10" fontFamily="-apple-system,sans-serif">
        Request flow and placement are derived from the approved consultant decision.
      </text>
    </svg>
  );
  const decisionCostRows = decisionCostEstimate?.line_items || [];
  const decisionCostSubtotal = Number(decisionCostEstimate?.subtotal_monthly_usd || 0);
  const decisionCostVariance = String(decisionCostEstimate?.variance_note || 'Estimated monthly cost can vary by +/-20% depending on runtime usage.');
  const decisionCostFallbackReason = String(decisionCostEstimate?.fallback_reason || '').trim();
  const decisionCostBasedOnDecision = decisionCostEstimate?.based_on_decision !== false;
  const decisionOptimizationTips = Array.isArray(decisionCostEstimate?.optimization_tips)
    ? decisionCostEstimate.optimization_tips.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  return (
    <div className="flex h-screen overflow-hidden bg-black font-sans text-zinc-300">
      <aside className="flex h-full w-65 shrink-0 flex-col border-r border-[#1A1A1A] bg-[#050505]">
        <div className="flex h-16 items-center border-b border-[#1A1A1A] px-6"><div className="flex items-center gap-3"><div className="flex h-6 w-6 items-center justify-center rounded border border-[#262626] bg-[#111111] text-xs font-bold text-white">N</div><span className="text-sm font-semibold tracking-wide text-white">DepLAI</span></div></div>
        <div className="custom-scrollbar flex-1 space-y-1 overflow-y-auto px-3 py-6">
          {(() => {
            const activeIndex = SIDEBAR_STAGES.findIndex((s) => s.id === activeStage);
            return SIDEBAR_STAGES.map((stage, idx) => {
              const isActive = activeStage === stage.id;
              const isDone = idx < activeIndex;
              return (
                <button key={stage.id} onClick={() => setAndPersistStage(stage.id)} className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left ${isActive ? 'bg-[#111111] text-zinc-100' : isDone ? 'text-zinc-400 hover:bg-[#0A0A0A]' : 'text-zinc-600 hover:bg-[#0A0A0A]'}`}>
                  <div className="flex shrink-0 items-center justify-center">
                    {isActive
                      ? <CircleDashed className="h-4 w-4 animate-spin text-indigo-500" />
                      : isDone
                        ? <div className="h-4 w-4 rounded-full bg-indigo-600 flex items-center justify-center"><svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1.5 4l2 2 3-3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
                        : <div className="h-4 w-4 rounded-full border border-zinc-700" />}
                  </div>
                  <div>
                    <div className="text-[13px] font-medium">{stage.label}</div>
                    <div className="text-xs uppercase tracking-widest text-zinc-600">{stage.details}</div>
                  </div>
                </button>
              );
            });
          })()}
        </div>
      </aside>
      <div className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-16 items-center justify-between border-b border-[#1A1A1A] bg-[#050505] px-8">
          <div className="flex items-center gap-2 text-sm"><button onClick={() => router.push('/dashboard')} className="font-medium text-zinc-500 hover:text-white">Dashboard</button><ChevronRight className="h-4 w-4 text-zinc-700" /><span className="font-medium text-zinc-100">{SIDEBAR_STAGES.find((stage) => stage.id === activeStage)?.label}</span></div>
          {selectedProject && <div className="flex items-center gap-3"><span className="rounded-md border border-[#262626] bg-[#111111] px-3 py-1.5 font-mono text-xs text-zinc-400">{selectedProject.name}</span><button onClick={() => router.push('/dashboard')} className="text-xs font-semibold text-zinc-400 hover:text-white">Exit</button></div>}
        </header>
        <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
          {error && (
            <div className="mx-auto mb-6 flex max-w-5xl items-center justify-between gap-4 rounded-md border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-300">
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
          {activeStage === 'analysis' && <div className="mx-auto max-w-5xl space-y-6">{!projectsLoaded ? <div className="flex min-h-[400px] items-center justify-center"><div className="text-sm font-medium text-zinc-400 animate-pulse">Loading workspace data...</div></div> : selectedProject ? <><div><h1 className="mb-1 text-2xl font-semibold text-zinc-100">Repository Analysis</h1><p className="text-sm text-zinc-400">{analysisLoading ? 'Scanning codebase and waiting for Agentic Layer.' : 'Scanning codebase to infer runtime and deployment requirements.'}</p></div><div className="grid grid-cols-3 gap-6"><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-1 text-xs font-semibold uppercase tracking-widest text-zinc-500">Runtime</div><div className="text-lg font-medium text-zinc-100">{analysisLoading ? 'Scanning...' : String(repoContext?.language?.runtime || 'Unknown')}</div></div><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-1 text-xs font-semibold uppercase tracking-widest text-zinc-500">Frameworks</div><div className="text-lg font-medium text-zinc-100">{analysisLoading ? 'Scanning...' : analysisFrameworkNames.join(' / ') || 'None detected'}</div></div><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-1 text-xs font-semibold uppercase tracking-widest text-zinc-500">Data Stores</div><div className="text-lg font-medium text-zinc-100">{analysisLoading ? 'Scanning...' : analysisDataStoreNames.join(', ') || 'None detected'}</div></div></div>{!analysisLoading && repoContext && <div className="grid grid-cols-2 gap-6"><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">Scanner Summary</div><div className="space-y-2 text-sm text-zinc-300"><div>{String(repoContext.summary || 'No summary generated yet.')}</div><div className="text-zinc-500">Workspace: <span className="font-mono text-zinc-300">{repoContext.workspace}</span></div><div className="text-zinc-500">Build: <span className="font-mono text-zinc-300">{String(repoContext.build?.build_command || 'not detected')}</span></div><div className="text-zinc-500">Start: <span className="font-mono text-zinc-300">{String(repoContext.build?.start_command || 'not detected')}</span></div><div className="text-zinc-500">Health: <span className="font-mono text-zinc-300">{String(repoContext.health?.endpoint || 'not detected')}</span></div></div></div><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">Terraform Context</div><pre className="max-h-55 overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-400">{qaSummary || 'Repository context will appear here after the scanner completes.'}</pre></div><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">Processes & Config</div><div className="space-y-2 text-sm text-zinc-300">{analysisProcessLines.length > 0 ? analysisProcessLines.map((line) => <div key={line}>{line}</div>) : <div className="text-zinc-500">No explicit processes detected.</div>}{analysisConfigNames.length > 0 && <div className="pt-3 text-zinc-500">Config values: <span className="text-zinc-300">{analysisConfigNames.join(', ')}</span></div>}</div></div><div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">Secrets & Flags</div><div className="space-y-2 text-sm text-zinc-300">{analysisSecretNames.length > 0 ? <div>Required secrets: {analysisSecretNames.join(', ')}</div> : <div className="text-zinc-500">No required secrets detected.</div>}{analysisFlagLines.length > 0 ? analysisFlagLines.map((line) => <div key={line} className="text-amber-300">{line}</div>) : <div className="text-zinc-500">No major flags raised by the scanner.</div>}{repoContext.readme_notes && <div className="text-zinc-400">{String(repoContext.readme_notes)}</div>}</div></div></div>}{!analysisLoading && repoContextMd && <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6"><div className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">Scanner Markdown</div><pre className="max-h-80 overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-400">{repoContextMd}</pre></div>}<div className="flex justify-end"><button onClick={() => setAndPersistStage('qa')} disabled={analysisLoading || !repoContext || repoContext.workspace !== expectedWorkspace} className="flex items-center gap-2 rounded-md bg-zinc-100 px-6 py-2.5 text-sm font-semibold text-black hover:bg-white disabled:cursor-not-allowed disabled:bg-[#111111] disabled:text-zinc-500">{analysisLoading ? 'Scanning Repository...' : 'Continue to Questions'} <ArrowRight className="h-4 w-4" /></button></div></> : <div className="rounded-xl border border-[#1A1A1A] bg-[#050505] p-8"><h1 className="mb-2 text-2xl font-semibold text-zinc-100">Choose a Repository from the Dashboard</h1><p className="max-w-2xl text-sm leading-relaxed text-zinc-400">Deployment Track only runs against a specific repository. Start from a repo card on the dashboard so the AWS deployment flow is bound to the correct project.</p><div className="mt-6"><button onClick={() => router.push('/dashboard')} className="rounded-md bg-zinc-100 px-5 py-2.5 text-sm font-semibold text-black hover:bg-white">Back to Dashboard</button></div></div>}</div>}
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
              <div>
                <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Architecture Diagram</h1>
                <p className="text-sm text-zinc-400">Stage 3: generated directly from the consultant decision JSON.</p>
              </div>
              <div className="grid grid-cols-3 gap-6">
                <div className="col-span-2 overflow-hidden rounded-lg border border-[#1A1A1A] bg-[#050505]">
                  <div className="flex items-center justify-between border-b border-[#1A1A1A] px-5 py-4">
                    <div>
                      <div className="text-sm font-semibold text-zinc-100">Decision-driven topology</div>
                      <div className="text-xs text-zinc-500">{decisionDiagram.nodes.length} nodes / {decisionDiagram.edges.length} flows</div>
                    </div>
                  </div>
                  <div className="p-5">
                    {decisionDiagram.nodes.length > 0 ? decisionDiagramCanvas : (
                      <div className="rounded-lg border border-dashed border-[#262626] bg-black px-6 py-16 text-center text-sm text-zinc-500">
                        No consultant decision is available yet. Complete consultant chat first.
                      </div>
                    )}
                  </div>
                </div>
                <div className="space-y-6">
                  <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6">
                    <div className="mb-3 text-xs font-semibold tracking-wide text-zinc-500">Selected Components</div>
                    <div className="space-y-2 text-sm text-zinc-300">
                      {decisionDiagram.components.length > 0 ? decisionDiagram.components.map((item) => (
                        <div key={item} className="rounded-md border border-[#1A1A1A] bg-black px-3 py-2 font-mono text-xs text-zinc-300">{formatComponentName(item)}</div>
                      )) : <div className="text-zinc-500">No components selected yet.</div>}
                    </div>
                  </div>
                  <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6">
                    <div className="mb-3 text-xs font-semibold tracking-wide text-zinc-500">Consultant Notes</div>
                    <div className="space-y-2 text-xs leading-relaxed text-zinc-400">
                      {consultantNotesList.length > 0 ? consultantNotesList.map((note, index) => (
                        <div key={`${index}-${note}`} className="rounded-md border border-[#1A1A1A] bg-black px-3 py-2">{note}</div>
                      )) : <div className="text-zinc-500">No consultant notes were provided.</div>}
                    </div>
                  </div>
                  <button
                    onClick={() => setAndPersistStage('cost_estimation')}
                    disabled={!decisionForVisualization}
                    className="w-full rounded-md bg-zinc-100 py-3 text-sm font-semibold text-black hover:bg-white disabled:bg-[#111111] disabled:text-zinc-500"
                  >
                    Continue to Cost Estimation
                  </button>
                </div>
              </div>
            </div>
          )}
          {activeStage === 'cost_estimation' && (
            <div className="mx-auto max-w-6xl space-y-6">
              <div>
                <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Cost Estimation</h1>
                <p className="text-sm text-zinc-400">Stage 4: estimated from AWS public pricing API with fallback pricing tables when needed.</p>
                {decisionCostEstimate ? (
                  <p className="mt-1 text-xs text-zinc-500">
                    {decisionCostBasedOnDecision ? 'Estimate is derived from consultant decision stack_config values.' : 'Estimate fell back to safe defaults because decision stack_config was incomplete.'}
                    {decisionCostFallbackReason ? ` ${decisionCostFallbackReason}` : ''}
                  </p>
                ) : null}
              </div>
              <div className="grid grid-cols-3 gap-6">
                <div className="col-span-2 overflow-hidden rounded-lg border border-[#1A1A1A] bg-[#050505]">
                  <div className="border-b border-[#1A1A1A] px-5 py-4 text-sm font-semibold text-zinc-100">Cost Breakdown</div>
                  <div className="p-5">
                    {decisionCostLoading ? (
                      <div className="text-sm text-zinc-500">Fetching AWS public pricing data...</div>
                    ) : decisionCostRows.length > 0 ? (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-[#1A1A1A] text-left text-xs font-semibold tracking-wide text-zinc-500">
                            <th className="px-2 py-3">Component</th>
                            <th className="px-2 py-3">Hourly</th>
                            <th className="px-2 py-3">Monthly</th>
                            <th className="px-2 py-3">Source</th>
                            <th className="px-2 py-3">Notes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {decisionCostRows.map((row) => (
                            <tr key={`${row.component}-${row.label}`} className="border-b border-[#111111]">
                              <td className="px-2 py-3 font-mono text-zinc-200">{row.label}</td>
                              <td className="px-2 py-3 font-mono text-zinc-300">${Number(row.hourly_usd || 0).toFixed(4)}</td>
                              <td className="px-2 py-3 font-mono text-zinc-200">${Number(row.monthly_usd || 0).toFixed(2)}</td>
                              <td className="px-2 py-3 text-zinc-500">{row.source}</td>
                              <td className="px-2 py-3 text-zinc-500">{row.note}</td>
                            </tr>
                          ))}
                          <tr className="bg-black/60">
                            <td className="px-2 py-3 font-semibold text-zinc-100">Subtotal</td>
                            <td className="px-2 py-3" />
                            <td className="px-2 py-3 font-mono font-semibold text-zinc-100">${decisionCostSubtotal.toFixed(2)}</td>
                            <td className="px-2 py-3 text-zinc-500">{decisionCostEstimate?.source || 'fallback'}</td>
                            <td className="px-2 py-3 text-zinc-500">{decisionCostVariance}</td>
                          </tr>
                        </tbody>
                      </table>
                    ) : (
                      <div className="text-sm text-zinc-500">{decisionCostError || 'Cost estimation is not available yet.'}</div>
                    )}
                  </div>
                </div>
                <div className="space-y-6">
                  <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6">
                    <div className="mb-3 text-xs font-semibold tracking-wide text-zinc-500">Optimization Tips</div>
                    <div className="space-y-2 text-xs leading-relaxed text-zinc-400">
                      {decisionOptimizationTips.length > 0 ? decisionOptimizationTips.map((tip, index) => (
                        <div key={`${index}-${tip}`} className="rounded-md border border-[#1A1A1A] bg-black px-3 py-2">{tip}</div>
                      )) : <div className="text-zinc-500">Tips will appear after the estimate completes.</div>}
                    </div>
                  </div>
                  <button
                    onClick={() => setAndPersistStage('terraform')}
                    disabled={!approvedConsultantDecision}
                    className="w-full rounded-md bg-zinc-100 py-3 text-sm font-semibold text-black hover:bg-white disabled:bg-[#111111] disabled:text-zinc-500"
                  >
                    Continue to Infrastructure Generation
                  </button>
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
              <div className="mt-4 mb-6 border-b border-[#1A1A1A] pb-6">
                <h1 className="mb-2 text-2xl font-semibold text-zinc-100">AWS Config</h1>
                <p className="text-sm text-zinc-400">Provide AWS credentials and confirm the Terraform runtime inputs used for deploy handoff.</p>
              </div>
              <div className="grid grid-cols-3 gap-6">
                <div className="col-span-2 space-y-6 rounded-lg border border-[#1A1A1A] bg-[#050505] p-6">
                  <div className="space-y-4">
                    <input value={aws.aws_access_key_id} onChange={(event) => setAws((prev) => ({ ...prev, aws_access_key_id: event.target.value }))} placeholder="AWS_ACCESS_KEY_ID" className="w-full rounded-md border border-[#262626] bg-black px-4 py-2.5 font-mono text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none" />
                    <input type="password" value={aws.aws_secret_access_key} onChange={(event) => setAws((prev) => ({ ...prev, aws_secret_access_key: event.target.value }))} placeholder="AWS_SECRET_ACCESS_KEY" className="w-full rounded-md border border-[#262626] bg-black px-4 py-2.5 font-mono text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none" />
                    <input type="password" value={aws.aws_session_token} onChange={(event) => setAws((prev) => ({ ...prev, aws_session_token: event.target.value }))} placeholder="AWS_SESSION_TOKEN (optional)" className="w-full rounded-md border border-[#262626] bg-black px-4 py-2.5 font-mono text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none" />
                    <input value={terraformRuntimeConfig.aws_region} onChange={(event) => setTerraformRuntimeConfig((prev) => ({ ...prev, aws_region: event.target.value }))} placeholder="AWS_REGION" className="w-full rounded-md border border-[#262626] bg-black px-4 py-2.5 font-mono text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none" />
                    <input value={terraformRuntimeConfig.state_bucket} onChange={(event) => setTerraformRuntimeConfig((prev) => ({ ...prev, state_bucket: event.target.value }))} placeholder="STATE_BUCKET (optional)" className="w-full rounded-md border border-[#262626] bg-black px-4 py-2.5 font-mono text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none" />
                    <input value={terraformRuntimeConfig.lock_table} onChange={(event) => setTerraformRuntimeConfig((prev) => ({ ...prev, lock_table: event.target.value }))} placeholder="LOCK_TABLE (optional)" className="w-full rounded-md border border-[#262626] bg-black px-4 py-2.5 font-mono text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none" />
                  </div>
                  {hasAwsSecrets && !canContinueToAwsConfig && (
                    <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                      Infrastructure generation is required before deploying. Go back to the Infrastructure Generation step and generate your Terraform files first.
                    </div>
                  )}
                  <button onClick={() => setAndPersistStage('deploy')} disabled={!hasAwsSecrets || !canContinueToAwsConfig} className="flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 py-3 font-semibold text-white hover:bg-indigo-500 disabled:bg-[#111111] disabled:text-zinc-500">
                    <Rocket className="h-4 w-4" /> Continue to Deploy
                  </button>
                </div>
                <div className="space-y-4 rounded-lg border border-[#1A1A1A] bg-[#050505] p-6">
                  <div>
                    <div className="text-xs font-semibold tracking-wide text-zinc-500">Runtime Inputs</div>
                    <div className="mt-3 space-y-2 text-xs text-zinc-400">
                      <div>Deploy source: <span className="font-mono text-zinc-200">{shouldUseSavedRunForDeploy ? 'saved run' : 'session files'}</span></div>
                      <div>Workspace: <span className="font-mono text-zinc-200">{shouldUseSavedRunForDeploy ? (activeSavedRun?.workspace || expectedWorkspace || 'pending') : (expectedWorkspace || 'local session')}</span></div>
                      <div>AWS region: <span className="font-mono text-zinc-200">{terraformRuntimeConfig.aws_region || DEFAULT_AWS_REGION}</span></div>
                      <div>State bucket: <span className="font-mono text-zinc-200">{terraformRuntimeConfig.state_bucket || 'none'}</span></div>
                      <div>Lock table: <span className="font-mono text-zinc-200">{terraformRuntimeConfig.lock_table || 'none'}</span></div>
                      <div>Estimated monthly cost: <span className="font-mono text-zinc-200">${costEstimate.total.toFixed(2)}</span></div>
                      <div>Budget cap: <span className="font-mono text-zinc-200">${costEstimate.cap.toFixed(2)}</span></div>
                    </div>
                  </div>
                  <div className={`rounded-md border px-3 py-2 text-xs ${hasAwsSecrets && canContinueToAwsConfig ? 'border-zinc-700 bg-zinc-800/50 text-zinc-200' : hasAwsSecrets ? 'border-zinc-700 bg-[#111111] text-zinc-400' : 'border-amber-500/20 bg-amber-500/10 text-amber-300'}`}>
                    {hasAwsSecrets && canContinueToAwsConfig
                      ? 'AWS credentials are ready. Add AWS_SESSION_TOKEN if you are using temporary STS credentials.'
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
          {activeStage === 'deploy' && (
            <div className="mx-auto max-w-5xl space-y-6">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <h1 className="text-2xl font-semibold text-zinc-100">
                    {deployStatus === 'done'
                      ? 'Deployment Complete'
                      : deployStatus === 'running'
                        ? 'Deployment In Progress'
                        : deployStatus === 'error'
                          ? 'Deployment Failed'
                          : 'Ready to Deploy'}
                  </h1>
                  <p className="mt-1 text-sm text-zinc-400">
                    Live deployment console backed by pipeline WebSocket events and backend status reconciliation.
                  </p>
                </div>
                <div
                  className={`rounded-full border px-3 py-1 text-sm font-semibold uppercase tracking-widest ${deploySocketState === 'connected'
                    ? 'border-zinc-700 bg-zinc-800/50 text-zinc-200'
                    : deploySocketState === 'connecting'
                      ? 'border-zinc-700 bg-zinc-800/50 text-zinc-200'
                      : deploySocketState === 'error'
                        ? 'border-amber-500/20 bg-amber-500/10 text-amber-400'
                        : 'border-zinc-700 bg-[#111111] text-zinc-500'
                  }`}
                >
                  WS {deploySocketState}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-6">
                <div className="col-span-2 flex h-125 flex-col overflow-hidden rounded-lg border border-[#1E2433] bg-[#0A0E1A] shadow-xl">
                  <div className="flex items-center justify-between border-b border-[#1E2433] bg-[#080D18] px-4 py-2.5 font-mono text-xs">
                    <div className="flex items-center gap-2.5">
                      <div className="flex gap-1.5">
                        <span className="h-3 w-3 rounded-full bg-red-500/80" />
                        <span className="h-3 w-3 rounded-full bg-amber-400/80" />
                        <span className="h-3 w-3 rounded-full bg-zinc-800/50" />
                      </div>
                      <span className="text-[#4A9EFF] font-semibold tracking-wider">STDOUT</span>
                      <span className="text-zinc-600">—</span>
                      <span className="text-zinc-500">deployment.log</span>
                    </div>
                    <div className="flex items-center gap-3 text-zinc-600">
                      <span className="rounded bg-[#111827] px-2 py-0.5 text-xs font-mono text-zinc-500">{deployLogs.length} events</span>
                    </div>
                  </div>
                  <div className="custom-scrollbar flex-1 overflow-y-auto bg-[#070B14] p-4 font-mono text-[12px]" style={{ scrollbarWidth: 'thin', scrollbarColor: '#1E2433 transparent' }}>
                    {deployLogs.length === 0 && (
                      <div className="flex h-full items-center justify-center text-zinc-600 text-xs">Waiting for deployment events...</div>
                    )}
                    {deployLogs.map((log, index) => (
                      <div key={`${log.ts}-${index}`} className={`mb-0.5 flex gap-3 rounded px-2 py-0.5 ${index % 2 === 0 ? 'bg-transparent' : 'bg-[#0C1120]/40'}`}>
                        <span className="shrink-0 select-none text-xs text-[#2A3A5C] mt-0.5">{String(index + 1).padStart(2, '0')}</span>
                        <span className={`flex-1 leading-relaxed ${
                          log.type === 'success' ? 'text-zinc-200' 
                          : log.type === 'error' ? 'text-red-400' 
                          : log.text.startsWith('✓') || log.text.includes('created') ? 'text-zinc-200'
                          : log.text.startsWith('+') || log.text.includes('Creating') ? 'text-[#4A9EFF]'
                          : log.text.includes('Error') || log.text.includes('failed') ? 'text-red-400'
                          : log.text.startsWith('[') ? 'text-amber-300/80'
                          : 'text-[#8BA3CC]'
                        }`}>
                          {log.text}
                        </span>
                      </div>
                    ))}
                    <div ref={logEndRef} />
                  </div>
                </div>
                <div className="space-y-4 rounded-lg border border-[#1A1A1A] bg-[#050505] p-6">
                  <div>
                    <div className="text-xs font-semibold tracking-wide text-zinc-500">Execution</div>
                    <div className="mt-3 text-3xl font-semibold text-zinc-100">{deployProgress}%</div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#111111]">
                      <div
                        className={`h-full rounded-full ${deployStatus === 'done'
                          ? 'bg-zinc-600'
                          : deployStatus === 'error'
                            ? 'bg-red-500'
                            : 'bg-indigo-500'
                        }`}
                        style={{ width: `${deployProgress}%` }}
                      />
                    </div>
                    <div className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
                      <span>Status:</span>
                      <span className={`rounded-full px-2 py-0.5 font-mono text-xs font-semibold ${
                        deployStatus === 'done' ? 'bg-zinc-800/50 text-zinc-200 border border-zinc-700'
                        : deployStatus === 'error' ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                        : deployProgress >= 100 ? 'animate-pulse bg-zinc-800/50 text-zinc-200 border border-zinc-700'
                        : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                      }`}>{deployProgress >= 100 && deployStatus === 'running' ? 'executing build' : deployStatus}</span>
                    </div>
                    {deployProgress >= 100 && deployStatus === 'running' && (
                      <div className="mt-3 rounded-md border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200">
                        ⚡ Build script running on EC2. This can take 30–60 min. Watch the terminal below.
                      </div>
                    )}
                  </div>
                  {costEstimate.total > costEstimate.cap && (
                    <div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
                      <div className="font-semibold text-amber-300">Budget guardrail</div>
                      <div className="mt-1">Estimated monthly cost ${costEstimate.total.toFixed(2)} exceeds cap ${costEstimate.cap.toFixed(2)}.</div>
                      <label className="mt-3 flex items-start gap-3 text-left">
                        <input
                          type="checkbox"
                          checked={budgetOverride}
                          onChange={(event) => setBudgetOverride(event.target.checked)}
                          disabled={deployStatus === 'running'}
                          className="mt-0.5 h-4 w-4 rounded border-[#3f3f46] bg-black text-indigo-500 focus:ring-indigo-500/40"
                        />
                        <span>
                          <span className="block font-medium text-amber-100">Override budget guardrail for this deploy</span>
                          <span className="mt-1 block text-sm text-amber-200/80">Use only when you intentionally approve costs above the configured cap.</span>
                        </span>
                      </label>
                    </div>
                  )}
                  <div className="space-y-3">
                    <button onClick={() => void startDeploy()} disabled={!canStartDeploy} className="flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-6 py-2.5 font-semibold text-white hover:bg-indigo-500 disabled:bg-[#111111] disabled:text-zinc-500">
                      <Rocket className="h-4 w-4" /> {requiresPlanConfirmation ? 'Confirm Plan & Deploy' : deployStatus === 'done' ? 'Re-run Deploy' : 'Start Deploy'}
                    </button>
                    {deployStartBlockers.length > 0 && (
                      <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                        {deployStartBlockers[0]}
                      </div>
                    )}
                    <button onClick={() => void stopDeployment()} disabled={deployStatus !== 'running' || stopLoading} className="w-full rounded-md border border-red-500/20 bg-red-500/10 px-6 py-2.5 font-semibold text-red-300 hover:bg-red-500/20 disabled:border-[#262626] disabled:bg-[#111111] disabled:text-zinc-500">
                      {stopLoading ? 'Stopping...' : 'Stop Deployment'}
                    </button>
                    <button onClick={() => void reconcileDeploymentStatus().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Failed to reconcile deployment status.'))} className="w-full rounded-md border border-[#262626] bg-[#111111] px-6 py-2.5 font-semibold text-zinc-300 hover:bg-[#181818]">
                      Reconcile Backend Status
                    </button>
                    {deployStatus !== 'running' && deployResult && (
                      <button onClick={() => setAndPersistStage('outputs')} className="flex w-full items-center justify-center gap-2 rounded-md bg-zinc-100 px-6 py-2.5 font-semibold text-black hover:bg-white">
                        {deployStatus === 'error' ? 'View Results' : 'View Outputs'} <ArrowRight className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
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
              <div className="mt-4 mb-8 border-b border-[#1A1A1A] pb-6">
                <div className={`mb-4 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-bold uppercase ${outputBannerClassName}`}>
                  <CheckCircle2 className="h-3.5 w-3.5" /> {outputBanner.label}
                </div>
                <h1 className="mb-2 text-2xl font-semibold text-zinc-100">{outputBanner.title}</h1>
                <p className="text-sm text-zinc-400">{outputBanner.description}</p>
                {backendErrorMessage && (
                  <div className="mt-4 rounded-md border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-300">
                    {backendErrorMessage}
                  </div>
                )}
                {!backendErrorMessage && !hasLiveRuntimeDetails && deployResult?.success && deployResult.mode !== 'iac_pipeline' && (
                  <div className="mt-4 rounded-md border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200">
                    Live runtime details are missing for this repo. Fetch the latest runtime details to hydrate outputs before treating this deploy as successful.
                  </div>
                )}
              </div>
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
              <div className="grid grid-cols-2 gap-6">
                <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6">
                  <div className="mb-6 text-xs font-semibold tracking-wide text-zinc-500">Security</div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => deploySummary.generatedPem && downloadTextFile(`${deploySummary.keyName}.pem`, deploySummary.generatedPem.endsWith('\n') ? deploySummary.generatedPem : `${deploySummary.generatedPem}\n`)}
                      disabled={!deploySummary.generatedPem}
                      className="flex flex-1 items-center justify-center gap-2 rounded-md border border-[#262626] bg-[#111111] py-2 text-[12px] font-medium text-zinc-200 hover:bg-[#1A1A1A] disabled:cursor-not-allowed disabled:text-zinc-500"
                    >
                      <Download className="h-4 w-4" /> Download .PEM
                    </button>
                    <button
                      onClick={() => void downloadPpk().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'PPK conversion failed.'))}
                      disabled={!deploySummary.generatedPem}
                      className="flex flex-1 items-center justify-center gap-2 rounded-md border border-[#262626] bg-[#111111] py-2 text-[12px] font-medium text-zinc-200 hover:bg-[#1A1A1A] disabled:cursor-not-allowed disabled:text-zinc-500"
                    >
                      <Download className="h-4 w-4" /> Download .PPK
                    </button>
                  </div>
                  {!deploySummary.generatedPem && (
                    <div className="mt-4 rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
                      {keyPairDownloadMessage}
                    </div>
                  )}
                </div>
                <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6">
                  <div className="mb-4 text-xs font-semibold tracking-wide text-zinc-500">Endpoints</div>
                  <div className="space-y-3 text-sm">
                    {(() => {
                      const termInstanceId = deploySummary.instanceId && deploySummary.instanceId !== 'n/a' ? deploySummary.instanceId : String(iacResourceOutputs?.outputs?.find(o => o.key === 'instance_id' || o.key === 'ec2_instance_id')?.value || 'n/a');
                      const termPublicIp = (deploySummary.publicIp && deploySummary.publicIp !== 'n/a') ? deploySummary.publicIp : String(iacResourceOutputs?.outputs?.find(o => o.key === 'public_ip')?.value || 'n/a');
                      const termAppUrl = (deploySummary.appUrl && deploySummary.appUrl !== 'n/a') ? deploySummary.appUrl : (termPublicIp !== 'n/a' ? `http://${termPublicIp}` : 'n/a');
                      return (
                        <>
                          <div className="flex justify-between">
                            <span className="text-zinc-400">App URL</span>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-zinc-200">{termAppUrl !== 'n/a' ? termAppUrl : <span className="text-zinc-600">—</span>}</span>
                              {canOpenApp && termAppUrl !== 'n/a' && (
                                <button onClick={() => window.open(termAppUrl, '_blank', 'noopener,noreferrer')} className="text-zinc-500 hover:text-zinc-200">
                                  <ExternalLink className="h-4 w-4" />
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="flex justify-between"><span className="text-zinc-400">Public IP</span><span className="font-mono text-zinc-200">{termPublicIp !== 'n/a' ? termPublicIp : <span className="text-zinc-600">—</span>}</span></div>
                          <div className="flex justify-between"><span className="text-zinc-400">Instance</span><span className="font-mono text-zinc-200">{termInstanceId !== 'n/a' ? termInstanceId : <span className="text-zinc-600">—</span>}</span></div>
                        </>
                      );
                    })()}
                    <div className="flex justify-between">
                      <span className="text-zinc-400">CloudFront</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-zinc-200">{deploySummary.cloudfrontUrl !== 'n/a' ? deploySummary.cloudfrontUrl : <span className="text-zinc-600">—</span>}</span>
                        {canOpenCloudfront && (
                          <button onClick={() => window.open(deploySummary.cloudfrontUrl.startsWith('http') ? deploySummary.cloudfrontUrl : `https://${deploySummary.cloudfrontUrl}`, '_blank', 'noopener,noreferrer')} className="text-zinc-500 hover:text-zinc-200">
                            <ExternalLink className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex justify-between"><span className="text-zinc-400">Verification</span><span className={`font-medium ${outputBanner.tone === 'success' ? 'text-zinc-200' : outputBanner.tone === 'error' ? 'text-red-300' : 'text-amber-300'}`}>{outputBanner.label}</span></div>
                  </div>
                </div>
              </div>
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



