'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronRight, CircleDashed, ExternalLink, RefreshCw, Rocket, Server, Terminal } from 'lucide-react';
import { ApplyLogViewer } from '@/components/pipeline/ApplyLogViewer';
import { AwsConsoleTerminal } from '@/components/pipeline/AwsConsoleTerminal';
import { buildDeploymentWorkspace } from '@/lib/deployment-planning-contract';
import { createWorkspaceSession, persistSessionProgress, finalizeWorkspaceSession } from '@/lib/sessions/client';
import {
  Callout,
  Chip,
  CodeSurface,
  CountUp,
  EmptyState,
  KeyValueRow,
  LogConsole,
  MetaChip,
  Panel,
  PanelHeader,
  ProgressBar,
  SectionLabel,
  Skeleton,
  StageHeader,
  StageShell,
  StatCard,
  StatusPill,
  StickyActionBar,
  accentButtonClass,
  buttonClass,
  fieldClass,
  fieldLabelClass,
  formatCostComponentLabel,
  paperInsetClass,
  pipelinePrimaryButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
} from '@/features/deployment/deployment-ui';
import {
  AnalysisStagePanel,
  DeploymentCommandHeader,
  DeploymentPipelineHeader,
  DeploymentStageRail,
  PlanningAgentPanel,
  deriveAnalysisMetrics,
  deriveDetectedServices,
} from '@/features/deployment/DeploymentPipelineChrome';
import { InfraOutputsStage } from '@/features/deployment/deployment-outputs';
import { buildInfraAccessBriefing, firstProvisioned } from '@/features/deployment/infra-access-briefing';
import { coerceHttpAppPort } from '@/features/deployment/http-ports';
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
  isAwaitingPlanConfirmation,
  isFailedDeployAttempt,
  isLiveDeployAttempt,
  loadDeploySnapshot,
  loadDeployUiStage,
  persistDeploySnapshot,
  clearDownloadedDeploySecrets,
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
import { AppDeployPanel } from '@/features/deployment/AppDeployPanel';
import {
  budgetCapFromAnswers,
  buildScriptedHistory,
  decisionFromDeploymentProfile,
  isQuestionAnswered,
  nextScriptedQuestionIndex,
  resolveScriptedQuestionCursor,
} from '@/features/deployment/decision-from-profile';
import {
  isRecoverableApplyTransportError,
  isTransportFalseFailureMessage,
  mergeAcceptedApplyResult,
} from '@/features/deployment/apply-status';
import { TERRAFORM_APPLY_POLL_TIMEOUT_MS } from '@/lib/terraform-apply-wait';

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
const DEPLOY_RECONCILE_POLL_INTERVAL_MS = 5_000;
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
    app_port: coerceHttpAppPort(record.app_port, DEFAULT_EC2_RESOURCE_CONFIG.app_port),
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
  if (planId !== 's3_cloudfront' && services.rds) components.push('rds');
  if (planId !== 's3_cloudfront' && services.redis) components.push('elasticache');

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
  if (planId !== 's3_cloudfront' && services.rds) {
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
  if (planId !== 's3_cloudfront' && services.redis) {
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
  { id: 'app_secrets', label: 'App Secrets', details: 'Optional' },
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

function splitIacFilePath(path: string): { dir: string; name: string } {
  const normalized = String(path || '').replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  if (slash < 0) return { dir: '', name: normalized };
  return { dir: normalized.slice(0, slash), name: normalized.slice(slash + 1) };
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
  try {
    persistDeploySnapshot(projectId, {
      status: state.status,
      progress: state.progress,
      logs: state.logs,
      deployResult: state.deployResult,
      deploymentHistory: state.deploymentHistory,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // Never block the live console on storage failures.
  }
}

function setActiveDeploymentState(projectId: string, next: ActiveDeployState): void {
  const entry = getOrCreateActiveDeployment(projectId);
  entry.state = toDeployState(next);
  emitActiveDeployment(projectId);
  persistActiveDeploymentState(projectId, entry.state);
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
  emitActiveDeployment(projectId);
  persistActiveDeploymentState(projectId, entry.state);
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
  const logPanelRef = useRef<HTMLDivElement>(null);
  const logStickToBottomRef = useRef(true);
  const pipelineSocketRef = useRef<WebSocket | null>(null);
  const pipelineSocketRetryRef = useRef<number | null>(null);
  const pipelineSocketAttemptRef = useRef(0);
  const lastPrefillQuestionIdRef = useRef<string | null>(null);
  const socketNoticeKeysRef = useRef<Set<string>>(new Set());
  const deployRequestRef = useRef<string | null>(null);
  const idleRecoveryRef = useRef<string | null>(null);
  const analysisRequestRef = useRef<string | null>(null);
  const reviewRequestRef = useRef<string | null>(null);
  const generatePlanInFlightRef = useRef(false);
  const planAttemptedKeyRef = useRef<string | null>(null);
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
  const [questionCursor, setQuestionCursor] = useState<number | null>(null);
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
  const workspaceSessionIdRef = useRef<string | null>(null);
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
    const entry: DeployLogEntry = { text, ts: timestampLabel(), type, ...meta };
    setDeployLogs((prev) => {
      const last = prev[prev.length - 1];
      if (
        last
        && last.text === text
        && last.type === type
        && last.worker_id === meta?.worker_id
        && last.worker_status === meta?.worker_status
      ) {
        return prev;
      }
      return [...prev, entry];
    });
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
        logs: [...prev.logs, entry],
      };
    });
    const sessionId = workspaceSessionIdRef.current;
    if (sessionId) {
      try {
        persistSessionProgress(sessionId, {
          line: {
            level: type === 'error' ? 'error' : 'info',
            message: text,
            stage: meta?.stage || null,
          },
        });
      } catch {
        // Session log persistence is best-effort.
      }
    }
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
    if (deploySummary.generatedPem || deploySummary.databaseEnv) return '';
    if (deployResult?.one_time_credentials?.credentials_downloaded) {
      return 'Credentials for this deploy were already downloaded and removed from DeplAI. Redeploy to mint a new SSH key tagged with the new instance.';
    }
    return 'No generated private key is available in this deployment result. Each deploy mints a new key; AWS never stores the private half.';
  }, [deployResult?.one_time_credentials?.credentials_downloaded, deploySummary.databaseEnv, deploySummary.generatedPem]);
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
    if (deployResult?.success === true) return '';
    const direct = String(deployResult?.error || '').trim();
    if (
      direct
      && isTransportFalseFailureMessage(direct)
      && !isFailedDeployAttempt({ status: deployStatus, uiPhase: deployUiPhase, result: deployResult })
    ) {
      return '';
    }
    if (direct) return direct;
    if (deployStatus === 'error') {
      return 'The backend reported a deployment error.';
    }
    return '';
  }, [deployResult?.error, deployResult?.success, deployStatus, deployUiPhase]);
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
        label: 'Applying',
        title: 'Deployment in progress',
        description: 'Terraform is still applying. Access URLs, SSH, and resource specs will appear when this run finishes.',
      };
    }
    if (deployStatus === 'error' || backendErrorMessage) {
      return {
        tone: 'error',
        label: 'Error',
        title: 'Deployment did not finish',
        description: backendErrorMessage || 'The deployment did not complete successfully. Review the runtime error and verification details below.',
      };
    }
    if (!deployResult) {
      return {
        tone: 'warning',
        label: 'Not deployed',
        title: 'No live infrastructure yet',
        description: 'Run deploy to provision this stack. This page will then show how to open the app, SSH, and connect to data stores.',
      };
    }
    if (verificationFailed) {
      return {
        tone: 'error',
        label: 'Unreachable',
        title: 'Infrastructure is up, endpoints failed checks',
        description: 'Outputs are available below, but live HTTP verification failed. Confirm security groups, health checks, and DNS.',
      };
    }
    if (!deployResult.success) {
      return {
        tone: 'warning',
        label: 'Pending',
        title: 'Waiting for runtime confirmation',
        description: 'A partial payload exists, but the backend has not confirmed a successful terminal state yet.',
      };
    }
    if (!hasLiveRuntimeDetails) {
      return {
        tone: 'warning',
        label: 'Incomplete',
        title: 'Runtime details are missing',
        description: 'Fetch latest runtime details to hydrate the app URL, IPs, and instance specs.',
      };
    }
    if (verificationPassed) {
      return {
        tone: 'success',
        label: 'Live',
        title: 'Your deployment is live',
        description: 'Open the app URL, SSH with the key below, and use private RDS/Redis endpoints only from the VPC.',
      };
    }
    return {
      tone: 'warning',
      label: 'Ready',
      title: 'Infrastructure is provisioned',
      description: 'Access details are below. Run Verify live endpoints to confirm HTTP from this workspace.',
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
    const deployAlreadyFailed = isFailedDeployAttempt({
      status: deployStatus,
      uiPhase: deployUiPhase,
      result: deployResult,
    });
    if (deployStatus === 'running' && !confirmingPlan && !deployAlreadyFailed) {
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
    // A failed apply should still be retryable even if session Terraform files were compacted.
    if (!deployAlreadyFailed) {
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
    }
    return blockers;
  }, [
    aws.aws_session_token,
    budgetOverride,
    deployUiPhase,
    effectiveBudgetCap,
    effectiveCostTotal,
    deployResult,
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
  const deployFailed = isFailedDeployAttempt({
    status: deployStatus,
    uiPhase: deployUiPhase,
    result: deployResult,
  });
  const awaitingPlanIdle = isAwaitingPlanConfirmation({
    uiPhase: deployUiPhase,
    requiresPlanConfirmation,
    result: deployResult,
  }) && !deployFailed;
  const deployIsLive = isLiveDeployAttempt({
    status: deployStatus,
    uiPhase: deployUiPhase,
    failed: deployFailed,
    requiresPlanConfirmation,
    result: deployResult,
  });
  const redeployDisabled = !selectedProject || !hasAwsSecrets || deployIsLive;
  const deployButtonDisabled = deployFailed ? redeployDisabled : (!canStartDeploy || deployIsLive);
  const deployPhaseLabel = (() => {
    if (deployFailed) return 'Deploy failed';
    if (deployUiPhase === 'starting') return 'Starting deploy…';
    if (deployUiPhase === 'waiting_api') return `Terraform apply in progress (${deployElapsedSec}s)`;
    if (deployUiPhase === 'reconciling') return `Reconciling backend status (${deployElapsedSec}s)`;
    if (deployUiPhase === 'awaiting_plan') return 'Plan ready — confirm to continue';
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
    || deploymentProfile
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
    setDeployUiPhase('error');
    if (selectedProject) {
      getOrCreateActiveDeployment(selectedProject.id).inFlight = false;
    }
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
  }, [appendLog, patchState, selectedProject]);
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
    // Detected keys are hints only — never a pipeline gate. Static / CloudFront
    // deploys typically need none of these.
    return [] as string[];
  }, []);
  const optionalAppSecretKeys = useMemo(() => {
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
    if (deploymentPlan !== 's3_cloudfront') {
      const frameworks = Array.isArray(repoContext?.frameworks)
        ? repoContext.frameworks.map((item) => String((item as { name?: string })?.name || item || '').toLowerCase()).join(' ')
        : '';
      if (/nextauth|auth\.js|passport|oauth|supabase/.test(frameworks) || /google|github|oauth|nextauth/i.test(JSON.stringify(repoContext?.environment_variables || {}))) {
        for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'NEXTAUTH_SECRET']) {
          keys.add(key);
        }
      }
    }
    return Array.from(keys).filter((key) => !['JWT_SECRET', 'AUTH_SECRET'].includes(key));
  }, [deploymentPlan, deploymentProfile, repoContext]);
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
  const infraAccessBriefing = useMemo(() => buildInfraAccessBriefing({
    summary: deploySummary,
    iacOutputs: iacResourceOutputs?.outputs || null,
    decision: approvedConsultantDecision || currentInfraConsultant?.decision || null,
    region: terraformRuntimeConfig.aws_region || DEFAULT_AWS_REGION,
    planned: {
      plan: deploymentPlan === 'ecs_fargate' ? 'ecs' : deploymentPlan === 's3_cloudfront' ? 'static' : 'ec2',
      instanceType: ec2ResourceConfig.instance_type,
      diskGb: ec2ResourceConfig.root_volume_size_gb,
      appPort: ec2ResourceConfig.app_port,
      needEip: Boolean(approvedConsultantDecision?.need_eip),
      needAlb: Boolean(approvedConsultantDecision?.need_alb),
      includeRds: Boolean(deploymentServices.rds),
      includeRedis: Boolean(deploymentServices.redis),
      rds: deploymentServices.rds ? rdsResourceConfig : null,
      redis: deploymentServices.redis ? redisResourceConfig : null,
      ecs: deploymentPlan === 'ecs_fargate' ? ecsResourceConfig : null,
      components: selectedDeploymentComponents,
    },
  }), [
    approvedConsultantDecision,
    currentInfraConsultant?.decision,
    deploySummary,
    deploymentPlan,
    deploymentServices.rds,
    deploymentServices.redis,
    ec2ResourceConfig.app_port,
    ec2ResourceConfig.instance_type,
    ec2ResourceConfig.root_volume_size_gb,
    ecsResourceConfig,
    iacResourceOutputs?.outputs,
    rdsResourceConfig,
    redisResourceConfig,
    selectedDeploymentComponents,
    terraformRuntimeConfig.aws_region,
  ]);
  const appDeployDefaults = useMemo(() => {
    const ecrFromIac = (iacResourceOutputs?.outputs || []).find((entry) => ['ecr_repository_url', 'ecr_url'].includes(String(entry.key || '').toLowerCase()))?.value;
    const account = firstProvisioned((liveRuntimeDetails as { account_id?: string } | null)?.account_id);
    const slug = String(selectedProject?.name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const regionName = terraformRuntimeConfig.aws_region || DEFAULT_AWS_REGION;
    const inferred = account && slug ? `${account}.dkr.ecr.${regionName}.amazonaws.com/${slug}` : '';
    const image = firstProvisioned(deploySummary.ecrRepositoryUrl, ecrFromIac, inferred) || '';
    const healthUrl = firstProvisioned(deploySummary.healthCheckUrl, infraAccessBriefing.healthUrl);
    let healthEndpoint = '/health';
    if (healthUrl) {
      try {
        const parsed = new URL(healthUrl.includes('://') ? healthUrl : `http://placeholder.local${healthUrl.startsWith('/') ? healthUrl : `/${healthUrl}`}`);
        healthEndpoint = parsed.pathname || '/health';
      } catch {
        if (healthUrl.startsWith('/')) healthEndpoint = healthUrl;
      }
    }
    return {
      image,
      containerPort: String(coerceHttpAppPort(infraAccessBriefing.appPort || ec2ResourceConfig.app_port, 3000)),
      hostPort: '80',
      healthEndpoint,
    };
  }, [
    deploySummary.ecrRepositoryUrl,
    deploySummary.healthCheckUrl,
    ec2ResourceConfig.app_port,
    iacResourceOutputs?.outputs,
    infraAccessBriefing.appPort,
    infraAccessBriefing.healthUrl,
    liveRuntimeDetails,
    selectedProject?.name,
    terraformRuntimeConfig.aws_region,
  ]);
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
  const analysisMetrics = useMemo(() => deriveAnalysisMetrics(repoContext), [repoContext]);
  const analysisDetectedServices = useMemo(() => deriveDetectedServices(repoContext), [repoContext]);
  useEffect(() => {
    const node = logPanelRef.current;
    if (!node || !logStickToBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [deployLogs, socketNotices]);

  useEffect(() => {
    try {
      writeSavedAws(aws);
    } catch {
      // Credentials stay in React state if sessionStorage is full.
    }
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
      try {
        const raw = sessionStorage.getItem('pipeline.aws');
        if (!raw) {
          writeSavedAws(aws);
          return;
        }
      } catch {
        return;
      }
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
    if (isFailedDeployAttempt({ status: deployStatus, uiPhase: deployUiPhase, result: deployResult })) {
      if (deployUiPhase !== 'error') setDeployUiPhase('error');
      return;
    }
    const applyInFlight = deployUiPhase === 'starting'
      || deployUiPhase === 'waiting_api'
      || deployUiPhase === 'reconciling';
    if (!applyInFlight && isAwaitingPlanConfirmation({
      uiPhase: deployUiPhase,
      requiresPlanConfirmation,
      result: deployResult,
    })) {
      if (deployUiPhase !== 'awaiting_plan') setDeployUiPhase('awaiting_plan');
      return;
    }
    if (deployStatus === 'running' && (deployUiPhase === 'idle' || deployUiPhase === 'done')) {
      setDeployUiPhase('waiting_api');
    } else if (deployStatus === 'done') {
      setDeployUiPhase('done');
    }
  }, [deployResult, deployStatus, deployUiPhase, requiresPlanConfirmation]);

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
      setQuestionCursor(null);
      lastPrefillQuestionIdRef.current = null;
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
    if (nextStage === 'deploy' && (!hasAwsSecrets || !canContinueToAwsConfig) && !options?.force) {
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

  const restartPipeline = useCallback(() => {
    if (!selectedProjectId) return;
    clearPlanningState();
    idleRecoveryRef.current = null;
    analysisRequestRef.current = null;
    reviewRequestRef.current = null;
    generatePlanInFlightRef.current = false;
    planAttemptedKeyRef.current = null;
    terraformAutostartRef.current = null;
    decisionCostRequestKeyRef.current = null;
    socketNoticeKeysRef.current.clear();
    setAnalysisLoading(false);
    setReviewLoading(false);
    setRepoContext(null);
    setRepoContextMd('');
    setReview(null);
    setAnswers({});
    setQuestionCursor(null);
    lastPrefillQuestionIdRef.current = null;
    setDeploymentProfile(null);
    setArchitectureView(null);
    setApprovalPayload(null);
    setIacFiles([]);
    setSelectedFile('');
    persistApprovedDecision(null);
    persistInfraConsultant(null);
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
    setAndPersistStage('analysis');
  }, [persistApprovedDecision, persistInfraConsultant, selectedProjectId, setAndPersistStage]);

  const handleSelectDeploymentProject = useCallback((nextProjectId: string) => {
    router.push(`/dashboard/deploy?projectId=${encodeURIComponent(nextProjectId)}&entry=selector`);
  }, [router]);

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
    if (review && review.context_json.workspace === expectedWorkspace && review.questions.length > 0) return;
    if (!repoContext || repoContext.workspace !== expectedWorkspace) {
      setAndPersistStage('analysis');
      return;
    }
    void loadReview().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Failed to start architecture review.'));
  }, [activeStage, expectedWorkspace, loadReview, repoContext, review, selectedProject, setAndPersistStage]);

  const generatePlan = useCallback(async (overrideAnswers?: Record<string, string>) => {
    if (!selectedProject || !review) return;
    if (generatePlanInFlightRef.current) return;
    generatePlanInFlightRef.current = true;
    setError(null);
    setInfraConsultantLoading(true);
    const userAnswers = {
      ...answers,
      ...(overrideAnswers || {}),
    };
    setAnswers(userAnswers);
    writeStoredJson(REVIEW_ANSWERS_KEY, userAnswers);
    const mergedAnswers = {
      ...(review.defaults || {}),
      ...userAnswers,
    };
    planAttemptedKeyRef.current = JSON.stringify(userAnswers);
    try {
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
      const budgetCap = budgetCapFromAnswers(mergedAnswers, Number((data.approval_payload?.budget_gate as { cap_usd?: number } | undefined)?.cap_usd || 100));
      const costTotal = Number((data.approval_payload?.cost_estimate as { total_monthly_usd?: number } | undefined)?.total_monthly_usd || 0);
    writeStoredJson(COST_ESTIMATE_KEY, {
        total_monthly_usd: costTotal,
        budget_cap_usd: budgetCap,
      });
      const synthesized = decisionFromDeploymentProfile({
        deploymentProfile: data.deployment_profile,
        answers: mergedAnswers,
        awsRegion: terraformRuntimeConfig.aws_region.trim() || DEFAULT_AWS_REGION,
      });
      const nextPlan = inferDeploymentPlanFromDecision(synthesized);
      const nextServices = inferServicesFromDecision(synthesized);
      setDeploymentPlan(nextPlan);
      writeStoredJson(DEPLOYMENT_PLAN_KEY, nextPlan);
      setDeploymentServices(nextServices);
      writeStoredJson(DEPLOYMENT_SERVICES_KEY, nextServices);
      const nextEc2 = ec2ResourceConfigFromDecision(synthesized);
      setEc2ResourceConfig(nextEc2);
      writeStoredJson(EC2_RESOURCE_CONFIG_KEY, nextEc2);
      const nextRds = rdsResourceConfigFromDecision(synthesized);
      if (nextRds) {
        setRdsResourceConfig(nextRds);
        writeStoredJson(RDS_RESOURCE_CONFIG_KEY, nextRds);
      }
      const nextRedis = redisResourceConfigFromDecision(synthesized);
      if (nextRedis) {
        setRedisResourceConfig(nextRedis);
        writeStoredJson(REDIS_RESOURCE_CONFIG_KEY, nextRedis);
      }
      const nextEcs = ecsResourceConfigFromDecision(synthesized);
      if (nextEcs) {
        setEcsResourceConfig(nextEcs);
        writeStoredJson(ECS_RESOURCE_CONFIG_KEY, nextEcs);
      }
      const nextStatic = staticSiteResourceConfigFromDecision(synthesized);
      if (nextStatic) {
        setStaticSiteResourceConfig(nextStatic);
        writeStoredJson(STATIC_SITE_RESOURCE_CONFIG_KEY, nextStatic);
      }
      const history = buildScriptedHistory(review.questions || [], mergedAnswers, (review.questions || []).length);
      const summary = summarizeInfraConsultantDecision(synthesized);
      persistInfraConsultant({
        workspace: expectedWorkspace,
        history,
        repo_detection_summary: String(review.context_json.summary || ''),
        turn_count: history.filter((item) => item.role === 'user').length,
        decision: synthesized,
        summary,
        confirmed: true,
        ready: true,
        budget_cap_usd: budgetCap,
        selected_tier: 'recommended',
        budget_gate: (data.approval_payload?.budget_gate as InfraConsultantState['budget_gate']) || {
          cap_usd: budgetCap,
          total_usd: costTotal,
          status: costTotal > budgetCap ? 'FAIL' : 'PASS',
        },
        advisor_cost_estimate: {
          subtotal_monthly_usd: costTotal,
          currency: 'USD',
        },
      });
      persistApprovedDecision({
        workspace: expectedWorkspace,
        decision: synthesized,
        locked_at: new Date().toISOString(),
      });
    } finally {
      generatePlanInFlightRef.current = false;
      setInfraConsultantLoading(false);
    }
  }, [answers, expectedWorkspace, persistApprovedDecision, persistInfraConsultant, review, selectedProject, terraformRuntimeConfig.aws_region]);

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
    try {
      const workspaceSessionId = await createWorkspaceSession({
        service: 'deploy',
        project_id: selectedProject.id,
        title: `Generate infrastructure · ${selectedProject.name}`,
        repo: selectedProject.name,
        status: 'running',
        current_stage: 'terraform_generation',
      });
      if (workspaceSessionId) workspaceSessionIdRef.current = workspaceSessionId;
      appendLog('Starting infrastructure generation from the confirmed deployment profile.', 'info', { stage: 'terraform_generation' });
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
          iac_mode: 'deterministic',
          terraform_renderer: 'deplai_deterministic',
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
          workspace_session_id: workspaceSessionIdRef.current || undefined,
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
        workspace_session_id?: string;
      };
      if (typeof data.workspace_session_id === 'string' && data.workspace_session_id) {
        workspaceSessionIdRef.current = data.workspace_session_id;
      }
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
      finalizeWorkspaceSession(workspaceSessionIdRef.current, {
        status: 'completed',
        current_stage: 'terraform_generation',
        changed_files_count: files.length,
      });
      return true;
    } catch (reason) {
      const rawMessage = reason instanceof Error ? reason.message : 'Infrastructure generation failed.';
      const message = /failed to fetch/i.test(rawMessage)
        ? 'The connection to the DeplAI API was interrupted before Terraform generation returned a result. Select Regenerate Terraform to retry.'
        : rawMessage;
      appendLog(message, 'error', { stage: 'terraform_generation' });
      finalizeWorkspaceSession(workspaceSessionIdRef.current, {
        status: 'failed',
        current_stage: 'terraform_generation',
        message,
      });
      setError(message);
      return false;
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

    if (!approvedConsultantDecision && !deploymentProfile) return;
    const autostartKey = `${selectedProject.id}:${expectedWorkspace}:${decisionSignature}:${Boolean(hasSuccessfulGeneration)}`;
    if (terraformAutostartRef.current === autostartKey) return;
    terraformAutostartRef.current = autostartKey;

    resetCurrentIacSessionArtifacts();
    appendLog('Planning answers locked. Starting deterministic Terraform generation.', 'info', { stage: 'terraform_generation' });
    void generateTerraform().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Infrastructure generation failed.');
    });
  }, [
    activeStage,
    appendLog,
    approvedConsultantDecision,
    deploymentProfile,
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
    if (!baseResult?.success) {
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
    const runtimeAwaitingPlan = isAwaitingPlanConfirmation({
      result: runtimeResult,
    }) || runtimeStatus === 'awaiting_plan_confirmation';

    if (runtimeAwaitingPlan) {
      const gatedResult: DeployApiResult = {
        ...((runtimeResult || {}) as DeployApiResult),
        success: true,
        status: 'awaiting_plan_confirmation',
        requires_plan_confirmation: true,
      };
      patchState((prev) => ({
        ...prev,
        status: 'idle',
        progress: Math.max(prev.progress, 60),
        deployResult: {
          ...((prev.deployResult || {}) as DeployApiResult),
          ...gatedResult,
          plan_summary: gatedResult.plan_summary || prev.deployResult?.plan_summary || null,
        },
      }));
      getOrCreateActiveDeployment(selectedProject.id).inFlight = false;
      return;
    }

    if (['pending', 'selecting_params', 'validating', 'planning', 'applying', 'running'].includes(runtimeStatus)) {
      patchState((prev) => {
        if (isFailedDeployAttempt({ status: prev.status, result: prev.deployResult })) {
          return prev;
        }
        if (isAwaitingPlanConfirmation({ result: prev.deployResult })) {
          return prev;
        }
        return {
          ...prev,
          status: 'running' as const,
          progress: Math.max(prev.progress, 55),
          deployResult: runtimeResult || prev.deployResult,
        };
      });
      return;
    }

    if (
      (runtimeStatus === 'completed' || runtimeStatus === 'needs_review' || runtimeStatus === 'deployed')
      && runtimeResult?.success
    ) {
      try {
        const hydratedResult = await hydrateTerminalDeployResult(runtimeResult);
        const hydratedChecks = normalizeVerificationChecks(hydratedResult.verification_checks);
        if (hydratedChecks.length > 0) {
          setEndpointChecks(hydratedChecks);
        }
        patchState((prev) => ({
          ...prev,
          status: 'done',
          progress: 100,
          deployResult: {
            ...hydratedResult,
            error: undefined,
          },
        }));
        getOrCreateActiveDeployment(selectedProject.id).inFlight = false;
        pushDeploymentHistory(hydratedResult, 'done');
        const verificationPending = hydratedResult.deployment_verified === false
          || (hydratedChecks.length > 0 && hydratedChecks.every((check) => !check.ok));
        appendLog(
          verificationPending
            ? 'Infrastructure is provisioned. HTTP verification is still pending — use Verify live endpoints when the app is ready.'
            : 'Recovered completed deployment state from backend runtime.',
          verificationPending ? 'info' : 'success',
        );
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

    patchState((prev) => {
      if (isAwaitingPlanConfirmation({ result: prev.deployResult })) {
        return { ...prev, status: 'idle' };
      }
      return {
        ...prev,
        status: 'error',
        progress: 100,
        deployResult: prev.deployResult || { success: false, error: 'No active deployment process found.' },
      };
    });
    if (isAwaitingPlanConfirmation({ result: getOrCreateActiveDeployment(selectedProject.id).state.deployResult })) {
      getOrCreateActiveDeployment(selectedProject.id).inFlight = false;
      return;
    }
    getOrCreateActiveDeployment(selectedProject.id).inFlight = false;
    appendLog('No active deployment process found. Marking stale UI run as stopped.', 'error');
  }, [appendLog, deployResult?.run_id, hydrateTerminalDeployResult, patchState, pushDeploymentHistory, selectedProject]);

  const pollDeploymentReconciliation = useCallback(async (
    runIdOverride?: string,
    timeoutMs = TERRAFORM_APPLY_POLL_TIMEOUT_MS,
  ) => {
    if (!selectedProject) {
      return {
        status: 'idle' as const,
        progress: 0,
        logs: [],
        deployResult: null,
        deploymentHistory: [],
      };
    }
    const pollStart = Date.now();
    while (Date.now() - pollStart < timeoutMs) {
      await waitForDelay(DEPLOY_RECONCILE_POLL_INTERVAL_MS);
      try {
        await reconcileDeploymentStatus(runIdOverride);
      } catch {
        // keep polling through transient status fetch failures
      }
      const latest = getOrCreateActiveDeployment(selectedProject.id).state;
      if (latest.status === 'done') return latest;
      if (isAwaitingPlanConfirmation({ result: latest.deployResult })) return latest;
      if (isFailedDeployAttempt({ status: latest.status, result: latest.deployResult })) {
        return latest;
      }
    }
    return getOrCreateActiveDeployment(selectedProject.id).state;
  }, [reconcileDeploymentStatus, selectedProject]);

  const finalizeDeployUiFromState = useCallback((latest: ActiveDeployState) => {
    if (isAwaitingPlanConfirmation({ result: latest.deployResult })) {
      setRequiresPlanConfirmation(true);
      setPendingPlanSummary((latest.deployResult?.plan_summary as Record<string, unknown> | null | undefined) || null);
      setDeployUiPhase('awaiting_plan');
      setDeployStatus('idle');
      return;
    }
    if (isFailedDeployAttempt({ status: latest.status, result: latest.deployResult })) {
      setDeployUiPhase('error');
      finalizeWorkspaceSession(workspaceSessionIdRef.current, { status: 'failed', current_stage: 'apply' });
      return;
    }
    if (latest.status === 'done') {
      setDeployUiPhase('done');
      setError(null);
      finalizeWorkspaceSession(workspaceSessionIdRef.current, { status: 'completed', current_stage: 'apply' });
      return;
    }
    setDeployUiPhase('reconciling');
  }, []);

  const recoverDeployAfterTransportGap = useCallback(async (
    payload: Record<string, unknown>,
    runIdOverride?: string,
  ) => {
    const merged = mergeAcceptedApplyResult(null, payload) as DeployApiResult;
    setError(null);
    setDeployUiPhase('reconciling');
    patchState((prev) => ({
      ...prev,
      status: 'running',
      progress: Math.max(prev.progress, 80),
      deployResult: merged,
    }));
    appendLog(
      String(payload.error || 'Connection to the runtime dropped, but Terraform may still be applying. Reconciling…'),
      'info',
    );
    const latest = await pollDeploymentReconciliation(runIdOverride);
    if (latest.status !== 'done' && !isFailedDeployAttempt({ status: latest.status, result: latest.deployResult })) {
      appendLog('Terraform may still be applying. Use Reconcile Backend Status or refresh this page.', 'info');
    }
    finalizeDeployUiFromState(latest);
  }, [appendLog, finalizeDeployUiFromState, patchState, pollDeploymentReconciliation]);

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
    const retryingFailedDeploy = isFailedDeployAttempt({
      status: deployStatus,
      uiPhase: deployUiPhase,
      result: deployResult,
    });

    if (retryingFailedDeploy) {
      const active = getOrCreateActiveDeployment(selectedProject.id);
      active.inFlight = false;
      if (deployRequestRef.current === selectedProject.id) {
        deployRequestRef.current = null;
      }
    }

    if (!retryingFailedDeploy && deployStartBlockers.length > 0) {
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

    if (!retryingFailedDeploy && !confirmingPlan && (activeDeployment.inFlight || deployRequestRef.current === selectedProject.id)) {
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
    const deploySessionId = await createWorkspaceSession({
      service: 'deploy',
      project_id: selectedProject.id,
      title: `Deploy · ${selectedProject.name}`,
      repo: selectedProject.name,
      status: 'running',
      current_stage: 'apply',
    });
    if (deploySessionId) workspaceSessionIdRef.current = deploySessionId;
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

    const startedLog: DeployLogEntry = confirmingPlan
      ? { text: 'Plan confirmed. Submitting Terraform apply…', ts: timestampLabel(), type: 'info' }
      : { text: 'Deploy started. Running preflight checks…', ts: timestampLabel(), type: 'info' };
    const nextProgress = confirmingPlan ? Math.max(deployProgress || 0, 65) : 5;
    setDeployStatus('running');
    setDeployProgress(nextProgress);
    setDeployLogs(confirmingPlan ? [...deployLogs, startedLog] : [startedLog]);

    patchState((prev) => ({
      ...prev,
      status: 'running',
      progress: confirmingPlan ? Math.max(prev.progress || 0, 65) : 5,
      logs: confirmingPlan
        ? [...prev.logs, startedLog]
        : [startedLog],
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
      finalizeWorkspaceSession(workspaceSessionIdRef.current, {
        status: 'failed',
        current_stage: 'apply',
        message: 'AWS credentials are required before deployment.',
      });
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
      appendLog('Calling /api/pipeline/deploy — Terraform apply can take 15–25 minutes when RDS Multi-AZ is included…');
      const retryRunId = String(deployResult?.run_id || activeSavedRun?.run_id || '').trim();
      const retryWorkspace = String(deployResult?.workspace || activeSavedRun?.workspace || '').trim();
      const canReuseSavedRun = shouldUseSavedRunForDeploy || Boolean(retryingFailedDeploy && retryRunId);
      const runtimeDeployFiles = canReuseSavedRun
        ? []
        : (deployableIacFiles.length > 0 ? deployableIacFiles : (retryingFailedDeploy ? iacFiles : []));
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
          run_id: canReuseSavedRun ? (retryRunId || activeSavedRun?.run_id) : undefined,
          workspace: canReuseSavedRun ? (retryWorkspace || activeSavedRun?.workspace) : undefined,
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
          workspace_session_id: workspaceSessionIdRef.current || undefined,
        }),
      });
      const data = await response.json().catch(() => ({})) as DeployApiResult & { detail?: unknown };
      if (typeof data.workspace_session_id === 'string' && data.workspace_session_id) {
        workspaceSessionIdRef.current = data.workspace_session_id;
      }
      if (!response.ok || !data.success) {
        if (isRecoverableApplyTransportError(response.status, data as Record<string, unknown>)) {
          clearHeartbeat();
          await recoverDeployAfterTransportGap(
            data as Record<string, unknown>,
            typeof data.run_id === 'string' ? data.run_id : undefined,
          );
          return;
        }
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
        finalizeWorkspaceSession(workspaceSessionIdRef.current, {
          status: 'failed',
          current_stage: 'apply',
          message,
        });
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
        setDeployStatus('idle');
        patchState((prev) => ({
          ...prev,
          status: 'idle',
          progress: Math.max(prev.progress, 60),
          deployResult: data,
        }));
        appendLog(summarizePlanResources(summary), 'info');
        appendLog('Terraform plan is ready. Click Confirm Plan & Deploy to continue apply.', 'info');
        persistSessionProgress(workspaceSessionIdRef.current, {
          status: 'needs_review',
          current_stage: 'apply',
        });
        return;
      }

      if (data.mode !== 'iac_pipeline' && !data.run_id) {
        clearHeartbeat();
        patchState((prev) => ({
          ...prev,
          status: 'done',
          progress: 100,
          deployResult: {
            ...data,
            error: undefined,
          },
        }));
        pushDeploymentHistory(data, 'done');
        setDeployUiPhase('done');
        setError(null);
        finalizeWorkspaceSession(workspaceSessionIdRef.current, { status: 'completed', current_stage: 'apply' });
        if (data.deployment_verified === false) {
          appendLog('Infrastructure is provisioned. HTTP verification is still pending — use Verify live endpoints when the app is ready.', 'info');
        } else {
          appendLog('Runtime Terraform apply completed successfully.', 'success');
        }
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
            const latestRun = getOrCreateActiveDeployment(selectedProject.id);
            if (!latestRun.inFlight || latestRun.state.status === 'error') break;
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
      finalizeDeployUiFromState(latest);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Deployment failed.';
      if (isRecoverableApplyTransportError(0, null, message)) {
        clearHeartbeat();
        await recoverDeployAfterTransportGap({});
        return;
      }
      clearHeartbeat();
      setDeployUiPhase('error');
      patchState((prev) => ({
        ...prev,
        status: 'error',
        progress: 100,
        deployResult: prev.deployResult || { success: false, error: message },
      }));
      appendLog(message, 'error');
      finalizeWorkspaceSession(workspaceSessionIdRef.current, {
        status: 'failed',
        current_stage: 'apply',
        message,
      });
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
  }, [activeSavedRun, appendLog, approvedConsultantDecision, aws.aws_access_key_id, aws.aws_secret_access_key, aws.aws_session_token, budgetOverride, effectiveBudgetCap, effectiveCostTotal, customizationSnapshotId, customizationTenantId, deployLogs, deployProgress, deployResult, deployStartBlockers, deployStatus, deployUiPhase, deployableIacFiles, deploymentHistory, deploymentPlan, deploymentProfile, finalizeDeployUiFromState, hasAwsSecrets, iacFiles, infraUserAnswers, patchState, pushDeploymentHistory, reconcileDeploymentStatus, recoverDeployAfterTransportGap, rdsResourceConfig, repoContext, requiresPlanConfirmation, savedIacMeta?.source_metadata, secretsManagerPrefix, selectedDeploymentComponents, selectedProject, shouldUseSavedRunForDeploy, terraformRuntimeConfig.aws_region, terraformRuntimeConfig.lock_table, terraformRuntimeConfig.state_bucket]);

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

  const credentialFileStem = useMemo(() => {
    if (deploySummary.keyFileName) return deploySummary.keyFileName.replace(/\.pem$/i, '');
    const key = deploySummary.keyName || 'deplai-ec2-key';
    const instanceId = deploySummary.instanceId && deploySummary.instanceId !== 'n/a' ? deploySummary.instanceId : '';
    return [key, instanceId].filter(Boolean).join('-');
  }, [deploySummary.instanceId, deploySummary.keyFileName, deploySummary.keyName]);

  const wipeDownloadedCredentials = useCallback(() => {
    if (!selectedProject?.id) return;
    const cleared = clearDownloadedDeploySecrets(selectedProject.id, deployResult);
    patchState((prev) => ({ ...prev, deployResult: cleared }));
  }, [deployResult, patchState, selectedProject?.id]);

  const downloadPpk = useCallback(async () => {
    if (!deploySummary.generatedPem) return;
    const response = await fetch('/api/pipeline/keypair/ppk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ private_key_pem: deploySummary.generatedPem, key_name: credentialFileStem, project_name: selectedProject?.name }),
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
    anchor.download = data.file_name || `${credentialFileStem}.ppk`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [credentialFileStem, deploySummary.generatedPem, selectedProject?.name]);

  const downloadOneTimeCredentials = useCallback(async (includePpk: boolean) => {
    const pem = deploySummary.generatedPem || iacKeypair?.private_key_pem || '';
    if (pem) {
      downloadTextFile(`${credentialFileStem}.pem`, pem.endsWith('\n') ? pem : `${pem}\n`);
    }
    if (includePpk && pem) {
      await downloadPpk();
    }
    if (deploySummary.databaseEnv) {
      downloadTextFile(
        deploySummary.databaseFileName || `${credentialFileStem}-database.env`,
        deploySummary.databaseEnv.endsWith('\n') ? deploySummary.databaseEnv : `${deploySummary.databaseEnv}\n`,
      );
    }
    wipeDownloadedCredentials();
  }, [credentialFileStem, deploySummary.databaseEnv, deploySummary.databaseFileName, deploySummary.generatedPem, downloadPpk, iacKeypair?.private_key_pem, wipeDownloadedCredentials]);

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
          run_id: deployResult?.run_id || undefined,
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
  }, [appendLog, aws.aws_access_key_id, aws.aws_secret_access_key, aws.aws_session_token, deployResult?.run_id, deployStatus, destroyLoading, hasAwsSecrets, patchState, selectedProject, terraformRuntimeConfig.aws_region]);

  useEffect(() => {
    if (!selectedProject) return;
    const transportGap = deployStatus === 'error'
      && isTransportFalseFailureMessage(String(deployResult?.error || ''))
      && deployResult?.success !== false;
    if (deployStatus !== 'running' && !transportGap) return;
    if (isAwaitingPlanConfirmation({
      uiPhase: deployUiPhase,
      requiresPlanConfirmation,
      result: deployResult,
    })) return;
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
      if (cancelled) return;
      const latest = getOrCreateActiveDeployment(selectedProject.id).state;
      if (latest.status === 'done' || isFailedDeployAttempt({ status: latest.status, result: latest.deployResult })) {
        finalizeDeployUiFromState(latest);
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
  }, [deployProgress, deployResult, deployStatus, deployUiPhase, finalizeDeployUiFromState, reconcileDeploymentStatus, requiresPlanConfirmation, selectedProject]);

  const showRegenerateTerraformButton =
    Boolean(selectedProject) &&
    /provided terraform bundle (is|appears) outdated|stale terraform bundle|default-vpc conditional mode/i.test(String(error || ''));
  const unansweredQuestionIndex = useMemo(
    () => nextScriptedQuestionIndex(reviewQuestions, answers),
    [answers, reviewQuestions],
  );
  const viewingQuestionIndex = useMemo(
    () => resolveScriptedQuestionCursor(reviewQuestions.length, unansweredQuestionIndex, questionCursor),
    [questionCursor, reviewQuestions.length, unansweredQuestionIndex],
  );
  const currentScriptedQuestion = reviewQuestions[viewingQuestionIndex] || null;
  const scriptedHistory = useMemo(
    () => buildScriptedHistory(reviewQuestions, answers, Math.min(viewingQuestionIndex, Math.max(reviewQuestions.length - 1, 0))),
    [answers, reviewQuestions, viewingQuestionIndex],
  );
  const planningLocked = Boolean(deploymentProfile && (approvedConsultantDecision || currentInfraConsultant?.ready));
  const canContinueFromQa = Boolean(planningLocked && (approvedConsultantDecision || currentInfraConsultant?.decision));
  const questionsComplete = reviewQuestions.length > 0 && unansweredQuestionIndex >= reviewQuestions.length;
  const currentQuestionAnswered = Boolean(
    currentScriptedQuestion && isQuestionAnswered(currentScriptedQuestion.id, answers),
  );
  const previousPlanningAnswers = useMemo(() => {
    return reviewQuestions.flatMap((question, index) => {
      if (!isQuestionAnswered(question.id, answers)) return [];
      if (currentScriptedQuestion && index === viewingQuestionIndex) return [];
      const raw = String(answers[question.id] || '');
      return [{
        index,
        prompt: question.question,
        answer: labelForAnswer(review, question.id, raw) || (raw.trim() ? raw : 'Skip'),
      }];
    });
  }, [answers, currentScriptedQuestion, review, reviewQuestions, viewingQuestionIndex]);
  const maybeGeneratePlan = useCallback((nextAnswers: Record<string, string>, nextCursor: number) => {
    if (!review) return;
    const allAnswered = nextScriptedQuestionIndex(review.questions || [], nextAnswers) >= (review.questions || []).length;
    if (!allAnswered || nextCursor < (review.questions || []).length) return;
    planAttemptedKeyRef.current = JSON.stringify(nextAnswers);
    void generatePlan(nextAnswers).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Failed to generate deployment profile.');
    });
  }, [generatePlan, review]);
  const answerScriptedQuestion = useCallback((questionId: string, value: string) => {
    if (!review) return;
    const nextAnswers = { ...answers, [questionId]: value };
    const currentIdx = (review.questions || []).findIndex((question) => question.id === questionId);
    const questionCount = (review.questions || []).length;
    const unanswered = nextScriptedQuestionIndex(review.questions || [], nextAnswers);
    const sequentialCursor = currentIdx >= 0 ? currentIdx + 1 : viewingQuestionIndex + 1;
    const nextCursor = sequentialCursor >= questionCount && unanswered < questionCount
      ? unanswered
      : sequentialCursor;
    setAnswers(nextAnswers);
    writeStoredJson(REVIEW_ANSWERS_KEY, nextAnswers);
    setQuestionCursor(nextCursor);
    maybeGeneratePlan(nextAnswers, nextCursor);
  }, [answers, maybeGeneratePlan, review, viewingQuestionIndex]);
  const jumpToQuestion = useCallback((index: number) => {
    if (reviewQuestions.length === 0) return;
    setQuestionCursor(resolveScriptedQuestionCursor(reviewQuestions.length, unansweredQuestionIndex, index));
  }, [reviewQuestions.length, unansweredQuestionIndex]);
  const goToPreviousQuestion = useCallback(() => {
    if (reviewQuestions.length === 0) return;
    const from = viewingQuestionIndex >= reviewQuestions.length ? reviewQuestions.length : viewingQuestionIndex;
    setQuestionCursor(Math.max(0, from - 1));
  }, [reviewQuestions.length, viewingQuestionIndex]);
  const goToNextQuestion = useCallback(() => {
    if (!currentQuestionAnswered) return;
    const allAnswered = unansweredQuestionIndex >= reviewQuestions.length;
    if (viewingQuestionIndex + 1 >= reviewQuestions.length && !allAnswered) {
      setQuestionCursor(unansweredQuestionIndex);
      return;
    }
    const nextCursor = viewingQuestionIndex + 1;
    setQuestionCursor(nextCursor);
    maybeGeneratePlan(answers, nextCursor);
  }, [answers, currentQuestionAnswered, maybeGeneratePlan, unansweredQuestionIndex, reviewQuestions.length, viewingQuestionIndex]);
  useEffect(() => {
    const questionId = currentScriptedQuestion?.id || null;
    if (lastPrefillQuestionIdRef.current === questionId) return;
    lastPrefillQuestionIdRef.current = questionId;
    if (!questionId || (currentScriptedQuestion?.options || []).length > 0) return;
    setInfraConsultantInput(String(answers[questionId] || ''));
  }, [answers, currentScriptedQuestion]);
  useEffect(() => {
    if (activeStage !== 'qa' || planningLocked || infraConsultantLoading || reviewLoading) return;
    if (!questionsComplete) return;
    if (viewingQuestionIndex < reviewQuestions.length) return;
    const key = JSON.stringify(answers);
    if (planAttemptedKeyRef.current === key) return;
    planAttemptedKeyRef.current = key;
    void generatePlan(answers).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Failed to generate deployment profile.');
    });
  }, [activeStage, answers, generatePlan, infraConsultantLoading, planningLocked, questionsComplete, reviewLoading, reviewQuestions.length, viewingQuestionIndex]);
  const retryGeneratePlan = useCallback(() => {
    planAttemptedKeyRef.current = null;
    setQuestionCursor(reviewQuestions.length);
    void generatePlan(answers).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Failed to generate deployment profile.');
    });
  }, [answers, generatePlan, reviewQuestions.length]);
  const unlockPlanningAnswers = useCallback(() => {
    setDeploymentProfile(null);
    setArchitectureView(null);
    setApprovalPayload(null);
    persistApprovedDecision(null);
    persistInfraConsultant(null);
    planAttemptedKeyRef.current = null;
    generatePlanInFlightRef.current = false;
    setQuestionCursor(0);
    setAndPersistStage('qa');
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(DEPLOYMENT_PROFILE_KEY);
      sessionStorage.removeItem(ARCHITECTURE_VIEW_KEY);
      sessionStorage.removeItem(APPROVAL_PAYLOAD_KEY);
    }
  }, [persistApprovedDecision, persistInfraConsultant, setAndPersistStage]);
  const advanceToArchitecture = useCallback(() => {
    if (!currentInfraConsultant?.decision) return;
    if (!currentInfraConsultant.confirmed) {
      approveInfraConsultantDecision();
    }
    setAndPersistStage('architecture');
  }, [approveInfraConsultantDecision, currentInfraConsultant, setAndPersistStage]);
  const advisorBudget = Number(currentInfraConsultant?.budget_cap_usd || costEstimate.cap || 0);
  const advisorEstimate = Number(currentInfraConsultant?.advisor_cost_estimate?.subtotal_monthly_usd || currentInfraConsultant?.budget_gate?.total_usd || 0);
  const advisorGateStatus = String(currentInfraConsultant?.budget_gate?.status || '').toUpperCase();
  const planningComponentRows = useMemo(() => {
    const decision = currentInfraConsultant?.decision;
    if (!decision) return [];
    const stack = toRecord(decision.stack_config);
    return normalizeDecisionComponents(decision).map((id) => ({
      name: formatComponentName(id),
      details: componentDetails(id, stack).join(' · '),
    }));
  }, [currentInfraConsultant?.decision]);
  const planningNotes = useMemo(
    () => humanizeConsultantNotes(
      Array.isArray(currentInfraConsultant?.decision?.consultant_notes)
        ? currentInfraConsultant.decision.consultant_notes.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
    ),
    [currentInfraConsultant?.decision?.consultant_notes],
  );
  const qaLiveConsultantView = (
    <StageShell stageKey="planning" hasActionBar width="wide">
      <StageHeader
        eyebrow="Stage 02 · Planning"
        title="Planning"
        description={
          reviewLoading
            ? 'Preparing deployment questions from repository analysis.'
            : planningLocked
              ? 'Review the proposed AWS setup, then continue to architecture. Change answers anytime to edit the questionnaire.'
              : 'Answer one question at a time. Use Back or Change to edit a previous response without starting over.'
        }
        meta={
          <>
            <MetaChip label="repo" value={selectedProject?.name || '—'} />
            <MetaChip
              label="question"
              value={reviewQuestions.length ? `${Math.min(viewingQuestionIndex + 1, reviewQuestions.length)}/${reviewQuestions.length}` : '—'}
            />
            <MetaChip
              label="budget"
              value={advisorBudget > 0 ? `$${advisorBudget.toFixed(0)}/mo` : 'unset'}
              tone={advisorBudget > 0 ? 'accent' : 'neutral'}
            />
            {advisorGateStatus ? (
              <MetaChip
                label="gate"
                value={advisorGateStatus}
                tone={advisorGateStatus === 'PASS' ? 'ok' : advisorGateStatus === 'FAIL' ? 'warn' : 'neutral'}
              />
            ) : null}
          </>
        }
      />
      {reviewLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-28 w-full" />
          ))}
        </div>
      ) : review ? (
      <PlanningAgentPanel
        projectName={selectedProject?.name || 'project'}
        loading={infraConsultantLoading}
          messages={scriptedHistory.length > 0 ? scriptedHistory : [{ role: 'assistant', content: currentScriptedQuestion?.question || `I've analyzed \`${selectedProject?.name || 'your project'}\`. Let's lock the deployment plan with a few questions.` }]}
        input={infraConsultantInput}
        onInputChange={setInfraConsultantInput}
        onSubmit={() => {
            if (!currentScriptedQuestion) return;
            answerScriptedQuestion(currentScriptedQuestion.id, infraConsultantInput.trim());
            setInfraConsultantInput('');
          }}
          submitDisabled={infraConsultantLoading || planningLocked || (!infraConsultantInput.trim() && Boolean(currentScriptedQuestion && (currentScriptedQuestion.options || []).length === 0 && currentScriptedQuestion.required !== false))}
        onContinue={advanceToArchitecture}
        continueDisabled={!canContinueFromQa}
          showDecision={planningLocked}
          onRefine={unlockPlanningAnswers}
        approved={Boolean(currentInfraConsultant?.confirmed)}
        planSummary={consultantDecisionSummary}
        planNotes={planningNotes}
        region={String(currentInfraConsultant?.decision?.region || terraformRuntimeConfig.aws_region || '')}
        estimateUsd={advisorEstimate}
        budgetUsd={advisorBudget}
        componentRows={planningComponentRows}
        deploySequence={(currentInfraConsultant?.decision?.deploy_sequence || []).map((item) => formatComponentName(String(item)))}
          currentQuestion={planningLocked ? null : currentScriptedQuestion}
          questionIndex={viewingQuestionIndex}
          questionTotal={reviewQuestions.length}
          onSelectOption={(value) => {
            if (!currentScriptedQuestion) return;
            answerScriptedQuestion(currentScriptedQuestion.id, value);
          }}
          onSkip={() => {
            if (!currentScriptedQuestion) return;
            answerScriptedQuestion(currentScriptedQuestion.id, '');
          }}
          questionsComplete={questionsComplete}
          onRetryGenerate={retryGeneratePlan}
          selectedValue={currentScriptedQuestion ? String(answers[currentScriptedQuestion.id] || '') : ''}
          currentAnswered={currentQuestionAnswered}
          previousAnswers={planningLocked ? [] : previousPlanningAnswers}
          onJumpToQuestion={jumpToQuestion}
          onBack={goToPreviousQuestion}
          onNext={goToNextQuestion}
          backDisabled={viewingQuestionIndex <= 0 && Boolean(currentScriptedQuestion)}
          nextDisabled={!currentQuestionAnswered}
          nextLabel={
            viewingQuestionIndex >= reviewQuestions.length - 1 && questionsComplete
              ? 'Generate plan'
              : 'Next question'
          }
        />
      ) : (
        <Panel padded={false}>
          <EmptyState
            icon={<CircleDashed className="h-5 w-5" />}
            title="Questionnaire unavailable"
            description="The deployment questionnaire could not be loaded. Return to repository analysis and retry."
          />
      </Panel>
      )}
    </StageShell>
  );

  const decisionNodePositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number; height: number }>();
    for (const node of decisionDiagram.nodes) {
      map.set(node.id, { x: node.x, y: node.y, height: getDecisionNodeHeight(node) });
    }
    return map;
  }, [decisionDiagram.nodes]);
  const decisionCanvasHeight = decisionDiagram.hasPrivateTier ? 520 : 360;
  const decisionDiagramCanvas = (
    <svg
      viewBox={`0 0 980 ${decisionCanvasHeight}`}
      className="w-full rounded-xl"
      style={{ background: 'radial-gradient(120% 90% at 50% 0%, #101015 0%, #07070a 60%)' }}
    >
      <defs>
        <marker id="decision-flow-arrow" markerWidth="7" markerHeight="5" refX="6" refY="2.5" orient="auto">
          <polygon points="0 0, 7 2.5, 0 5" fill="rgba(163,230,53,0.65)" />
        </marker>
        <pattern id="decision-grid" width="28" height="28" patternUnits="userSpaceOnUse">
          <path d="M 28 0 L 0 0 0 28" fill="none" stroke="rgba(255,255,255,0.035)" strokeWidth="1" />
        </pattern>
        <linearGradient id="decision-edge" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="rgba(163,230,53,0.12)" />
          <stop offset="100%" stopColor="rgba(163,230,53,0.6)" />
        </linearGradient>
        <filter id="decision-node-shadow" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="6" stdDeviation="8" floodColor="#000" floodOpacity="0.55" />
        </filter>
      </defs>
      <rect x="0" y="0" width="980" height={decisionCanvasHeight} fill="url(#decision-grid)" />
      {decisionDiagram.hasVpcBoundary ? (
        <>
          <rect
            x="190"
            y="48"
            width="740"
            height={decisionDiagram.hasPrivateTier ? 420 : 260}
            rx="20"
            fill="rgba(255,255,255,0.012)"
            stroke="rgba(255,255,255,0.09)"
            strokeWidth="1"
          />
          <text
            x="214"
            y="76"
            fill="#a3e635"
            fontSize="10"
            letterSpacing="0.18em"
            style={{ fontFamily: 'var(--font-mono, monospace)' }}
          >
            VPC · {String(decisionDiagram.awsRegion).toUpperCase()}
          </text>
          <rect
            x="220"
            y="100"
            width="680"
            height={decisionDiagram.hasPrivateTier ? 170 : 180}
            rx="16"
            fill="rgba(255,255,255,0.018)"
            stroke="rgba(255,255,255,0.07)"
            strokeDasharray="4 5"
          />
          <text x="240" y="124" fill="#6b6b75" fontSize="9.5" letterSpacing="0.2em" style={{ fontFamily: 'var(--font-mono, monospace)' }}>
            PUBLIC SUBNET
          </text>
          {decisionDiagram.hasPrivateTier ? (
            <>
              <rect
                x="220"
                y="292"
                width="680"
                height="150"
                rx="16"
                fill="rgba(255,255,255,0.01)"
                stroke="rgba(255,255,255,0.055)"
                strokeDasharray="4 5"
              />
              <text x="240" y="316" fill="#6b6b75" fontSize="9.5" letterSpacing="0.2em" style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                PRIVATE SUBNET{decisionDiagram.hasMultiAz ? ' · MULTI-AZ' : ''}
              </text>
            </>
          ) : null}
        </>
      ) : null}
      {decisionDiagram.edges.map((edge, index) => {
        const from = decisionNodePositions.get(edge.from);
        const to = decisionNodePositions.get(edge.to);
        if (!from || !to) return null;
        const x1 = from.x + 64;
        const y1 = from.y + from.height / 2;
        const x2 = to.x + 64;
        const y2 = to.y + to.height / 2;
        return (
          <g key={`${edge.from}-${edge.to}-${index}`}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="url(#decision-edge)" strokeWidth="1.5" markerEnd="url(#decision-flow-arrow)" />
            {/* Packet dot travelling the edge conveys direction of traffic flow. */}
            <circle className="dw-edge-packet" r="2.5" fill="#a3e635" opacity="0.85">
              <animateMotion
                dur="2.6s"
                begin={`${index * 0.35}s`}
                repeatCount="indefinite"
                path={`M ${x1} ${y1} L ${x2} ${y2}`}
              />
            </circle>
          </g>
        );
      })}
      {Array.from(new Map(decisionDiagram.nodes.map((node) => [node.id, node])).values()).map((node) => {
        const details = node.details.slice(0, 2);
        const height = getDecisionNodeHeight(node);
        const isInternet = node.id === 'internet';
        return (
          <g key={node.id} transform={`translate(${node.x},${node.y})`} filter="url(#decision-node-shadow)">
            <rect
              width="128"
              height={height}
              rx="14"
              fill={isInternet ? 'rgba(255,255,255,0.055)' : 'rgba(255,255,255,0.035)'}
              stroke={isInternet ? 'rgba(255,255,255,0.18)' : `${node.color}66`}
              strokeWidth="1"
            />
            <rect width="128" height="1" rx="0.5" fill="rgba(255,255,255,0.1)" />
            <circle cx="18" cy="18" r="3.5" fill={node.color} />
            <circle cx="18" cy="18" r="6.5" fill="none" stroke={node.color} strokeOpacity="0.3" strokeWidth="1" />
            <text
              x="64"
              y={details.length ? 22 : height / 2 + 4}
              textAnchor="middle"
              fill="#ededf0"
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
                fill="#8b8b95"
                fontSize="9.5"
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
    <div className="deployment-workspace flex h-full overflow-hidden bg-[var(--dw-canvas)] font-sans text-[var(--dw-fg-soft)]">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <DeploymentCommandHeader onExit={() => router.push('/dashboard')} />
        <DeploymentPipelineHeader
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={handleSelectDeploymentProject}
          onRestart={restartPipeline}
          restartDisabled={!selectedProjectId || analysisLoading}
        />
        <DeploymentStageRail activeStage={activeStage} onSelectStage={setAndPersistStage} />
        <div className="dw-scrollbar relative flex-1 overflow-y-auto p-6 lg:p-8">
          {error && (
            <div className="mx-auto mb-6 max-w-5xl">
              <Callout
                tone="danger"
                title="Pipeline error"
                actions={
                  showRegenerateTerraformButton ? (
                    <button
                      onClick={() => {
                        setAndPersistStage('terraform');
                        resetCurrentIacSessionArtifacts();
                        void generateTerraform().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Infrastructure generation failed.'));
                      }}
                      className={buttonClass('danger', { size: 'sm' })}
                    >
                      Regenerate Terraform
                    </button>
                  ) : null
                }
              >
                {error}
              </Callout>
            </div>
          )}
          {activeStage === 'analysis' && (
            !projectsLoaded ? (
              <StageShell stageKey="analysis-loading" className="flex flex-col gap-5">
                <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
                  {[0, 1, 2, 3].map((index) => (
                    <Skeleton key={index} className="h-[86px] w-full" />
                  ))}
                </div>
                <Skeleton className="h-64 w-full" />
              </StageShell>
            ) : selectedProject ? (
              <StageShell stageKey="analysis" hasActionBar>
                <StageHeader
                  eyebrow="Stage 01 · Analysis"
                  title="Repository analysis"
                  description="DeplAI reads the codebase to infer runtime, framework, exposed ports, and the external services your app depends on."
                  meta={
                    <>
                      <MetaChip label="repo" value={selectedProject.name} />
                      <MetaChip
                        label="status"
                        value={analysisLoading ? 'scanning' : 'complete'}
                        tone={analysisLoading ? 'info' : 'ok'}
                      />
                    </>
                  }
                />
                <AnalysisStagePanel
                  loading={analysisLoading}
                  metrics={analysisMetrics}
                  services={analysisDetectedServices}
                  continueDisabled={analysisLoading || !repoContext || repoContext.workspace !== expectedWorkspace}
                  onContinue={() => setAndPersistStage('qa')}
                />
              </StageShell>
            ) : (
              <StageShell stageKey="analysis-empty">
                <Panel padded={false}>
                  <EmptyState
                    icon={<Server className="h-5 w-5" />}
                    title="Choose a repository from the dashboard"
                    description="The deployment pipeline runs against one repository at a time. Start from a repo card on the dashboard so the flow binds to the right project."
                    actions={
                      <button onClick={() => router.push('/dashboard')} className={pipelinePrimaryButtonClass(false)}>
                        Back to dashboard
                      </button>
                    }
                  />
                </Panel>
              </StageShell>
            )
          )}

          {activeStage === 'qa' && qaLiveConsultantView}
          {activeStage === 'architecture' && (
            <StageShell stageKey="architecture" hasActionBar width="wide">
              <StageHeader
                eyebrow="Stage 03 · Architecture"
                title="Proposed topology"
                description="Visualized from the approved planning decision. Nodes and edges reflect the stack that will be priced and generated next."
                meta={
                  <>
                    <MetaChip
                      label="region"
                      value={String(decisionDiagram.awsRegion || 'pending')}
                      tone={decisionDiagram.awsRegion ? 'accent' : 'neutral'}
                    />
                    <MetaChip
                      label="nodes"
                      value={String(decisionDiagram.nodes.length)}
                    />
                  </>
                }
              />
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
                <Panel className="xl:col-span-2" padded={false} elevation="base" glow={decisionDiagram.nodes.length > 0}>
                  <PanelHeader
                    title="Topology"
                    subtitle={
                      decisionDiagram.components.length > 0
                        ? decisionDiagram.components.map((item) => formatComponentName(item)).join(' · ')
                        : 'Waiting for a planning decision'
                    }
                    tone="accent"
                  />
                  <div className="p-4">
                    {decisionDiagram.nodes.length > 0 ? (
                      <div className="overflow-hidden rounded-xl dw-panel-recessed">{decisionDiagramCanvas}</div>
                    ) : (
                      <EmptyState
                        icon={<Server className="h-5 w-5" />}
                        title="Continue from Planning to see topology"
                        description="The architecture diagram appears after you continue from the proposed plan."
                      />
                    )}
                  </div>
                </Panel>
                <div className="space-y-5">
                  <Panel>
                    <SectionLabel>Stack</SectionLabel>
                    {decisionDiagram.components.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {decisionDiagram.components.map((item, index) => (
                          <Chip key={`stack-${index}-${item}`} mono>
                            {formatComponentName(item)}
                          </Chip>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[13px] text-[var(--dw-muted)]">No components yet.</p>
                    )}
                  </Panel>
                  <Panel>
                    <SectionLabel>Why this shape</SectionLabel>
                    {consultantNotesList.length > 0 ? (
                      <ul className="space-y-3 text-[13px] leading-relaxed text-[var(--dw-fg-soft)]">
                        {consultantNotesList.map((note, index) => (
                          <li key={`note-${index}-${note}`} className="border-l border-[var(--dw-accent-line)] pl-3">
                            {note}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[13px] text-[var(--dw-muted)]">
                        Built from your planning answers for this repository.
                      </p>
                    )}
                  </Panel>
                </div>
              </div>
              <StickyActionBar hint={decisionForVisualization ? 'Topology locked. Next: price the stack against your budget.' : 'Continue from Planning to lock a setup first.'}>
                <button
                  type="button"
                  onClick={unlockPlanningAnswers}
                  className={`${secondaryButtonClass(false)} gap-2`}
                >
                  <ArrowLeft className="h-4 w-4" />
                  Change answers
                </button>
                <button
                  type="button"
                  onClick={() => setAndPersistStage('cost_estimation')}
                  disabled={!decisionForVisualization}
                  className={primaryButtonClass(!decisionForVisualization)}
                >
                  Continue to cost →
                </button>
              </StickyActionBar>
            </StageShell>
          )}
          {activeStage === 'cost_estimation' && (
            <StageShell stageKey="cost" hasActionBar width="wide">
              <StageHeader
                eyebrow="Stage 04 · Approval"
                title="Cost estimation"
                description="Priced from your approved setup. Check the monthly total against your budget before generating infrastructure."
              />
              {!decisionCostBasedOnDecision ? (
                <Callout tone="warn" title="Estimate used safe defaults">
                  Decision stack_config was incomplete, so this price is a conservative fallback.
                </Callout>
              ) : null}
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
                <Panel className="xl:col-span-2" padded={false}>
                  <div className="flex items-end justify-between border-b border-[var(--dw-border)] px-5 py-4">
                    <div>
                      <div className="text-[13px] font-semibold text-[var(--dw-fg)]">Monthly breakdown</div>
                      <div className="mt-1 text-[12px] text-[var(--dw-muted)]">{decisionCostVariance}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--dw-faint)]">Subtotal</div>
                      <div className="mt-1 font-mono text-[26px] font-semibold tracking-tight text-[var(--dw-fg)]">
                        {decisionCostLoading ? (
                          <Skeleton className="ml-auto h-7 w-24" />
                        ) : (
                          <CountUp value={decisionCostSubtotal} prefix="$" />
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="p-5">
                    {decisionCostLoading ? (
                      <div className="space-y-2.5">
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-5/6" />
                      </div>
                    ) : decisionCostRows.length > 0 ? (
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr className="border-b border-[var(--dw-border)] text-left font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--dw-faint)]">
                            <th className="px-2 py-3 font-medium">Component</th>
                            <th className="px-2 py-3 font-medium">Hourly</th>
                            <th className="px-2 py-3 font-medium">Monthly</th>
                          </tr>
                        </thead>
                        <tbody>
                          {decisionCostRows.map((row) => (
                            <tr key={`${row.component}-${row.label}`} className="border-b border-[var(--dw-border)] last:border-0">
                              <td className="px-2 py-3 text-[var(--dw-fg-soft)]">{formatCostComponentLabel(row.component, row.label)}</td>
                              <td className="px-2 py-3 font-mono text-[var(--dw-muted)]">${Number(row.hourly_usd || 0).toFixed(4)}</td>
                              <td className="px-2 py-3 font-mono text-[var(--dw-fg)]">${Number(row.monthly_usd || 0).toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <EmptyState
                        title="No estimate yet"
                        description={decisionCostError || 'Cost estimation is not available yet.'}
                      />
                    )}
                  </div>
                </Panel>
                <div className="space-y-5">
                  <Panel
                    glow={Number(decisionCostEstimate?.subtotal_monthly_usd || costEstimate.total) > Number(currentInfraConsultant?.budget_cap_usd || costEstimate.cap)}
                  >
                    <SectionLabel>Budget fit</SectionLabel>
                    <KeyValueRow
                      label="Cap"
                      value={`$${Number(currentInfraConsultant?.budget_cap_usd || costEstimate.cap).toFixed(2)}`}
                    />
                    <KeyValueRow
                      label="Estimate"
                      value={<CountUp value={Number(decisionCostEstimate?.subtotal_monthly_usd || costEstimate.total)} prefix="$" />}
                    />
                    <p className="mt-3 text-[12px] leading-relaxed text-[var(--dw-muted)]">
                      {Number(decisionCostEstimate?.subtotal_monthly_usd || costEstimate.total) <= Number(currentInfraConsultant?.budget_cap_usd || costEstimate.cap)
                        ? 'This setup fits the approved budget.'
                        : `Over budget by $${Math.max(0, Number(decisionCostEstimate?.subtotal_monthly_usd || costEstimate.total) - Number(currentInfraConsultant?.budget_cap_usd || costEstimate.cap)).toFixed(2)}/mo.`}
                    </p>
                  </Panel>
                  <Panel>
                    <SectionLabel>Need a different setup?</SectionLabel>
                    <p className="mb-3 text-[12px] leading-relaxed text-[var(--dw-muted)]">
                      Go back to the advisor to change services, sizes, or budget, then re-approve before continuing.
                    </p>
                    <button
                      type="button"
                      onClick={unlockPlanningAnswers}
                      className={`${secondaryButtonClass(false)} w-full gap-2`}
                    >
                      <ArrowLeft className="h-4 w-4" />
                      Go back and make changes
                    </button>
                  </Panel>
                  <Panel>
                    <SectionLabel>Ready for infrastructure</SectionLabel>
                    <KeyValueRow label="Budget cap" value={`$${effectiveBudgetCap.toFixed(2)}`} />
                    <KeyValueRow label="Estimate total" value={`$${effectiveCostTotal.toFixed(2)}`} />
                    <p className="mt-3 text-[12px] text-[var(--dw-fg-soft)]">
                      {canContinueToTerraform
                        ? 'You can continue to generate Terraform from this estimate.'
                        : 'Continue from Planning first, then return here.'}
                    </p>
                  </Panel>
                </div>
              </div>
              <StickyActionBar hint={canContinueToTerraform ? 'Estimate accepted. Next: generate Terraform from this decision.' : 'Continue from Planning before generating infrastructure.'}>
                <button
                  type="button"
                  onClick={unlockPlanningAnswers}
                  className={`${secondaryButtonClass(false)} gap-2`}
                >
                  <ArrowLeft className="h-4 w-4" />
                  Make changes
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!lockDecisionForTerraform()) {
                      setError('Continue from Planning before generating infrastructure.');
                      return;
                    }
                    setAndPersistStage('terraform');
                  }}
                  disabled={!canContinueToTerraform}
                  className={primaryButtonClass(!canContinueToTerraform)}
                >
                  Continue to infrastructure
                  <ArrowRight className="h-4 w-4" />
                </button>
              </StickyActionBar>
            </StageShell>
          )}
          {activeStage === 'terraform' && (
            <StageShell stageKey="terraform" hasActionBar width="wide">
              <StageHeader
                eyebrow="Stage 05 · Terraform"
                title="Infrastructure generation"
                description="Deterministic Terraform generation from the locked planning profile."
                meta={
                  <>
                    <MetaChip label="files" value={String(iacFiles.length)} />
                    <MetaChip
                      label="ws"
                      value={deploySocketState}
                      tone={deploySocketState === 'connected' ? 'ok' : deploySocketState === 'error' ? 'warn' : 'neutral'}
                    />
                    <StatusPill tone={terraformGenerating ? 'info' : hasSuccessfulGeneration ? 'ok' : 'neutral'} live={terraformGenerating}>
                      {terraformGenerating ? 'Generating' : terraformRunLabel}
                    </StatusPill>
                  </>
                }
                actions={
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => {
                        resetCurrentIacSessionArtifacts();
                        void generateTerraform().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Infrastructure generation failed.'));
                      }}
                      disabled={terraformGenerating || !(approvedConsultantDecision || deploymentProfile)}
                      className={buttonClass('secondary', { disabled: terraformGenerating || !approvedConsultantDecision })}
                    >
                      {terraformGenerating ? 'Generating…' : 'Regenerate'}
                    </button>
                    <button
                      onClick={() => void createIacPr()}
                      disabled={terraformGenerating || iacPrCreating || deployableIacFiles.length === 0 || Boolean(iacPrUrl)}
                      className={buttonClass('secondary', { disabled: terraformGenerating || iacPrCreating || deployableIacFiles.length === 0 || Boolean(iacPrUrl) })}
                    >
                      {iacPrUrl ? 'PR ready' : iacPrCreating ? 'Creating PR…' : 'Create PR'}
                    </button>
                    {iacPrUrl ? (
                      <button
                        onClick={() => window.open(iacPrUrl, '_blank', 'noopener,noreferrer')}
                        className={buttonClass('ghost')}
                      >
                        <ExternalLink className="h-4 w-4" />
                        Open PR
                      </button>
                    ) : null}
                  </div>
                }
              />
              {!hasSuccessfulGeneration ? (
                <Callout tone="info">
                  This stage shows generation status and artifacts. Use Planning to refine the consultant decision.
                </Callout>
              ) : null}
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
                <div className="space-y-5">
                  <Panel glow={terraformGenerating}>
                    <SectionLabel>Generator</SectionLabel>
                    <div className="text-[16px] font-semibold text-[var(--dw-fg)]">{terraformRendererSummary.primary}</div>
                    <div className="mt-1 text-[13px] text-[var(--dw-muted)]">{terraformRendererSummary.secondary}</div>
                    <div className="mt-3">
                      <KeyValueRow label="Runtime" value={terraformRendererSummary.runtime} />
                      <KeyValueRow label="Status" value={terraformRunLabel} />
                      <KeyValueRow label="Run ID" value={shouldUseSavedRunForDeploy ? activeSavedRun?.run_id : (hasCurrentIacMeta ? 'bundle-only' : 'pending')} />
                      <KeyValueRow label="Workspace" value={(shouldUseSavedRunForDeploy ? activeSavedRun?.workspace : savedIacMeta?.workspace) || expectedWorkspace || 'pending'} />
                      <KeyValueRow label="Files" value={String(iacFiles.length)} />
                    </div>
                    {socketNotices.length > 0 ? (
                      <div className="mt-4 space-y-2">
                        <SectionLabel>Connection notices</SectionLabel>
                        {socketNotices.map((notice) => (
                          <Callout key={notice.key} tone={notice.tone === 'error' ? 'warn' : 'info'} title={notice.text}>
                            <span className="font-mono text-[11px]">{notice.ts}</span>
                          </Callout>
                        ))}
                      </div>
                    ) : null}
                    {sessionIacTruncated ? (
                      <Callout tone="warn" className="mt-4" title="Truncated preview">
                        Regenerate before creating a PR or deploying from session files.
                      </Callout>
                    ) : null}
                    {iacPrUrl ? (
                      <Callout tone="ok" className="mt-4">
                        Pull request creation is available and does not block AWS Config or deploy readiness.
                      </Callout>
                    ) : null}
                  </Panel>
                  <Panel>
                    <SectionLabel>Workers</SectionLabel>
                    <div className="space-y-2">
                      {terraformWorkerStates.length > 0 ? terraformWorkerStates.map((worker) => (
                        <div key={worker.worker_id} className={`flex items-center justify-between gap-3 ${paperInsetClass} px-3 py-2.5`}>
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-medium text-[var(--dw-fg)]">{worker.worker_role || worker.worker_id}</div>
                            <div className="font-mono text-[11px] text-[var(--dw-muted)]">{worker.worker_id}</div>
                          </div>
                          <StatusPill
                            tone={worker.worker_status === 'completed' ? 'ok' : worker.worker_status === 'failed' ? 'danger' : 'info'}
                            live={worker.worker_status !== 'completed' && worker.worker_status !== 'failed'}
                          >
                            {worker.worker_status || 'running'}
                          </StatusPill>
                        </div>
                      )) : (
                        <p className="text-[12.5px] text-[var(--dw-muted)]">Only workers whose latest activity is still in terraform generation appear here.</p>
                      )}
                    </div>
                  </Panel>
                  <Panel padded={false}>
                    <PanelHeader
                      title="Generation feed"
                      icon={<Terminal className="h-3.5 w-3.5" />}
                      tone="info"
                      actions={<span className="font-mono text-[10px] text-[var(--dw-faint)]">{terraformGenerationLogs.length} events</span>}
                    />
                    <div className="p-3">
                      <LogConsole
                        lines={terraformGenerationLogs.slice(-40).map((log) => ({
                          text: [log.worker_id, log.worker_status, log.text].filter(Boolean).join(' · '),
                          tone: log.type === 'error' ? 'danger' : log.type === 'success' ? 'ok' : 'neutral',
                        }))}
                        streaming={terraformGenerating}
                        emptyLabel={hasSuccessfulGeneration ? 'Generation already succeeded for this workspace. Regenerate to start a new attempt.' : 'The generation feed will populate as soon as live terraform-generation events arrive.'}
                        maxHeight="20rem"
                      />
                    </div>
                  </Panel>
                </div>
                <div className="flex min-w-0 gap-4 xl:col-span-2">
                  <Panel padded="sm" className="dw-scrollbar h-[32.5rem] w-72 min-w-0 shrink-0 overflow-y-auto overflow-x-hidden">
                    <SectionLabel>Files</SectionLabel>
                    {iacFiles.length === 0 ? (
                      <p className="px-1 text-[12px] text-[var(--dw-muted)]">Waiting for generated files…</p>
                    ) : (
                      iacFiles.map((file) => {
                        const { dir, name } = splitIacFilePath(file.path);
                        const selected = activeIacFilePath === file.path;
                        return (
                        <button
                          key={file.path}
                            type="button"
                            title={file.path}
                          onClick={() => setSelectedFile(file.path)}
                            className={`mb-1 block w-full min-w-0 rounded-none border-[3px] px-2.5 py-1.5 text-left font-mono text-[11.5px] leading-snug transition-colors ${
                              selected
                              ? 'border-black bg-black text-white'
                              : 'border-black bg-white text-black hover:bg-neutral-100'
                          }`}
                        >
                            <span className="block break-all font-medium">{name}</span>
                            {dir ? (
                              <span className={`mt-0.5 block break-all text-[10px] ${selected ? 'text-white/70' : 'text-neutral-500'}`}>
                                {dir}
                              </span>
                            ) : null}
                        </button>
                        );
                      })
                    )}
                  </Panel>
                  <div className="min-w-0 flex-1">
                    <CodeSurface
                      filename={activeIacFilePath || 'Generated files'}
                      language="hcl"
                      code={(iacFiles.find((file) => file.path === activeIacFilePath) || iacFiles[0])?.content || ''}
                      editable={Boolean(activeIacFilePath)}
                      onChange={(value) => {
                        if (!activeIacFilePath) return;
                        updateIacFileContent(activeIacFilePath, value);
                      }}
                      maxHeight="32.5rem"
                    />
                  </div>
                </div>
              </div>
              <StickyActionBar hint={hasSuccessfulGeneration ? 'Bundle ready. Continue to AWS credentials.' : 'Generate Terraform from the approved decision to continue.'}>
                <button
                  onClick={async () => {
                    if (!approvedConsultantDecision && !deploymentProfile) return;
                    if (!hasSuccessfulGeneration) {
                      const generated = await generateTerraform();
                      if (!generated) return;
                    }
                    setAndPersistStage('aws_config', { force: true });
                  }}
                  disabled={terraformGenerating || !(approvedConsultantDecision || deploymentProfile)}
                  className={primaryButtonClass(terraformGenerating || !(approvedConsultantDecision || deploymentProfile))}
                >
                  {terraformGenerating ? 'Generating…' : hasSuccessfulGeneration ? 'Continue to AWS config' : 'Generate & continue'}
                </button>
              </StickyActionBar>
            </StageShell>
          )}
          {activeStage === 'aws_config' && (
            <StageShell stageKey="aws_config" hasActionBar>
              <StageHeader
                eyebrow="Stage 05 · Credentials"
                title="AWS config"
                description="Credentials and Terraform runtime for deploy handoff. Temporary ASIA keys require a session token."
              />
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
                <Panel className="space-y-5 xl:col-span-2" elevation="raised">
                  <div className="space-y-3">
                    <label className="block">
                      <span className={fieldLabelClass()}>Access key</span>
                      <input name="aws_access_key_id" value={aws.aws_access_key_id} onChange={(event) => setAws((prev) => ({ ...prev, aws_access_key_id: event.target.value }))} placeholder="AKIA… or ASIA…" className={fieldClass()} autoComplete="off" />
                    </label>
                    <label className="block">
                      <span className={fieldLabelClass()}>Secret key</span>
                      <input name="aws_secret_access_key" type="password" value={aws.aws_secret_access_key} onChange={(event) => setAws((prev) => ({ ...prev, aws_secret_access_key: event.target.value }))} placeholder="AWS_SECRET_ACCESS_KEY" className={fieldClass()} autoComplete="off" />
                    </label>
                    <label className="block">
                      <span className={fieldLabelClass()}>
                        Session token {needsSessionToken ? '(required for ASIA)' : '(optional)'}
                      </span>
                      <input name="aws_session_token" type="password" value={aws.aws_session_token} onChange={(event) => setAws((prev) => ({ ...prev, aws_session_token: event.target.value }))} placeholder={needsSessionToken ? 'Required for temporary STS credentials' : 'Optional for long-lived AKIA credentials'} className={fieldClass()} autoComplete="off" />
                    </label>
                    <label className="block">
                      <span className={fieldLabelClass()}>Region</span>
                      <input name="aws_region" value={terraformRuntimeConfig.aws_region} onChange={(event) => setTerraformRuntimeConfig((prev) => ({ ...prev, aws_region: event.target.value }))} placeholder="eu-north-1" className={fieldClass()} />
                    </label>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span className={fieldLabelClass()}>State bucket</span>
                        <input name="state_bucket" value={terraformRuntimeConfig.state_bucket} onChange={(event) => setTerraformRuntimeConfig((prev) => ({ ...prev, state_bucket: event.target.value }))} placeholder="optional" className={fieldClass()} />
                      </label>
                      <label className="block">
                        <span className={fieldLabelClass()}>Lock table</span>
                        <input name="lock_table" value={terraformRuntimeConfig.lock_table} onChange={(event) => setTerraformRuntimeConfig((prev) => ({ ...prev, lock_table: event.target.value }))} placeholder="optional" className={fieldClass()} />
                      </label>
                    </div>
                  </div>
                  {hasAwsSecrets && !canContinueToAwsConfig && (
                    <Callout tone="warn">
                      Infrastructure generation is required before deploying. Complete the Terraform step first.
                    </Callout>
                  )}
                  {needsSessionToken && !aws.aws_session_token.trim() && (
                    <Callout tone="warn">
                      This access key starts with ASIA. Provide AWS_SESSION_TOKEN or STS GetCallerIdentity will fail.
                    </Callout>
                  )}
                  <Callout tone="info">
                    Operator AWS keys are kept in <span className="font-mono">sessionStorage</span> only
                    (never localStorage), expire after {needsSessionToken ? '1 hour' : '2 hours'}, and are wiped from this browser when the tab closes.
                  </Callout>
                </Panel>
                <div className="space-y-4">
                  <Panel>
                    <SectionLabel>Runtime inputs</SectionLabel>
                    <KeyValueRow label="Deploy source" value={shouldUseSavedRunForDeploy ? 'saved run' : 'session files'} />
                    <KeyValueRow label="Workspace" value={shouldUseSavedRunForDeploy ? (activeSavedRun?.workspace || expectedWorkspace || 'pending') : (expectedWorkspace || 'local session')} />
                    {customizationSnapshotId ? (
                      <KeyValueRow label="Customization snapshot" value={customizationSnapshotId} />
                    ) : null}
                    <KeyValueRow label="AWS region" value={terraformRuntimeConfig.aws_region || DEFAULT_AWS_REGION} />
                    <KeyValueRow label="Estimated monthly" value={`$${effectiveCostTotal.toFixed(2)}`} />
                    <KeyValueRow label="Budget cap" value={`$${effectiveBudgetCap.toFixed(2)}`} />
                  </Panel>
                  <Callout
                    tone={hasAwsSecrets && canContinueToAwsConfig ? 'ok' : hasAwsSecrets ? 'info' : 'warn'}
                    title={hasAwsSecrets && canContinueToAwsConfig ? 'Ready' : hasAwsSecrets ? 'Credentials saved' : 'Credentials required'}
                  >
                    {hasAwsSecrets && canContinueToAwsConfig
                      ? needsSessionToken
                        ? 'Temporary credentials ready with session token.'
                        : 'Long-lived credentials ready. Session token not required.'
                      : hasAwsSecrets
                        ? 'Complete infrastructure generation to unlock deploy.'
                        : 'Enter AWS access key and secret key to unlock deployment.'}
                  </Callout>
                  {sessionIacTruncated && !activeSavedRun && (
                    <Callout tone="warn">
                      Session-cached generation files are truncated preview data and cannot be deployed. Regenerate infrastructure to produce a fresh bundle.
                    </Callout>
                  )}
                </div>
              </div>
              <StickyActionBar hint={
                hasAwsSecrets && canContinueToAwsConfig
                  ? (deploymentPlan === 's3_cloudfront'
                    ? 'Credentials ready. Secrets are optional — continue to deploy, or add app secrets first.'
                    : 'Credentials ready. Add app secrets if the app needs them, or skip straight to deploy.')
                  : 'Enter valid AWS credentials and finish Terraform generation to continue.'
              }>
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
                  className={secondaryButtonClass(!hasAwsSecrets)}
                >
                  Clear credentials
                </button>
                <button
                  type="button"
                  onClick={() => setAndPersistStage('app_secrets')}
                  disabled={!hasAwsSecrets || !canContinueToAwsConfig}
                  className={secondaryButtonClass(!hasAwsSecrets || !canContinueToAwsConfig)}
                >
                  Add app secrets
                </button>
                <button
                  type="button"
                  onClick={() => setAndPersistStage('deploy')}
                  disabled={!hasAwsSecrets || !canContinueToAwsConfig}
                  className={accentButtonClass(!hasAwsSecrets || !canContinueToAwsConfig)}
                >
                  <Rocket className="h-4 w-4" />
                  Skip secrets · continue to deploy
                </button>
              </StickyActionBar>
            </StageShell>
          )}
          {activeStage === 'app_secrets' && selectedProject && (
            <StageShell stageKey="app_secrets" hasActionBar>
            <AppSecretsPanel
              projectId={selectedProject.id}
              projectName={selectedProject.name}
              aws={aws}
              awsRegion={terraformRuntimeConfig.aws_region || DEFAULT_AWS_REGION}
              secretsPrefix={secretsManagerPrefix}
              environment={String((deploymentProfile as { environment?: string } | null)?.environment || 'prod')}
              requiredKeys={requiredAppSecretKeys}
              optionalHintKeys={optionalAppSecretKeys}
              publicAppUrl={publicAppUrlForSecrets}
              oauthCallbackPaths={oauthCallbackPaths}
              hasAwsCredentials={hasAwsSecrets}
              initialMeta={appSecretsMeta}
              onMetaChange={setAppSecretsMeta}
              onContinueToDeploy={() => setAndPersistStage('deploy')}
              onBackToAwsConfig={() => setAndPersistStage('aws_config', { force: true })}
              canContinueToDeploy={canContinueToAwsConfig}
            />
            </StageShell>
          )}
          {activeStage === 'deploy' && (
            <StageShell stageKey="deploy">
              <StageHeader
                eyebrow="Stage 07 · Deploy"
                title={
                  deployIsLive
                    ? 'Deployment in progress'
                    : deployStatus === 'done'
                      ? 'Deployment complete'
                      : deployFailed
                        ? 'Deployment failed'
                        : deployUiPhase === 'awaiting_plan' || requiresPlanConfirmation
                          ? 'Confirm Terraform plan'
                          : 'Ready to deploy'
                }
                description={
                  deployIsLive
                    ? 'Backend is applying Terraform now. Live lines appear below even if WebSocket is still connecting.'
                    : awaitingPlanIdle
                      ? 'Terraform plan finished. Confirm to apply these changes in AWS.'
                      : deployFailed
                        ? 'Terraform apply stopped with an error. Redeploy retries against the existing state so already-created resources are reused.'
                        : 'Live console from pipeline WebSocket events.'
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
                      tone={deployIsLive ? 'warn' : deployFailed ? 'danger' : deployStatus === 'done' ? 'ok' : 'neutral'}
                    />
                  </div>
                )}
              />
              {!hasAwsSecrets && (
                <Callout tone="warn" title="AWS credentials missing">
                  Access key and secret were not saved for this session (they expire after 1–2 hours, and a full session cache can drop them). Go back to Stage 05 AWS config, paste the keys again, then start deploy.
                </Callout>
              )}
              {(deployIsLive || deployUiPhase === 'awaiting_plan' || error || backendErrorMessage) && (
                <Callout
                  tone={
                    deployFailed || error
                      ? 'danger'
                      : deployUiPhase === 'awaiting_plan' || requiresPlanConfirmation
                        ? 'warn'
                        : 'info'
                  }
                  title={deployPhaseLabel}
                  icon={deployIsLive ? <CircleDashed className="h-4 w-4 animate-spin" /> : undefined}
                  actions={
                    deployFailed ? (
                      <button
                        type="button"
                        onClick={() => void startDeploy()}
                        disabled={redeployDisabled}
                        className={`${buttonClass('primary', { size: 'sm', disabled: redeployDisabled })} gap-2`}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Redeploy
                      </button>
                    ) : null
                  }
                >
                  {(error || backendErrorMessage)
                    ? (error || backendErrorMessage)
                    : deployIsLive
                      ? 'Request accepted. Waiting on `/api/pipeline/deploy`. Multi-AZ RDS often takes 15–25 minutes (up to 45). Watch deployment.log for apply heartbeats.'
                      : 'Review the plan summary in the log, then click Confirm Plan & Deploy.'}
                </Callout>
              )}
              <div className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-3">
                <Panel className="flex h-125 flex-col overflow-hidden xl:col-span-2" padded={false} elevation="recessed" glow={deployIsLive}>
                  <PanelHeader
                    title="deployment.log"
                    icon={<Terminal className="h-3.5 w-3.5" />}
                    tone="info"
                    actions={<span className="font-mono text-[10px] text-[var(--dw-faint)]">{deployLogs.length} events</span>}
                  />
                  <div
                    ref={logPanelRef}
                    onScroll={() => {
                      const node = logPanelRef.current;
                      if (!node) return;
                      logStickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
                    }}
                    className="dw-scrollbar dw-no-scroll-anchor flex-1 overflow-y-auto p-4 font-mono text-[12px] leading-[1.7] [overflow-anchor:none]"
                  >
                    {deployLogs.length === 0 && (
                      <div className="flex h-full flex-col items-center justify-center gap-2 text-[12px] text-[var(--dw-faint)]">
                        <span>Waiting for deployment events…</span>
                        <span>Click Start Deploy — the first log line should appear immediately.</span>
                      </div>
                    )}
                    {socketNotices.map((notice) => (
                      <div key={notice.key} className={`mb-1 px-2 py-0.5 ${notice.tone === 'error' ? 'text-[var(--dw-danger)]' : 'text-[var(--dw-warn)]'}`}>
                        [ws] {notice.text}
                      </div>
                    ))}
                    {deployLogs.map((log, index) => (
                      <div key={`${log.ts}-${index}`} className={`mb-0.5 flex gap-3 rounded px-2 py-0.5 ${index % 2 === 0 ? 'bg-transparent' : 'bg-white/[0.02]'}`}>
                        <span className="mt-0.5 shrink-0 select-none text-[11px] text-[var(--dw-faint)]">{String(index + 1).padStart(2, '0')}</span>
                        <span className={`flex-1 ${
                          log.type === 'success' ? 'text-[var(--dw-ok)]'
                          : log.type === 'error' ? 'text-[var(--dw-danger)]'
                          : log.text.startsWith('✓') || log.text.includes('created') ? 'text-[var(--dw-ok)]'
                          : log.text.startsWith('+') || log.text.includes('Creating') ? 'text-[var(--dw-info)]'
                          : log.text.includes('Error') || log.text.includes('failed') ? 'text-[var(--dw-danger)]'
                          : log.text.startsWith('[') ? 'text-[var(--dw-warn)]'
                          : 'text-[var(--dw-fg-soft)]'
                        }`}>
                          {log.text}
                        </span>
                      </div>
                    ))}
                    {deployIsLive ? <span className="dw-caret ml-2 inline-block h-3.5 w-[7px] bg-[var(--dw-accent)]" /> : null}
                  </div>
                </Panel>
                <Panel className="space-y-4" elevation="raised" glow={deployIsLive}>
                  <div>
                    <SectionLabel>Execution</SectionLabel>
                    <div className="mt-1 font-mono text-[28px] font-semibold tracking-tight text-[var(--dw-fg)]">{deployProgress}%</div>
                    <ProgressBar
                      className="mt-2"
                      value={Math.max(deployProgress, deployIsLive ? 5 : 0)}
                      tone={deployStatus === 'done' ? 'ok' : deployFailed ? 'danger' : deployIsLive ? 'accent' : 'neutral'}
                      indeterminate={deployIsLive && deployProgress < 5}
                    />
                    <div className="mt-3 flex items-center gap-2 text-[12px] text-[var(--dw-muted)]">
                      <span>Status:</span>
                      <StatusPill
                        tone={deployStatus === 'done' ? 'ok' : deployFailed ? 'danger' : deployIsLive ? 'warn' : awaitingPlanIdle ? 'warn' : 'neutral'}
                        live={deployIsLive}
                      >
                        {deployIsLive ? 'running' : awaitingPlanIdle ? 'awaiting confirmation' : deployStatus}
                      </StatusPill>
                    </div>
                    <div className="mt-2 text-[12px] text-[var(--dw-muted)]">{deployPhaseLabel}</div>
                    {deployProgress >= 100 && deployStatus === 'running' && (
                      <Callout tone="info" className="mt-3">
                        The deterministic executor is building and verifying the release on EC2. Status updates appear here automatically.
                      </Callout>
                    )}
                  </div>
                  {!costEstimateIsFresh && hasApprovedDecisionForCost ? (
                    <Callout
                      tone="warn"
                      title="Refreshing cost estimate for the current setup…"
                      actions={
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
                          className={buttonClass('ghost', { size: 'sm', disabled: decisionCostLoading || !decisionForVisualization })}
                        >
                          {decisionCostLoading ? 'Refreshing…' : 'Refresh now'}
                        </button>
                      }
                    />
                  ) : null}
                  {effectiveCostTotal > effectiveBudgetCap && (
                    <Callout tone="warn" title="Budget guardrail">
                      <div>Estimated monthly cost ${effectiveCostTotal.toFixed(2)} exceeds cap ${effectiveBudgetCap.toFixed(2)}.</div>
                      <label className="mt-3 flex items-start gap-3 text-left">
                        <input
                          type="checkbox"
                          checked={budgetOverride}
                          onChange={(event) => setBudgetOverride(event.target.checked)}
                          disabled={deployStatus === 'running'}
                          className="mt-0.5 h-4 w-4 rounded border-[var(--dw-border)] bg-black accent-[var(--dw-accent)]"
                        />
                        <span>
                          <span className="block font-medium text-[var(--dw-warn)]">Override budget guardrail for this deploy</span>
                          <span className="mt-1 block text-[12px] text-[var(--dw-muted)]">Use only when you intentionally approve costs above the configured cap.</span>
                        </span>
                      </label>
                    </Callout>
                  )}
                  <div className="space-y-3">
                    <button
                      onClick={() => void startDeploy()}
                      disabled={deployButtonDisabled}
                      className={`${accentButtonClass(deployButtonDisabled)} w-full gap-2`}
                    >
                      {deployIsLive ? (
                        <CircleDashed className="h-4 w-4 animate-spin" />
                      ) : deployFailed ? (
                        <RefreshCw className="h-4 w-4" />
                      ) : (
                        <Rocket className="h-4 w-4" />
                      )}
                      {deployIsLive
                        ? `Deploying… ${deployElapsedSec}s`
                        : awaitingPlanIdle
                          ? 'Confirm plan & deploy'
                          : deployFailed
                            ? 'Redeploy'
                            : deployStatus === 'done'
                              ? 'Re-run deploy'
                              : 'Start deploy'}
                    </button>
                    {deployStartBlockers.length > 0 && !deployFailed && (
                      <Callout tone="warn">
                        <div className="space-y-1">
                          {deployStartBlockers.map((blocker) => (
                            <div key={blocker}>{blocker}</div>
                          ))}
                        </div>
                      </Callout>
                    )}
                    <button onClick={() => void stopDeployment()} disabled={!deployIsLive || stopLoading} className={`${buttonClass('danger', { disabled: !deployIsLive || stopLoading, block: true })}`}>
                      {stopLoading ? 'Stopping…' : 'Stop deployment'}
                    </button>
                    {!deployIsLive && deployResult && (
                      <button onClick={() => setAndPersistStage('outputs')} className={`${primaryButtonClass(false)} w-full`}>
                        {deployFailed ? 'View results' : 'View outputs'} <ArrowRight className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </Panel>
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
                  <div className="dw-no-scroll-anchor mt-6" style={{ overflowAnchor: 'none' }}>
                    <AwsConsoleTerminal 
                      instanceId={termInstanceId} 
                      publicIp={termPublicIp}
                      privateKey={termPrivateKey}
                      region={terraformRuntimeConfig.aws_region || DEFAULT_AWS_REGION} 
                      projectId={selectedProject?.id}
                      projectName={selectedProject?.name}
                      awsAccessKeyId={aws.aws_access_key_id}
                      awsSecretAccessKey={aws.aws_secret_access_key}
                      awsSessionToken={aws.aws_session_token}
                    />
                  </div>
                ) : null;
              })()}
              {selectedProject && deploySummary.instanceId && deploySummary.instanceId !== 'n/a' && (deployResult?.success || hasLiveRuntimeDetails) ? (
                <AppDeployPanel
                  projectId={selectedProject.id}
                  environmentId={String((deploymentProfile as { environment?: string } | null)?.environment || 'production')}
                  instanceId={deploySummary.instanceId}
                  region={terraformRuntimeConfig.aws_region || DEFAULT_AWS_REGION}
                  accountId={String((liveRuntimeDetails as { account_id?: string } | null)?.account_id || '')}
                  publicEndpoint={deploySummary.appUrl && deploySummary.appUrl !== 'n/a' ? deploySummary.appUrl : undefined}
                  defaultImage={appDeployDefaults.image}
                  defaultContainerPort={appDeployDefaults.containerPort}
                  defaultHostPort={appDeployDefaults.hostPort}
                  defaultHealthEndpoint={appDeployDefaults.healthEndpoint}
                  awsAccessKeyId={aws.aws_access_key_id}
                  awsSecretAccessKey={aws.aws_secret_access_key}
                  awsSessionToken={aws.aws_session_token}
                />
              ) : null}
            </StageShell>
          )}
          {activeStage === 'outputs' && (
            <StageShell stageKey="outputs">
              <StageHeader
                eyebrow="Stage 08 · Outputs"
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
                <Callout
                  tone="danger"
                  title="Deployment failed"
                  actions={
                    <button
                      type="button"
                      onClick={() => {
                        setAndPersistStage('deploy');
                        void startDeploy();
                      }}
                      disabled={redeployDisabled}
                      className={`${buttonClass('primary', { size: 'sm', disabled: redeployDisabled })} gap-2`}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Redeploy
                    </button>
                  }
                >
                  {backendErrorMessage}
                </Callout>
              )}
              {!backendErrorMessage && !hasLiveRuntimeDetails && deployResult?.success && deployResult.mode !== 'iac_pipeline' && (
                <Callout tone="warn">
                  Live runtime details are missing for this repo. Fetch the latest runtime details to hydrate outputs before treating this deploy as successful.
                </Callout>
              )}
              <InfraOutputsStage
                briefing={infraAccessBriefing}
                generatedPem={deploySummary.generatedPem || iacKeypair?.private_key_pem || null}
                databaseEnv={deploySummary.databaseEnv || null}
                keyPairMessage={keyPairDownloadMessage}
                oauthAppUrl={publicAppUrlForSecrets || infraAccessBriefing.appUrl}
                oauthCallbackPaths={oauthCallbackPaths}
                missingOauthSecrets={appSecretsMeta.some((row) => row.required && !row.is_set)}
                showOauthPanel={Boolean(
                  publicAppUrlForSecrets
                  || oauthCallbackPaths.length > 0
                  || optionalAppSecretKeys.some((key) => /GOOGLE|GITHUB|OAUTH|NEXTAUTH/i.test(key)),
                )}
                endpointChecks={effectiveEndpointChecks}
                canVerify={canVerifyLiveEndpoints}
                history={deploymentHistory}
                onDownloadPem={() => {
                  void downloadOneTimeCredentials(false).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Credential download failed.'));
                }}
                onDownloadPpk={() => {
                  void downloadOneTimeCredentials(true).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'PPK conversion failed.'));
                }}
                onDownloadDatabase={() => {
                  void downloadOneTimeCredentials(false).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Credential download failed.'));
                }}
                rawOutputs={iacResourceOutputs?.outputs || null}
                consoleSlot={(() => {
                  const termInstanceId = firstProvisioned(
                    deploySummary.instanceId,
                    iacResourceOutputs?.outputs?.find((entry) => entry.key === 'instance_id' || entry.key === 'ec2_instance_id')?.value,
                  );
                  const termPublicIp = firstProvisioned(
                    deploySummary.publicIp,
                    deploySummary.elasticIp,
                    iacResourceOutputs?.outputs?.find((entry) => entry.key === 'public_ip' || entry.key === 'elastic_ip')?.value,
                  ) || undefined;
                  const termPrivateKey = firstProvisioned(
                    deploySummary.generatedPem,
                    iacKeypair?.private_key_pem,
                    iacResourceOutputs?.outputs?.find((entry) => entry.key === 'private_key_pem')?.value,
                  ) || undefined;
                  return termInstanceId ? (
                  <AwsConsoleTerminal 
                    instanceId={termInstanceId} 
                    publicIp={termPublicIp}
                    privateKey={termPrivateKey}
                    region={terraformRuntimeConfig.aws_region || DEFAULT_AWS_REGION} 
                    projectId={selectedProject?.id}
                    projectName={selectedProject?.name}
                    awsAccessKeyId={aws.aws_access_key_id}
                    awsSecretAccessKey={aws.aws_secret_access_key}
                    awsSessionToken={aws.aws_session_token}
                  />
                ) : null;
              })()}
                actions={(
                  <>
                <button onClick={() => void fetchRuntimeDetails().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Failed to fetch runtime details.'))} disabled={!canFetchRuntimeDetails} className={buttonClass('secondary', { disabled: !canFetchRuntimeDetails })}>
                  <RefreshCw className="h-4 w-4" /> Fetch latest runtime details
                </button>
                <button onClick={() => void verifyLiveEndpoints()} disabled={verifyLoading || !canVerifyLiveEndpoints} className={buttonClass('secondary', { disabled: verifyLoading || !canVerifyLiveEndpoints })}>
                  <ExternalLink className="h-4 w-4" /> {verifyLoading ? 'Verifying…' : 'Verify live endpoints'}
                </button>
                {selectedProject && deployResult?.success ? (
                  <button
                    type="button"
                    onClick={() => router.push(`/dashboard/instances?projectId=${encodeURIComponent(selectedProject.id)}`)}
                    className={buttonClass('secondary')}
                  >
                    <Server className="h-4 w-4" /> Manage instance & IaC
                  </button>
                ) : null}
                <button onClick={() => void destroyDeployment().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Destroy failed.'))} disabled={destroyLoading || !hasAwsSecrets} className={buttonClass('danger', { disabled: destroyLoading || !hasAwsSecrets })}>
                  <Server className="h-4 w-4" /> {destroyLoading ? 'Destroying…' : 'Destroy infrastructure'}
                </button>
                  </>
                )}
              />
              {selectedProject && deploySummary.instanceId && deploySummary.instanceId !== 'n/a' && (deployResult?.success || hasLiveRuntimeDetails) ? (
                <AppDeployPanel
                  projectId={selectedProject.id}
                  environmentId={String((deploymentProfile as { environment?: string } | null)?.environment || 'production')}
                  instanceId={deploySummary.instanceId}
                  region={terraformRuntimeConfig.aws_region || DEFAULT_AWS_REGION}
                  accountId={String((liveRuntimeDetails as { account_id?: string } | null)?.account_id || '')}
                  publicEndpoint={deploySummary.appUrl && deploySummary.appUrl !== 'n/a' ? deploySummary.appUrl : undefined}
                  defaultImage={appDeployDefaults.image}
                  defaultContainerPort={appDeployDefaults.containerPort}
                  defaultHostPort={appDeployDefaults.hostPort}
                  defaultHealthEndpoint={appDeployDefaults.healthEndpoint}
                  awsAccessKeyId={aws.aws_access_key_id}
                  awsSecretAccessKey={aws.aws_secret_access_key}
                  awsSessionToken={aws.aws_session_token}
                />
              ) : null}
            </StageShell>
          )}
        </div>
      </div>
    </div>
  );
}



