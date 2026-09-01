import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { readLegacyCicdTemplate } from '@/lib/legacy-assets';
import { classifyUpstreamError } from '@/features/deployment/apply-status';
import {
  TERRAFORM_APPLY_ACCEPT_GRACE_MS,
  TERRAFORM_APPLY_POLL_INTERVAL_MS,
  terraformApplyNeedsPolling,
  waitForTerraformApplyResult,
} from '@/lib/terraform-apply-wait';
import {
  resolveCustomizationSnapshot,
  SnapshotResolutionError,
  type CustomizationSnapshotSource,
} from '@/lib/customization-snapshot';
import { denyUnlessPlanFeature } from '@/lib/billing/plan-access-guard';
import {
  resolveOrCreateSession,
  tryAppendSessionLogs,
} from '@/lib/sessions/store';
import type { SessionStatus } from '@/lib/sessions/types';

const AGENTIC_KEY = process.env.DEPLAI_SERVICE_KEY ?? '';

export const runtime = 'nodejs';
export const maxDuration = 3600;
export const dynamic = 'force-dynamic';

type Provider = 'aws' | 'azure' | 'gcp';

interface GeneratedFile {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
}

interface DeployBody {
  project_id: string;
  provider?: Provider;
  service_type?: string;
  repo_context?: Record<string, unknown>;
  user_customizations?: Record<string, unknown>;
  customizations?: Record<string, unknown>;
  github_pat?: string;
  runtime_apply?: boolean;
  run_id?: string;
  workspace?: string;
  state_bucket?: string;
  lock_table?: string;
  repo_name?: string;
  description?: string;
  is_private?: boolean;
  files?: GeneratedFile[];
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
  aws_region?: string;
  confirm_plan_summary?: boolean;
  database_required?: boolean;
  customer_database_url?: string;
  customer_host?: string;
  customer_port?: string;
  customer_database_name?: string;
  customer_username?: string;
  customer_password?: string;
  user_answers?: Record<string, unknown>;
  enforce_free_tier_ec2?: boolean;
  estimated_monthly_usd?: number;
  budget_limit_usd?: number;
  budget_override?: boolean;
  customization_snapshot_id?: string;
  tenant_id?: string;
  iac_source?: Record<string, unknown>;
  required_secret_keys?: string[];
  secrets_manager_prefix?: string;
  environment?: string;
  workspace_session_id?: string;
}

function resolveAgenticOrigin(): string {
  try {
    return new URL(AGENTIC_URL).origin;
  } catch {
    return AGENTIC_URL;
  }
}

function clampProvider(value: string | undefined): Provider {
  const v = (value || '').trim().toLowerCase();
  if (v === 'azure' || v === 'gcp') return v;
  return 'aws';
}

function sanitizeRepoName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '');
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

function applyTerraformSubdirFallback(content: string): string {
  const replacements: Array<{ from: RegExp; to: string }> = [
    {
      from: /run:\s*terraform init/g,
      to: `run: |
          if [ -d terraform ]; then
            terraform -chdir=terraform init
          else
            terraform init
          fi`,
    },
    {
      from: /run:\s*terraform plan -no-color/g,
      to: `run: |
          if [ -d terraform ]; then
            terraform -chdir=terraform plan -no-color
          else
            terraform plan -no-color
          fi`,
    },
    {
      from: /run:\s*terraform apply -auto-approve -no-color/g,
      to: `run: |
          if [ -d terraform ]; then
            terraform -chdir=terraform apply -auto-approve -no-color
          else
            terraform apply -auto-approve -no-color
          fi`,
    },
  ];

  let patched = content;
  for (const { from, to } of replacements) {
    patched = patched.replace(from, to);
  }
  return patched;
}

function ensureAnsibleLintJob(content: string): string {
  if (/\n\s*ansible:\s*\n/.test(content)) return content;
  return `${content.trimEnd()}

  ansible:
    name: Ansible Syntax Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install Ansible
        run: pip install ansible
      - name: Syntax check
        run: |
          if [ -f ansible/playbooks/security-hardening.yml ]; then
            ansible-playbook -i localhost, -c local ansible/playbooks/security-hardening.yml --syntax-check
          else
            echo "No Ansible playbook found, skipping."
          fi
`;
}

async function upsertRepoVariable(owner: string, repo: string, pat: string, name: string, value: string) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return;

  const updateRes = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`,
    pat,
    'PATCH',
    { name, value: trimmed },
  );

  if (updateRes.ok) return;
  if (updateRes.status !== 404) {
    const reason = String(updateRes.data?.message || 'unknown GitHub API error');
    throw new Error(`Failed to update variable "${name}" (${updateRes.status}): ${reason}`);
  }

  const createRes = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/variables`,
    pat,
    'POST',
    { name, value: trimmed },
  );

  if (createRes.ok) return;

  // Handle race: variable may have been created between PATCH and POST.
  if (createRes.status === 409) {
    const retryUpdateRes = await ghFetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`,
      pat,
      'PATCH',
      { name, value: trimmed },
    );
    if (retryUpdateRes.ok) return;
    const reason = String(retryUpdateRes.data?.message || 'unknown GitHub API error');
    throw new Error(`Failed to update variable "${name}" after conflict (${retryUpdateRes.status}): ${reason}`);
  }

  const reason = String(createRes.data?.message || 'unknown GitHub API error');
  throw new Error(`Failed to create variable "${name}" (${createRes.status}): ${reason}`);
}

async function ghFetch(url: string, pat: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'deplai-app/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  return {
    ok: res.ok,
    status: res.status,
    data: await res.json().catch(() => ({})) as Record<string, unknown>,
  };
}

function buildGeneratedWorkflowYaml(provider: Provider): string {
  const tfVersion = '1.9.0';

  const credentialSteps: Record<Provider, string> = {
    aws: `      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID || vars.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY || vars.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ vars.AWS_REGION || 'eu-north-1' }}`,
    azure: `      - name: Azure Login
        uses: azure/login@v2
        with:
          creds: \${{ secrets.AZURE_CREDENTIALS }}`,
    gcp: `      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          credentials_json: \${{ secrets.GCP_CREDENTIALS_JSON }}
      - name: Set up Cloud SDK
        uses: google-github-actions/setup-gcloud@v2`,
  };

  return `name: Deploy Terraform to ${provider.toUpperCase()}

on:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

jobs:
  terraform:
    name: Terraform
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash

    steps:
      - name: Checkout
        uses: actions/checkout@v4

${credentialSteps[provider]}

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: '${tfVersion}'

      - name: Terraform Init
        run: |
          if [ -d terraform ]; then
            terraform -chdir=terraform init
          else
            terraform init
          fi

      - name: Terraform Plan
        run: |
          if [ -d terraform ]; then
            terraform -chdir=terraform plan -no-color
          else
            terraform plan -no-color
          fi

      - name: Terraform Apply
        if: github.ref == 'refs/heads/main'
        run: |
          if [ -d terraform ]; then
            terraform -chdir=terraform apply -auto-approve -no-color
          else
            terraform apply -auto-approve -no-color
          fi

  ansible:
    name: Ansible Syntax Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install Ansible
        run: pip install ansible
      - name: Syntax check
        run: |
          if [ -f ansible/playbooks/security-hardening.yml ]; then
            ansible-playbook -i localhost, -c local ansible/playbooks/security-hardening.yml --syntax-check
          else
            echo "No Ansible playbook found, skipping."
          fi
`;
}

function buildWorkflowYaml(provider: Provider): { content: string; source: 'legacy_template' | 'generated' } {
  const tfVersion = '1.9.0';
  const awsRegion = 'eu-north-1';
  const legacy = readLegacyCicdTemplate(provider);
  if (legacy) {
    let content = legacy
      .replace(/##TF_VERSION##/g, tfVersion)
      .replace(/##AWS_REGION##/g, awsRegion);
    content = applyTerraformSubdirFallback(content);
    content = ensureAnsibleLintJob(content);
    return { content, source: 'legacy_template' };
  }
  return { content: buildGeneratedWorkflowYaml(provider), source: 'generated' };
}

function extractOutputString(outputs: Record<string, unknown> | null | undefined, candidates: string[]): string | null {
  if (!outputs || typeof outputs !== 'object') return null;

  for (const key of candidates) {
    const direct = outputs[key];
    if (typeof direct === 'string' && direct.trim()) return direct;
    if (direct && typeof direct === 'object' && 'value' in (direct as Record<string, unknown>)) {
      const nested = (direct as Record<string, unknown>).value;
      if (typeof nested === 'string' && nested.trim()) return nested;
    }
  }

  const normalized = Object.keys(outputs).reduce<Record<string, unknown>>((acc, key) => {
    acc[key.toLowerCase()] = outputs[key];
    return acc;
  }, {});

  for (const key of candidates.map((candidate) => candidate.toLowerCase())) {
    const candidateValue = normalized[key];
    if (typeof candidateValue === 'string' && candidateValue.trim()) return candidateValue;
    if (candidateValue && typeof candidateValue === 'object' && 'value' in (candidateValue as Record<string, unknown>)) {
      const nested = (candidateValue as Record<string, unknown>).value;
      if (typeof nested === 'string' && nested.trim()) return nested;
    }
  }

  return null;
}

function extractStringFromRecord(record: Record<string, unknown> | null | undefined, candidates: string[]): string | null {
  if (!record || typeof record !== 'object') return null;
  const direct = extractOutputString(record, candidates);
  if (direct) return direct;

  for (const value of Object.values(record)) {
    if (!value || typeof value !== 'object') continue;
    const nested = extractOutputString(value as Record<string, unknown>, candidates);
    if (nested) return nested;
  }
  return null;
}

function normalizeScalar(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildDeploymentSummary(params: {
  outputs: Record<string, unknown> | null | undefined;
  normalizedRuntime: ReturnType<typeof normalizeDeploymentRuntime>;
}): {
  status: 'deployed';
  resources: Record<string, string | null>;
  next_steps: string[];
} {
  const outputs = params.outputs || {};
  const cloudfrontDomain = extractOutputString(outputs, ['cloudfront_domain', 'cloudfront_domain_name']);
  const cloudfrontUrl = params.normalizedRuntime.cdn.cloudfront_url
    || extractOutputString(outputs, ['cloudfront_url'])
    || (cloudfrontDomain ? `https://${cloudfrontDomain}` : null);
  const albDns = params.normalizedRuntime.network.alb_dns_name
    || extractOutputString(outputs, ['alb_dns_name', 'alb_url']);
  const albUrl = params.normalizedRuntime.network.alb_url
    || (albDns
      ? (albDns.startsWith('http://') || albDns.startsWith('https://') ? albDns : `http://${albDns}`)
      : null);
  const elasticIp = params.normalizedRuntime.network.elastic_ip
    || extractOutputString(outputs, ['elastic_ip', 'eip_public_ip', 'eip']);
  const eipUrl = elasticIp
    ? (elasticIp.startsWith('http://') || elasticIp.startsWith('https://') ? elasticIp : `http://${elasticIp}`)
    : null;
  const ec2Url = params.normalizedRuntime.ec2.public_ip
    ? `http://${params.normalizedRuntime.ec2.public_ip}`
    : null;
  const appUrl = params.normalizedRuntime.cdn.app_url
    || cloudfrontUrl
    || albUrl
    || eipUrl
    || ec2Url
    || extractOutputString(outputs, ['app_url', 'application_url', 'site_url']);
  const rdsEndpoint = extractOutputString(outputs, ['rds_endpoint', 'postgres_endpoint', 'db_endpoint']);
  const vpcId = extractOutputString(outputs, ['vpc_id', 'ec2_vpc_id']) || params.normalizedRuntime.network.vpc_id;
  const ecsCluster = extractOutputString(outputs, ['ecs_cluster_name', 'ecs_cluster']);

  return {
    status: 'deployed',
    resources: {
      app_url: appUrl,
      alb_url: albUrl,
      alb_dns_name: albDns,
      elastic_ip: elasticIp,
      eip_public_ip: elasticIp,
      ec2_public_ip: params.normalizedRuntime.ec2.public_ip,
      cloudfront_url: cloudfrontUrl,
      rds_endpoint: rdsEndpoint,
      vpc_id: vpcId,
      ecs_cluster: ecsCluster,
    },
    next_steps: [
      'Point your domain DNS to the ALB URL',
      'Add your app environment variables to ECS task definition',
      'RDS is in private subnet - connect via bastion or VPN',
    ],
  };
}

function extractInstanceIdFromRuntimeDetails(runtimeDetails: Record<string, unknown> | null | undefined): string | null {
  if (!runtimeDetails || typeof runtimeDetails !== 'object') return null;
  const instance = runtimeDetails.instance;
  if (!instance || typeof instance !== 'object') return null;
  return normalizeScalar((instance as Record<string, unknown>).instance_id);
}

function isRecoverableEc2StateFailure(errorMessage: string): boolean {
  const lowered = String(errorMessage || '').toLowerCase();
  return (
    lowered.includes('no ec2 instance resource was found in state')
    || lowered.includes('deployment did not provision ec2')
  );
}

async function fetchAwsRuntimeDetails(params: {
  projectName: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken?: string;
  awsRegion: string;
  instanceId?: string | null;
}): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${AGENTIC_URL}/api/aws/runtime-details`, {
    method: 'POST',
    headers: {
      ...agenticHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      project_name: params.projectName,
      aws_access_key_id: params.awsAccessKeyId,
      aws_secret_access_key: params.awsSecretAccessKey,
      aws_session_token: params.awsSessionToken || undefined,
      aws_region: params.awsRegion,
      instance_id: params.instanceId || undefined,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const payload = await response.json().catch(() => ({})) as {
    success?: boolean;
    details?: Record<string, unknown>;
  };
  if (!response.ok || payload.success !== true || !payload.details) {
    return null;
  }
  return payload.details;
}

type AgenticApplyStatusPayload = {
  success?: boolean;
  status?: string;
  result?: Record<string, unknown> | null;
  error?: string;
};

async function fetchAgenticApplyStatus(params: {
  projectId: string;
  projectName: string;
}): Promise<AgenticApplyStatusPayload> {
  const response = await fetch(`${AGENTIC_URL}/api/terraform/apply/status`, {
    method: 'POST',
    headers: {
      ...agenticHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      project_id: params.projectId,
      project_name: params.projectName,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const payload = await response.json().catch(() => ({})) as AgenticApplyStatusPayload;
  if (!response.ok) {
    throw new Error(String(payload.error || `Agentic apply status failed with status ${response.status}`));
  }
  return payload;
}

async function waitForRecoveredApplyResult(params: {
  projectId: string;
  projectName: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<{ status: string; result: Record<string, unknown> | null; timedOut: boolean }> {
  return waitForTerraformApplyResult({
    timeoutMs: params.timeoutMs ?? TERRAFORM_APPLY_ACCEPT_GRACE_MS,
    intervalMs: params.intervalMs ?? TERRAFORM_APPLY_POLL_INTERVAL_MS,
    fetchStatus: async () => fetchAgenticApplyStatus({
      projectId: params.projectId,
      projectName: params.projectName,
    }),
  });
}

type EndpointCheck = {
  label: 'cloudfront' | 'alb' | 'instance' | 'app';
  url: string;
  ok: boolean;
  status: number | null;
  detail: string;
};

function ensureHttpUrl(raw: string | null | undefined): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  return `http://${value}`;
}

async function probeEndpoint(label: EndpointCheck['label'], rawUrl: string): Promise<EndpointCheck> {
  const url = String(rawUrl || '').trim();
  if (!url) {
    return { label, url: '', ok: false, status: null, detail: 'No endpoint provided.' };
  }
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    const text = await response.text().catch(() => '');
    return {
      label,
      url,
      ok: response.ok,
      status: response.status,
      detail: text.replace(/\s+/g, ' ').trim().slice(0, 160) || `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      label,
      url,
      ok: false,
      status: null,
      detail: error instanceof Error ? error.message : 'Request failed',
    };
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type BootstrapLifecycle = {
  terraform_status: 'succeeded' | 'failed' | 'unknown';
  application_status: 'succeeded' | 'failed' | 'running' | 'unknown';
  bootstrap_status: Record<string, unknown> | null;
  verification_status: 'passed' | 'failed' | 'pending' | 'unknown';
  bootstrap_ok: boolean;
};

async function waitForBootstrapApplicationStatus(params: {
  instanceId: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken?: string;
  awsRegion: string;
  timeoutMs?: number;
}): Promise<BootstrapLifecycle> {
  const instanceId = String(params.instanceId || '').trim();
  if (!instanceId) {
    return {
      terraform_status: 'succeeded',
      application_status: 'unknown',
      bootstrap_status: null,
      verification_status: 'unknown',
      bootstrap_ok: false,
    };
  }
  try {
    const response = await fetch(`${AGENTIC_URL}/api/deploy/bootstrap-status`, {
      method: 'POST',
      headers: { ...agenticHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instance_id: instanceId,
        aws_access_key_id: params.awsAccessKeyId,
        aws_secret_access_key: params.awsSecretAccessKey,
        aws_session_token: params.awsSessionToken || undefined,
        aws_region: params.awsRegion,
        wait: true,
        timeout_seconds: Math.max(60, Math.floor((params.timeoutMs || 900_000) / 1000)),
        interval_seconds: 15,
      }),
      signal: AbortSignal.timeout(Math.max(120_000, Number(params.timeoutMs || 900_000) + 30_000)),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      return {
        terraform_status: 'succeeded',
        application_status: 'unknown',
        bootstrap_status: null,
        verification_status: 'pending',
        bootstrap_ok: false,
      };
    }
    const applicationStatus = String(payload.application_status || 'unknown').toLowerCase();
    const bootstrapStatus = (
      payload.bootstrap_status
      && typeof payload.bootstrap_status === 'object'
      && !Array.isArray(payload.bootstrap_status)
    ) ? payload.bootstrap_status as Record<string, unknown> : null;
    const bootstrapOk = payload.success === true;
    return {
      terraform_status: 'succeeded',
      application_status: applicationStatus === 'succeeded'
        ? 'succeeded'
        : applicationStatus === 'failed'
          ? 'failed'
          : applicationStatus === 'running'
            ? 'running'
            : 'unknown',
      bootstrap_status: bootstrapStatus,
      verification_status: bootstrapOk ? 'passed' : (applicationStatus === 'failed' ? 'failed' : 'pending'),
      bootstrap_ok: bootstrapOk,
    };
  } catch {
    return {
      terraform_status: 'succeeded',
      application_status: 'unknown',
      bootstrap_status: null,
      verification_status: 'pending',
      bootstrap_ok: false,
    };
  }
}

async function waitForRuntimeVerification(params: {
  cloudfrontUrl?: string | null;
  albUrl?: string | null;
  appUrl?: string | null;
  healthCheckUrl?: string | null;
  publicIp?: string | null;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<{ checks: EndpointCheck[]; verified: boolean }> {
  const timeoutMs = Math.max(15_000, Number(params.timeoutMs || 180_000));
  const intervalMs = Math.max(5_000, Number(params.intervalMs || 10_000));
  const startedAt = Date.now();
  let checks: EndpointCheck[] = [];

  const cloudfrontUrl = ensureHttpUrl(params.cloudfrontUrl);
  const albUrl = ensureHttpUrl(params.albUrl);
  const appUrl = ensureHttpUrl(params.appUrl || params.healthCheckUrl);
  const instanceUrl = params.publicIp ? ensureHttpUrl(params.publicIp) : '';

  while (Date.now() - startedAt < timeoutMs) {
    const probes: Array<Promise<EndpointCheck>> = [];
    if (cloudfrontUrl) probes.push(probeEndpoint('cloudfront', cloudfrontUrl));
    if (albUrl) probes.push(probeEndpoint('alb', albUrl));
    if (appUrl && appUrl !== cloudfrontUrl && appUrl !== albUrl && appUrl !== instanceUrl) {
      probes.push(probeEndpoint('app', appUrl));
    }
    if (instanceUrl) probes.push(probeEndpoint('instance', instanceUrl));

    checks = probes.length > 0
      ? await Promise.all(probes)
      : [];

    // Succeed when any intended front door (CF, ALB, or instance) is healthy.
    if (checks.some((check) => check.ok && (check.label === 'cloudfront' || check.label === 'alb' || check.label === 'instance' || check.label === 'app'))) {
      return { checks, verified: true };
    }
    await sleep(intervalMs);
  }

  return { checks, verified: false };
}

function normalizeDeploymentRuntime(payload: {
  cloudfrontUrl?: string | null;
  outputs?: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
  runtimeDetails?: Record<string, unknown> | null;
  oneTimeCredentials?: Record<string, unknown> | null;
}): {
  keypair: Record<string, string | null>;
  ec2: Record<string, string | null>;
  network: Record<string, string | null>;
  cdn: Record<string, string | null>;
} {
  const outputs = payload.outputs || {};
  const details = payload.details || {};
  const runtime = payload.runtimeDetails || {};
  const oneTime = payload.oneTimeCredentials || {};
  const liveInstance = (runtime.instance && typeof runtime.instance === 'object')
    ? runtime.instance as Record<string, unknown>
    : null;

  const keyName = extractStringFromRecord(
    {
      ...outputs,
      ...details,
      ...oneTime,
    },
    ['ec2_key_name', 'generated_ec2_key_name', 'key_name'],
  );
  const privateKeyPem = extractStringFromRecord(
    {
      ...oneTime,
      ...outputs,
      ...details,
    },
    ['private_key_pem', 'generated_ec2_private_key_pem', 'generated_private_key_pem', 'ec2_private_key_pem'],
  );
  const cloudfrontUrlRaw = normalizeScalar(payload.cloudfrontUrl)
    || extractOutputString(outputs, ['cloudfront_url'])
    || extractOutputString(outputs, ['cloudfront_domain_name']);
  const cloudfrontUrl = cloudfrontUrlRaw
    ? (cloudfrontUrlRaw.startsWith('http') ? cloudfrontUrlRaw : `https://${cloudfrontUrlRaw}`)
    : null;

  const albDns = extractOutputString(outputs, ['alb_dns_name', 'alb_dns', 'load_balancer_dns'])
    || extractStringFromRecord(details, ['alb_dns_name', 'alb_dns']);
  const albUrlRaw = extractOutputString(outputs, ['alb_url'])
    || albDns;
  const albUrl = albUrlRaw
    ? (albUrlRaw.startsWith('http://') || albUrlRaw.startsWith('https://') ? albUrlRaw : `http://${albUrlRaw}`)
    : null;

  const elasticIp = extractOutputString(outputs, ['elastic_ip', 'eip_public_ip', 'eip', 'elastic_ip_public'])
    || extractStringFromRecord(details, ['elastic_ip', 'eip_public_ip']);

  const ec2PublicIp = normalizeScalar(liveInstance?.public_ipv4_address)
    || extractOutputString(outputs, ['ec2_public_ip', 'public_ip', 'instance_public_ip']);

  const preferredAppUrl = cloudfrontUrl
    || albUrl
    || (elasticIp ? (elasticIp.startsWith('http') ? elasticIp : `http://${elasticIp}`) : null)
    || (ec2PublicIp ? `http://${ec2PublicIp}` : null)
    || extractOutputString(outputs, ['app_url', 'application_url', 'site_url']);

  return {
    keypair: {
      key_name: keyName,
      private_key_pem: privateKeyPem,
    },
    ec2: {
      instance_id: normalizeScalar(liveInstance?.instance_id) || extractOutputString(outputs, ['ec2_instance_id', 'instance_id']),
      state: normalizeScalar(liveInstance?.instance_state) || extractOutputString(outputs, ['ec2_instance_state', 'instance_state']),
      type: normalizeScalar(liveInstance?.instance_type) || extractOutputString(outputs, ['ec2_instance_type', 'instance_type']),
      public_ip: ec2PublicIp,
      private_ip: normalizeScalar(liveInstance?.private_ipv4_address) || extractOutputString(outputs, ['ec2_private_ip', 'private_ip', 'instance_private_ip']),
      public_dns: normalizeScalar(liveInstance?.public_dns) || extractOutputString(outputs, ['ec2_public_dns', 'instance_public_dns', 'public_dns']),
      private_dns: normalizeScalar(liveInstance?.private_dns) || extractOutputString(outputs, ['ec2_private_dns', 'private_dns', 'instance_private_dns']),
      instance_arn: normalizeScalar(liveInstance?.instance_arn) || extractOutputString(outputs, ['ec2_instance_arn', 'instance_arn']),
    },
    network: {
      vpc_id: normalizeScalar(liveInstance?.vpc_id) || extractOutputString(outputs, ['ec2_vpc_id', 'vpc_id']),
      subnet_id: normalizeScalar(liveInstance?.subnet_id) || extractOutputString(outputs, ['ec2_subnet_id', 'subnet_id']),
      alb_dns_name: albDns,
      alb_url: albUrl,
      elastic_ip: elasticIp,
      eip_public_ip: elasticIp,
    },
    cdn: {
      cloudfront_url: cloudfrontUrl,
      app_url: preferredAppUrl,
    },
  };
}

function filesTextBySuffix(files: GeneratedFile[], suffix: string): string {
  const needle = suffix.toLowerCase();
  return files
    .filter((file) => normalizePath(String(file.path || '')).toLowerCase().endsWith(needle))
    .map((file) => String(file.content || ''))
    .join('\n');
}

function containsAwsInstanceResource(files: GeneratedFile[]): boolean {
  const tfvars = filesTextBySuffix(files, '.tfvars');
  if (/^\s*compute_strategy\s*=\s*"(s3_cloudfront|cloudfront|s3cloudfront|static_site)"\s*$/im.test(tfvars)) {
    return false;
  }
  const enableEc2False = /^\s*enable_ec2\s*=\s*false\s*$/im.test(tfvars);
  const enableEc2True = /^\s*enable_ec2\s*=\s*true\s*$/im.test(tfvars);
  if (enableEc2False && !enableEc2True) return false;

  return files.some((file) => {
    const path = normalizePath(String(file.path || '')).toLowerCase();
    if (!path.endsWith('.tf')) return false;
    const content = String(file.content || '');
    return /resource\s+"aws_instance"\s+"[^"]+"/i.test(content)
      || /terraform-aws-modules\/ec2-instance\/aws/i.test(content)
      || /module\s+"(ec2|compute)"\s*\{/i.test(content);
  });
}

function liveDatabaseEndpoints(outputs: Record<string, unknown> | null | undefined): boolean {
  return Boolean(
    extractOutputString(outputs, ['rds_endpoint', 'rds_address', 'db_endpoint', 'postgres_endpoint'])
    || extractOutputString(outputs, ['redis_endpoint', 'elasticache_endpoint', 'cache_endpoint']),
  );
}

function detectStaleAwsTerraformBundle(files: GeneratedFile[]): string[] {
  const tfFiles = files
    .filter((file) => normalizePath(String(file.path || '')).toLowerCase().endsWith('.tf'))
    .map((file) => String(file.content || ''));
  if (tfFiles.length === 0) return ['No Terraform .tf files were provided in deploy payload.'];

  const combined = tfFiles.join('\n');
  const reasons: string[] = [];

  const hasUseDefaultVpcVar = /variable\s+"use_default_vpc"\s*\{/i.test(combined);
  const hasUseExistingVpcVar = /variable\s+"use_existing_vpc"\s*\{/i.test(combined);
  const hasUseRegistryVpcVar = /variable\s+"use_registry_vpc"\s*\{/i.test(combined);
  const hasLegacyVpcCreate = /resource\s+"aws_vpc"\s+"main"\s*\{/i.test(combined);
  // Enterprise / EC2 / ECS renderers use several equivalent count forms, e.g.
  //   count = var.use_default_vpc ? 0 : 1
  //   count = var.use_existing_vpc ? 0 : 1
  //   count = var.use_existing_vpc || var.use_registry_vpc ? 0 : 1
  const vpcMainBlockMatch = combined.match(/resource\s+"aws_vpc"\s+"main"\s*\{([\s\S]*?)\n\}/i);
  const vpcMainBody = vpcMainBlockMatch?.[1] || '';
  const hasVpcConditionalCount = /count\s*=\s*[^\n]*var\.(use_default_vpc|use_existing_vpc|use_registry_vpc)/i.test(vpcMainBody);
  const hasSupportedVpcModeVar = hasUseDefaultVpcVar || hasUseExistingVpcVar || hasUseRegistryVpcVar;
  if (hasLegacyVpcCreate && !(hasSupportedVpcModeVar && hasVpcConditionalCount)) {
    reasons.push('Terraform bundle still creates aws_vpc.main without default-VPC conditional mode.');
  }

  const hasLegacyOacName = /resource\s+"aws_cloudfront_origin_access_control"\s+"oac"\s*\{[\s\S]*?name\s*=\s*"\$\{var\.project_name\}-oac"/i.test(combined);
  if (hasLegacyOacName) {
    reasons.push('CloudFront OAC name is static and may collide on reruns.');
  }

  return reasons;
}

// Suffixes produced by the architecture consultant that the Terraform Agent template
// registry does not accept — strip them to get the canonical service_type token.
const SERVICE_TYPE_SUFFIXES = [
  '-instance', '-cluster', '-function', '-bucket',
  '-database', '-cache', '-balancer', '-gateway',
] as const;

function normalizeServiceType(raw: string): string {
  const lower = raw.trim().toLowerCase();
  const stripped = SERVICE_TYPE_SUFFIXES.reduce(
    (s, suffix) => s.endsWith(suffix) ? s.slice(0, -suffix.length) : s,
    lower,
  );
  return stripped || 'ec2';
}

async function fetchFileSha(owner: string, repo: string, filePath: string, pat: string): Promise<string | null> {
  const readRes = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    pat,
    'GET',
  );
  if (!readRes.ok) return null;
  const sha = readRes.data.sha;
  return typeof sha === 'string' ? sha : null;
}

export async function POST(req: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    let body: DeployBody;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const projectId = String(body.project_id || '').trim();
    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    const owned = await verifyProjectOwnership(user.id, projectId, 'deployment.create');
    if ('error' in owned) return owned.error;

    if (body.runtime_apply === true) {
      const denied = await denyUnlessPlanFeature(req, user, 'deploy');
      if (denied) return denied;
    }

    const provider = clampProvider(body.provider);
    const projectName = String(owned.project?.name || owned.project?.full_name || projectId).split('/').pop() || projectId;
    const incomingSessionId = String(body.workspace_session_id || '').trim();
    const bindDeploySession = async (
      payload: Record<string, unknown>,
      status: SessionStatus,
      stage: string,
      message?: string,
    ) => {
      try {
        const session = await resolveOrCreateSession(incomingSessionId, {
          userId: user.id,
          projectId,
          service: 'deploy',
          title: `Deploy · ${projectName}`,
          repo: projectName,
          status,
          currentStage: stage,
          triggeredBy: user.id,
          externalId: typeof payload.run_id === 'string' ? payload.run_id : null,
          metadata: { run_id: payload.run_id || null, mode: payload.mode || null },
        });
        if (session && message) {
          await tryAppendSessionLogs(session.id, [{
            level: status === 'failed' ? 'error' : 'info',
            message,
            stage,
          }]);
        }
        return { ...payload, workspace_session_id: session?.id ?? (incomingSessionId || null) };
      } catch (sessionError) {
        console.error('[sessions] deploy hook failed', sessionError);
        return { ...payload, workspace_session_id: incomingSessionId || null };
      }
    };
    const customizationSnapshotId = String(body.customization_snapshot_id || '').trim();
    const tenantId = String(body.tenant_id || '').trim();
    if (Boolean(customizationSnapshotId) !== Boolean(tenantId)) {
      return NextResponse.json(
        { error: 'customization_snapshot_id and tenant_id must be provided together' },
        { status: 400 },
      );
    }
    let snapshotSource: CustomizationSnapshotSource | null = null;
    if (customizationSnapshotId && tenantId) {
      try {
        snapshotSource = await resolveCustomizationSnapshot({
          userId: String(user.id),
          projectId,
          tenantId,
          snapshotId: customizationSnapshotId,
        });
      } catch (snapshotError) {
        const status = snapshotError instanceof SnapshotResolutionError ? snapshotError.status : 502;
        return NextResponse.json(
          { error: snapshotError instanceof Error ? snapshotError.message : 'Snapshot validation failed.' },
          { status },
        );
      }
      const iacSource = body.iac_source || {};
      if (
        String(iacSource.kind || '') !== 'customization_snapshot'
        || String(iacSource.snapshot_id || '') !== snapshotSource.snapshot_id
        || String(iacSource.tenant_id || '') !== snapshotSource.tenant_id
        || String(iacSource.source_tree_hash || '') !== snapshotSource.source_tree_hash
      ) {
        return NextResponse.json(
          { error: 'Generated IaC source metadata does not match the validated customization snapshot. Regenerate Stage 8.' },
          { status: 409 },
        );
      }
    }
    const customizationSource = snapshotSource
      ? {
          kind: snapshotSource.kind,
          project_id: snapshotSource.project_id,
          tenant_id: snapshotSource.tenant_id,
          snapshot_id: snapshotSource.snapshot_id,
          snapshot_path: snapshotSource.snapshot_path,
          agentic_source_root: snapshotSource.agentic_source_root,
          source_tree_hash: snapshotSource.source_tree_hash,
          created_at: snapshotSource.created_at,
          status: snapshotSource.status,
        }
      : null;
    const estimatedMonthlyUsd = Number(body.estimated_monthly_usd);
    const budgetLimitUsd = Number(body.budget_limit_usd);
    if (
      body.budget_override !== true &&
      Number.isFinite(estimatedMonthlyUsd) &&
      Number.isFinite(budgetLimitUsd) &&
      estimatedMonthlyUsd > budgetLimitUsd
    ) {
      return NextResponse.json(
        {
          error: `Deployment blocked by budget guardrail: estimated monthly cost $${estimatedMonthlyUsd.toFixed(2)} exceeds limit $${budgetLimitUsd.toFixed(2)}.`,
          blocked: true,
          budget_limit_usd: budgetLimitUsd,
          estimated_monthly_usd: estimatedMonthlyUsd,
        },
        { status: 422 },
      );
    }

    const runtimeMode = body.runtime_apply === true;
    if (provider === 'aws' && !runtimeMode) {
      let agenticRes: Response;
      try {
        agenticRes = await fetch(`${AGENTIC_URL}/api/iac/generate-and-apply`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': AGENTIC_KEY,
          },
          body: JSON.stringify({
            project_id: projectId,
            service_type: body.service_type,
            repo_context: { ...((body.repo_context as Record<string, unknown>) ?? {}), project_name: projectName },
            user_customizations: {
              ...(body.customizations ?? body.user_customizations ?? {}),
              ...(customizationSource ? { customization_source: customizationSource } : {}),
            },
            aws_credentials: {
              access_key_id: body.aws_access_key_id,
              secret_access_key: body.aws_secret_access_key,
              region: body.aws_region ?? 'us-east-1',
            },
          }),
        });
      } catch (err) {
        return NextResponse.json(
          { error: 'Agentic Layer unreachable', detail: String(err) },
          { status: 502 },
        );
      }

      if (!agenticRes.ok) {
        const detail = await agenticRes.text();
        return NextResponse.json(
          { error: 'IaC pipeline failed to start', detail },
          { status: agenticRes.status },
        );
      }

      const { run_id, status } = await agenticRes.json();
      return NextResponse.json(await bindDeploySession({
        success: true,
        mode: 'iac_pipeline',
        provider: 'aws',
        run_id,
        service_type: normalizeServiceType(String(body.service_type || 'ec2')),
        status,
      }, 'running', 'pipeline', 'IaC pipeline started.'));
    }

    const runId = String(body.run_id || '').trim();
    const workspace = String(body.workspace || '').trim();
    const baseFiles = Array.isArray(body.files) ? body.files : [];
    const useRunReference = runtimeMode && Boolean(runId && workspace);
    if (snapshotSource && !useRunReference) {
      return NextResponse.json(
        { error: 'Snapshot deployments require the validated saved Terraform run from Stage 8. Regenerate infrastructure and retry.' },
        { status: 409 },
      );
    }
    if (baseFiles.length === 0 && !useRunReference) {
      return NextResponse.json(
        { error: 'No generated IaC files provided. Generate Terraform/Ansible first.' },
        { status: 400 },
      );
    }
    const MAX_FILES = runtimeMode ? 3000 : 120;
    const MAX_FILE_BYTES = runtimeMode ? 12_000_000 : 700_000;
    const MAX_TOTAL_BYTES = runtimeMode ? 35_000_000 : 8_000_000;

    if (baseFiles.length > MAX_FILES) {
      return NextResponse.json({ error: `Too many files - limit is ${MAX_FILES}` }, { status: 400 });
    }
    const baseTotalBytes = baseFiles.reduce((sum, f) => sum + (f.content?.length ?? 0), 0);
    if (baseTotalBytes > MAX_TOTAL_BYTES) {
      return NextResponse.json(
        { error: `Total file content exceeds ${(MAX_TOTAL_BYTES / 1_000_000).toFixed(1)} MB limit` },
        { status: 400 },
      );
    }
    for (const f of baseFiles) {
      if ((f.content?.length ?? 0) > MAX_FILE_BYTES) {
        return NextResponse.json(
          { error: `File "${f.path}" exceeds ${(MAX_FILE_BYTES / 1_000_000).toFixed(1)} MB limit` },
          { status: 400 },
        );
      }
    }

    if (body.runtime_apply === true) {
      if ((provider as string) !== 'aws') {
        return NextResponse.json(
          { error: 'runtime_apply currently supports AWS only.' },
          { status: 400 },
        );
      }

      const staleReasons = useRunReference ? [] : detectStaleAwsTerraformBundle(baseFiles);
      const staleBundleWarning = staleReasons.length > 0
        ? {
          message: 'Provided Terraform bundle appears outdated for current AWS runtime safety constraints.',
          reasons: staleReasons,
          recommended_actions: [
            'Re-run Stage 8 (Generate terraform + ansible) to refresh files.',
            'Ensure generated Terraform includes variable "use_default_vpc" and unique CloudFront OAC naming.',
            'Retry deploy after refreshed bundle is loaded in UI state.',
          ],
        }
        : null;
      if (staleReasons.length > 0) {
        console.warn('Runtime deploy blocked: stale Terraform bundle:', {
          project_id: projectId,
          reasons: staleReasons,
        });
        return NextResponse.json(
          {
            success: false,
            error: [
              'Terraform bundle is outdated for current AWS runtime safety constraints.',
              ...staleReasons,
              'Regenerate Infrastructure (Stage 8), then click Start Deploy again.',
            ].join(' '),
            stale_bundle_warning: staleBundleWarning,
            recommended_actions: staleBundleWarning?.recommended_actions || [],
          },
          { status: 409 },
        );
      }

      const awsAccessKeyId = String(body.aws_access_key_id || '').trim();
      const awsSecretAccessKey = String(body.aws_secret_access_key || '').trim();
      const awsSessionToken = String(body.aws_session_token || '').trim();
      const answerRegion = Array.isArray(body.user_answers?.regions)
        ? String(body.user_answers?.regions?.[0] || '').trim()
        : '';
      const awsRegion = String(body.aws_region || answerRegion || 'eu-north-1').trim() || 'eu-north-1';
      const enforceFreeTierEc2 = body.enforce_free_tier_ec2 !== false;
      if (!awsAccessKeyId || !awsSecretAccessKey) {
        return NextResponse.json(
          {
            error: 'AWS credentials are required before runtime deployment can start.',
            requires_credentials: true,
            missing: [
              ...(!awsAccessKeyId ? ['AWS_ACCESS_KEY_ID'] : []),
              ...(!awsSecretAccessKey ? ['AWS_SECRET_ACCESS_KEY'] : []),
            ],
          },
          { status: 400 },
        );
      }

      const applyRequest = {
        project_id: projectId,
        project_name: projectName,
        provider,
        run_id: useRunReference ? runId || undefined : undefined,
        workspace: useRunReference ? workspace || undefined : undefined,
        state_bucket: String(body.state_bucket || '').trim() || undefined,
        lock_table: String(body.lock_table || '').trim() || undefined,
        files: useRunReference ? [] : baseFiles,
        aws_access_key_id: awsAccessKeyId,
        aws_secret_access_key: awsSecretAccessKey,
        aws_session_token: awsSessionToken,
        aws_region: awsRegion,
        enforce_free_tier_ec2: enforceFreeTierEc2,
        confirm_plan_summary: body.confirm_plan_summary === true,
        database_required: body.database_required === true,
        customer_database_url: String(body.customer_database_url || '').trim() || undefined,
        customer_host: String(body.customer_host || '').trim() || undefined,
        customer_port: String(body.customer_port || '').trim() || undefined,
        customer_database_name: String(body.customer_database_name || '').trim() || undefined,
        customer_username: String(body.customer_username || '').trim() || undefined,
        customer_password: String(body.customer_password || '').trim() || undefined,
        deployment_metadata: {
          user_customizations: {
            ...(body.user_customizations || {}),
            ...(customizationSource ? { customization_source: customizationSource } : {}),
          },
          customization_source: customizationSource,
        },
      };
      let agenticRes: Response | null = null;
      let applyTransportRecovered = false;
      let startErr: unknown = null;
      try {
        agenticRes = await fetch(`${AGENTIC_URL}/api/terraform/apply`, {
          method: 'POST',
          headers: { ...agenticHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(applyRequest),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (upstreamErr) {
        startErr = upstreamErr;
      }

      let applyData: Record<string, unknown> = {};
      if (agenticRes) {
        const applyRaw = await agenticRes.text();
        if (applyRaw.trim()) {
          try {
            applyData = JSON.parse(applyRaw) as Record<string, unknown>;
          } catch {
            applyData = { raw_response_tail: applyRaw.slice(-2000) };
          }
        }
      }

      const shouldPollApply = Boolean(startErr) || terraformApplyNeedsPolling(applyData);
      if (shouldPollApply) {
        const waited = await waitForRecoveredApplyResult({
          projectId,
          projectName,
        });
        const recoveredTerminal = !waited.timedOut
          && Boolean(waited.result)
          && !terraformApplyNeedsPolling({ status: waited.status });
        if (recoveredTerminal && waited.result) {
          applyData = waited.result;
          applyTransportRecovered = true;
        } else if (terraformApplyNeedsPolling({ status: waited.status }) || waited.status === 'running') {
          return NextResponse.json(
            {
              error: 'Terraform apply is still running. Multi-AZ RDS often takes 15–25 minutes (up to 45). Do not start another deploy — watch the apply log and the AWS console.',
              status: 'running',
              details: {
                hint: 'The runtime accepted the apply. Leave this deploy alone until Terraform finishes. Retrying now can fight the in-progress RDS create.',
                apply_still_running: true,
                last_apply_status: waited.status,
                agentic_origin: resolveAgenticOrigin(),
                ...(startErr ? { upstream_error: startErr instanceof Error ? startErr.message : String(startErr) } : {}),
              },
            },
            { status: 504 },
          );
        } else if (startErr) {
          const classified = classifyUpstreamError(startErr);
          return NextResponse.json(
            {
              error: classified.error,
              details: {
                hint: classified.hint,
                upstream_error: classified.upstreamError,
                agentic_origin: resolveAgenticOrigin(),
              },
            },
            { status: 502 },
          );
        } else if (terraformApplyNeedsPolling(applyData)) {
          return NextResponse.json(
            {
              error: 'Terraform apply is still running. Multi-AZ RDS often takes 15–25 minutes (up to 45). Do not start another deploy — watch the apply log and the AWS console.',
              status: 'running',
              details: {
                hint: 'The runtime accepted the apply. Leave this deploy alone until Terraform finishes.',
                apply_still_running: true,
                last_apply_status: waited.status,
                agentic_origin: resolveAgenticOrigin(),
              },
            },
            { status: 504 },
          );
        }
      }
      const applyDetails: Record<string, unknown> = {
        ...((applyData.details as Record<string, unknown> | null | undefined) ?? {}),
        ...(applyTransportRecovered ? { apply_transport_recovered: true } : {}),
      };
      const applyStatus = String(applyData.status || '').trim().toLowerCase();
      const runtimeOutputPayload = (applyData.outputs as Record<string, unknown> | null | undefined) ?? undefined;
      const oneTimeCredentials = (
        applyData.one_time_credentials
        && typeof applyData.one_time_credentials === 'object'
        && !Array.isArray(applyData.one_time_credentials)
      ) ? applyData.one_time_credentials as Record<string, unknown> : null;
      if (oneTimeCredentials && runtimeOutputPayload) {
        const pem = String(oneTimeCredentials.private_key_pem || '').trim();
        const keyName = String(oneTimeCredentials.key_name || '').trim();
        if (pem) runtimeOutputPayload.generated_ec2_private_key_pem = pem;
        if (keyName) runtimeOutputPayload.ec2_key_name = keyName;
      }
      const expectedEc2 = containsAwsInstanceResource(baseFiles);
      if (applyStatus === 'awaiting_plan_confirmation') {
        return NextResponse.json(await bindDeploySession({
          success: true,
          provider,
          project_id: projectId,
          mode: 'runtime_apply',
          status: 'awaiting_plan_confirmation',
          requires_plan_confirmation: true,
          plan_summary: applyData.plan_summary || applyDetails.plan_summary || null,
          details: applyDetails,
          ...(staleBundleWarning ? { stale_bundle_warning: staleBundleWarning } : {}),
        }, 'needs_review', 'apply', 'Terraform plan is ready for confirmation.'));
      }
      if ((agenticRes && !agenticRes.ok) || applyData.success !== true) {
        const upstreamError = String(applyData.error || 'Runtime Terraform apply failed.');
        const missingPolicies = Array.isArray(applyDetails.missing_policies)
          ? applyDetails.missing_policies.map((item) => String(item)).filter(Boolean)
          : [];
        if (missingPolicies.length > 0 || /IAM pre-flight failed/i.test(upstreamError)) {
          return NextResponse.json(
            {
              error: 'IAM pre-flight failed. Attach the listed policies before deployment.',
              missing_policies: missingPolicies,
              required_policies: Array.isArray(applyDetails.required_policies)
                ? applyDetails.required_policies
                : missingPolicies,
              details: applyDetails,
            },
            { status: 400 },
          );
        }
        if ((provider as string) === 'aws' && awsAccessKeyId && awsSecretAccessKey && isRecoverableEc2StateFailure(upstreamError)) {
          const recoveredRuntimeDetails = await fetchAwsRuntimeDetails({
            projectName,
            awsAccessKeyId,
            awsSecretAccessKey,
            awsSessionToken,
            awsRegion,
            instanceId: extractOutputString(runtimeOutputPayload, ['ec2_instance_id', 'instance_id']),
          }).catch(() => null);
          const recoveredInstanceId = extractInstanceIdFromRuntimeDetails(recoveredRuntimeDetails);

          if (recoveredInstanceId && recoveredInstanceId !== 'n/a') {
            const mergedDetails = {
              ...(applyDetails || {}),
              live_runtime_details: recoveredRuntimeDetails,
              recovered_from_apply_error: upstreamError,
            };
            const normalizedRuntime = normalizeDeploymentRuntime({
              cloudfrontUrl: typeof applyData.cloudfront_url === 'string' ? applyData.cloudfront_url : null,
              outputs: runtimeOutputPayload,
              details: mergedDetails,
              runtimeDetails: recoveredRuntimeDetails,
              oneTimeCredentials,
            });
            const [verification, bootstrapLifecycle] = await Promise.all([
              waitForRuntimeVerification({
                cloudfrontUrl: normalizedRuntime.cdn.cloudfront_url,
                albUrl: normalizedRuntime.network.alb_url,
                appUrl: normalizedRuntime.cdn.app_url
                  || extractOutputString(runtimeOutputPayload, ['app_url', 'application_url', 'site_url']),
                healthCheckUrl: extractOutputString(runtimeOutputPayload, ['health_check_url', 'health_url']),
                publicIp: normalizedRuntime.network.elastic_ip || normalizedRuntime.ec2.public_ip,
              }),
              waitForBootstrapApplicationStatus({
                instanceId: recoveredInstanceId,
                awsAccessKeyId,
                awsSecretAccessKey,
                awsSessionToken,
                awsRegion,
              }),
            ]);
            const applicationReady = verification.verified && bootstrapLifecycle.bootstrap_ok;
            if (!applicationReady) {
              return NextResponse.json(await bindDeploySession({
                success: true,
                provider,
                project_id: projectId,
                mode: 'runtime_apply',
                app_url: normalizedRuntime.cdn.app_url
                  || (normalizedRuntime.ec2.public_ip ? `http://${normalizedRuntime.ec2.public_ip}` : null),
                cloudfront_url: normalizedRuntime.cdn.cloudfront_url,
                alb_url: normalizedRuntime.network.alb_url,
                alb_dns_name: normalizedRuntime.network.alb_dns_name,
                elastic_ip: normalizedRuntime.network.elastic_ip,
                outputs: runtimeOutputPayload ?? {},
                raw_outputs: runtimeOutputPayload ?? {},
                details: mergedDetails,
                customization_source: customizationSource,
                ec2_key_name: normalizedRuntime.keypair.key_name,
                generated_ec2_private_key_pem: normalizedRuntime.keypair.private_key_pem,
                keypair: normalizedRuntime.keypair,
                one_time_credentials: oneTimeCredentials,
                ec2: normalizedRuntime.ec2,
                network: normalizedRuntime.network,
                cdn: normalizedRuntime.cdn,
                status: 'needs_review',
                deployment_verified: false,
                terraform_status: 'succeeded',
                application_status: bootstrapLifecycle.application_status,
                bootstrap_status: bootstrapLifecycle.bootstrap_status,
                verification_status: bootstrapLifecycle.application_status === 'failed' || !verification.verified
                  ? 'failed'
                  : 'pending',
                infrastructure_only_success: true,
                partial_deployment: true,
                verification_checks: verification.checks,
              }, 'needs_review', 'apply', bootstrapLifecycle.application_status === 'failed'
                ? 'Infrastructure recovered, but application bootstrap failed.'
                : 'EC2 is up in AWS; application verification is incomplete.'));
            }

            return NextResponse.json(await bindDeploySession({
              success: true,
              provider,
              project_id: projectId,
              mode: 'runtime_apply',
              app_url: normalizedRuntime.cdn.app_url
                || (normalizedRuntime.ec2.public_ip ? `http://${normalizedRuntime.ec2.public_ip}` : null),
              cloudfront_url: normalizedRuntime.cdn.cloudfront_url,
              alb_url: normalizedRuntime.network.alb_url,
              alb_dns_name: normalizedRuntime.network.alb_dns_name,
              elastic_ip: normalizedRuntime.network.elastic_ip,
              outputs: runtimeOutputPayload ?? {},
              raw_outputs: runtimeOutputPayload ?? {},
              details: mergedDetails,
              sensitive_output_arns:
                (applyDetails as Record<string, unknown> | undefined)?.sensitive_output_arns ?? null,
              ec2_key_name: normalizedRuntime.keypair.key_name,
              generated_ec2_private_key_pem: normalizedRuntime.keypair.private_key_pem,
              keypair: normalizedRuntime.keypair,
              one_time_credentials: oneTimeCredentials,
              ec2: normalizedRuntime.ec2,
              network: normalizedRuntime.network,
              cdn: normalizedRuntime.cdn,
              status: 'deployed',
              deployment_summary: buildDeploymentSummary({
                outputs: runtimeOutputPayload ?? {},
                normalizedRuntime,
              }),
              deployment_verified: true,
              terraform_status: 'succeeded',
              application_status: 'succeeded',
              bootstrap_status: bootstrapLifecycle.bootstrap_status,
              verification_status: 'passed',
              infrastructure_only_success: false,
              verification_checks: verification.checks,
              recovered_from_apply_error: true,
              ...(staleBundleWarning ? { stale_bundle_warning: staleBundleWarning } : {}),
            }, 'completed', 'apply', 'Runtime apply recovered after a transport error.'));
          }
        }
        const staleError = staleBundleWarning
          ? `${staleBundleWarning.message} ${staleBundleWarning.reasons.join(' ')} Regenerate Terraform and retry.`
          : null;
        return NextResponse.json(
          {
            error: staleError ? `${staleError} Upstream: ${upstreamError}` : upstreamError,
            details:
              {
                ...(applyDetails || {}),
                ...(applyData.raw_response_tail
                  ? { upstream_raw_response_tail: applyData.raw_response_tail }
                  : {}),
                ...(staleBundleWarning ? { stale_bundle_warning: staleBundleWarning } : {}),
              },
            outputs: applyData.outputs ?? null,
          },
          { status: staleBundleWarning ? 409 : ((agenticRes?.ok ?? true) ? 500 : (agenticRes?.status ?? 500)) },
        );
      }

      const hasDbResources = liveDatabaseEndpoints(runtimeOutputPayload);
      const ec2FallbackApplied = Boolean(applyDetails?.ec2_fallback_applied);
      const runtimeDetails = awsAccessKeyId && awsSecretAccessKey
        ? await fetchAwsRuntimeDetails({
          projectName,
          awsAccessKeyId,
          awsSecretAccessKey,
          awsSessionToken,
          awsRegion,
          instanceId: extractOutputString(runtimeOutputPayload, ['ec2_instance_id', 'instance_id']),
        }).catch(() => null)
        : null;
      const ec2InstanceId = extractInstanceIdFromRuntimeDetails(runtimeDetails)
        || extractOutputString(runtimeOutputPayload, ['ec2_instance_id', 'instance_id']);

      if (expectedEc2 && (ec2FallbackApplied || !ec2InstanceId)) {
        return NextResponse.json(
          {
            error: ec2FallbackApplied
              ? 'Deployment incomplete: EC2 provisioning was disabled by quota fallback, so required EC2 resources were not created.'
              : 'Deployment incomplete: Terraform apply succeeded but no EC2 instance was provisioned in AWS.',
            details: {
              expected_ec2: true,
              ec2_fallback_applied: ec2FallbackApplied,
              ec2_instance_id: ec2InstanceId,
              live_runtime_details: runtimeDetails,
              apply_details: applyDetails ?? null,
            },
            outputs: runtimeOutputPayload ?? null,
          },
          { status: 409 },
        );
      }

      const mergedDetails = {
        ...(applyDetails || {}),
        ...(runtimeDetails ? { live_runtime_details: runtimeDetails } : {}),
        ...(customizationSource ? { customization_source: customizationSource } : {}),
      };
      const normalizedRuntime = normalizeDeploymentRuntime({
        cloudfrontUrl: typeof applyData.cloudfront_url === 'string' ? applyData.cloudfront_url : null,
        outputs: runtimeOutputPayload,
        details: mergedDetails,
        runtimeDetails,
        oneTimeCredentials,
      });

      const ec2InstanceIdForBootstrap = ec2InstanceId
        || normalizedRuntime.ec2.instance_id
        || extractOutputString(runtimeOutputPayload, ['ec2_instance_id', 'instance_id']);
      const [verification, bootstrapLifecycle] = await Promise.all([
        waitForRuntimeVerification({
          cloudfrontUrl: normalizedRuntime.cdn.cloudfront_url,
          albUrl: normalizedRuntime.network.alb_url,
          appUrl: normalizedRuntime.cdn.app_url
            || extractOutputString(runtimeOutputPayload, ['app_url', 'application_url', 'site_url']),
          healthCheckUrl: extractOutputString(runtimeOutputPayload, ['health_check_url', 'health_url']),
          publicIp: normalizedRuntime.network.elastic_ip || normalizedRuntime.ec2.public_ip,
        }),
        expectedEc2 && ec2InstanceIdForBootstrap
          ? waitForBootstrapApplicationStatus({
            instanceId: ec2InstanceIdForBootstrap,
            awsAccessKeyId,
            awsSecretAccessKey,
            awsSessionToken,
            awsRegion,
          })
          : Promise.resolve({
            terraform_status: 'succeeded' as const,
            application_status: expectedEc2 ? 'unknown' as const : 'succeeded' as const,
            bootstrap_status: null,
            verification_status: expectedEc2 ? 'pending' as const : 'passed' as const,
            bootstrap_ok: !expectedEc2,
          }),
      ]);
      const applicationStatus = expectedEc2
        ? bootstrapLifecycle.application_status
        : verification.verified ? 'succeeded' : 'failed';
      const applicationReady = verification.verified && (!expectedEc2 || bootstrapLifecycle.bootstrap_ok);
      const infraOnlySuccess = !applicationReady && bootstrapLifecycle.terraform_status === 'succeeded';
      const verificationStatus = applicationReady
        ? 'passed'
        : applicationStatus === 'failed' || !verification.verified
          ? 'failed'
          : 'pending';
      if (!verification.verified && expectedEc2 && !ec2InstanceId) {
        return NextResponse.json(
          {
            error: 'Deployment incomplete: Terraform apply succeeded but no EC2 instance was provisioned in AWS.',
            details: {
              verification_checks: verification.checks,
              live_runtime_details: runtimeDetails,
              apply_details: mergedDetails,
            },
            outputs: runtimeOutputPayload ?? {},
          },
          { status: 409 },
        );
      }

      return NextResponse.json(await bindDeploySession({
        success: true,
        provider,
        project_id: projectId,
        mode: 'runtime_apply',
        app_url: normalizedRuntime.cdn.app_url
          || (normalizedRuntime.ec2.public_ip ? `http://${normalizedRuntime.ec2.public_ip}` : null),
        cloudfront_url: normalizedRuntime.cdn.cloudfront_url,
        alb_url: normalizedRuntime.network.alb_url,
        alb_dns_name: normalizedRuntime.network.alb_dns_name,
        elastic_ip: normalizedRuntime.network.elastic_ip,
        outputs: runtimeOutputPayload ?? {},
        raw_outputs: runtimeOutputPayload ?? {},
        details: mergedDetails,
        customization_source: customizationSource,
        sensitive_output_arns:
          (applyDetails as Record<string, unknown> | undefined)?.sensitive_output_arns ?? null,
        ec2_key_name: normalizedRuntime.keypair.key_name,
        generated_ec2_private_key_pem: normalizedRuntime.keypair.private_key_pem,
        keypair: normalizedRuntime.keypair,
        one_time_credentials: oneTimeCredentials,
        ec2: normalizedRuntime.ec2,
        network: normalizedRuntime.network,
        cdn: normalizedRuntime.cdn,
        status: applicationReady ? 'deployed' : 'needs_review',
        has_database_resources: hasDbResources,
        deployment_summary: buildDeploymentSummary({
          outputs: runtimeOutputPayload ?? {},
          normalizedRuntime,
        }),
        deployment_verified: applicationReady,
        terraform_status: bootstrapLifecycle.terraform_status,
        application_status: applicationStatus,
        bootstrap_status: bootstrapLifecycle.bootstrap_status,
        verification_status: verificationStatus,
        infrastructure_only_success: infraOnlySuccess,
        partial_deployment: Boolean(expectedEc2 && ec2InstanceId && !applicationReady),
        verification_checks: verification.checks,
        ...(staleBundleWarning ? { stale_bundle_warning: staleBundleWarning } : {}),
      }, applicationReady ? 'completed' : 'needs_review', 'apply', applicationReady
        ? 'Runtime Terraform apply finished and application bootstrap verified.'
        : applicationStatus === 'failed'
          ? 'Infrastructure succeeded but application bootstrap failed.'
          : 'Infrastructure is in AWS; the app endpoint is still booting.'));
    }

    const githubPat = String(body.github_pat || '').trim();
    if (!githubPat) {
      return NextResponse.json({ error: 'github_pat is required for gitops repository deployment' }, { status: 400 });
    }

    const workflowPath = '.github/workflows/iac-ci.yml';
    const workflowExists = baseFiles.some(f => normalizePath(String(f.path || '')) === workflowPath);
    const workflow = buildWorkflowYaml(provider);
    const files = workflowExists
      ? baseFiles
      : [...baseFiles, { path: workflowPath, content: workflow.content }];

    if (files.length > MAX_FILES) {
      return NextResponse.json({ error: `Too many files - limit is ${MAX_FILES}` }, { status: 400 });
    }

    const totalBytes = files.reduce((sum, f) => sum + (f.content?.length ?? 0), 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      return NextResponse.json(
        { error: `Total file content exceeds ${(MAX_TOTAL_BYTES / 1_000_000).toFixed(1)} MB limit` },
        { status: 400 },
      );
    }
    for (const f of files) {
      if ((f.content?.length ?? 0) > MAX_FILE_BYTES) {
        return NextResponse.json(
          { error: `File "${f.path}" exceeds ${(MAX_FILE_BYTES / 1_000_000).toFixed(1)} MB limit` },
          { status: 400 },
        );
      }
    }

    const meRes = await ghFetch('https://api.github.com/user', githubPat, 'GET');
    if (!meRes.ok) {
      const msg =
        meRes.status === 401
          ? 'Invalid GitHub token. Use classic PAT scope `repo`, or fine-grained token with Contents (RW) and Metadata (Read).'
          : (meRes.data?.message as string) || 'Failed to authenticate with GitHub';
      return NextResponse.json({ error: msg }, { status: 401 });
    }

    const owner = String(meRes.data.login || '').trim();
    if (!owner) {
      return NextResponse.json({ error: 'Failed to resolve GitHub user' }, { status: 401 });
    }

    const fallbackName = `${projectName}-iac`;
    const safeRepoName = sanitizeRepoName(body.repo_name?.trim() || fallbackName);
    if (!safeRepoName) {
      return NextResponse.json({ error: 'Repository name contains no valid characters' }, { status: 400 });
    }

    const createRes = await ghFetch('https://api.github.com/user/repos', githubPat, 'POST', {
      name: safeRepoName,
      description: body.description?.trim() || `DeplAI IaC deployment bundle for ${projectName}`,
      private: body.is_private ?? true,
      auto_init: false,
    });

    let repoAlreadyExisted = false;
    if (!createRes.ok) {
      const createMessage = String(createRes.data?.message || '');
      const exists = createRes.status === 422 && /name already exists/i.test(createMessage);
      if (!exists) {
        return NextResponse.json(
          { error: createMessage || 'Failed to create repository' },
          { status: 422 },
        );
      }
      repoAlreadyExisted = true;
    }

    const pushed: string[] = [];
    const failed: Array<{ path: string; reason: string }> = [];

    for (const file of files) {
      if (!file?.path || typeof file.content !== 'string') continue;
      const safePath = normalizePath(file.path);
      if (!safePath || safePath.includes('..')) {
        failed.push({ path: file.path, reason: 'unsafe path' });
        continue;
      }

      try {
        const sha = await fetchFileSha(owner, safeRepoName, safePath, githubPat);
        const encoded = file.encoding === 'base64'
          ? file.content
          : Buffer.from(file.content, 'utf-8').toString('base64');
        const payload: Record<string, string> = {
          message: sha ? `chore: update ${safePath}` : `feat: add ${safePath}`,
          content: encoded,
        };
        if (sha) payload.sha = sha;

        const pushRes = await ghFetch(
          `https://api.github.com/repos/${owner}/${safeRepoName}/contents/${safePath}`,
          githubPat,
          'PUT',
          payload,
        );
        if (pushRes.ok) {
          pushed.push(safePath);
        } else {
          failed.push({
            path: safePath,
            reason: (pushRes.data?.message as string) || 'unknown',
          });
        }
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message : 'network error';
        failed.push({ path: safePath, reason });
      }
    }

    const configuredVars: string[] = [];
    if ((provider as string) === 'aws') {
      const awsAccessKeyId = String(body.aws_access_key_id || '').trim();
      const awsSecretAccessKey = String(body.aws_secret_access_key || '').trim();
      const awsRegion = String(body.aws_region || 'eu-north-1').trim() || 'eu-north-1';

      if (awsAccessKeyId && awsSecretAccessKey) {
        await upsertRepoVariable(owner, safeRepoName, githubPat, 'AWS_ACCESS_KEY_ID', awsAccessKeyId);
        await upsertRepoVariable(owner, safeRepoName, githubPat, 'AWS_SECRET_ACCESS_KEY', awsSecretAccessKey);
        configuredVars.push('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY');
      }

      await upsertRepoVariable(owner, safeRepoName, githubPat, 'AWS_REGION', awsRegion);
      configuredVars.push('AWS_REGION');
    }

    return NextResponse.json({
      success: failed.length === 0,
      provider,
      project_id: projectId,
      repo_url: `https://github.com/${owner}/${safeRepoName}`,
      owner,
      repo_name: safeRepoName,
      repo_already_existed: repoAlreadyExisted,
      workflow_path: workflowPath,
      workflow_source: workflowExists ? 'provided_by_request' : workflow.source,
      configured_vars: configuredVars,
      pushed,
      failed,
      blocked: false,
    });
  } catch (err) {
    const classified = classifyUpstreamError(err);
    return NextResponse.json(
      {
        error: classified.error,
        details: {
          hint: classified.hint,
          upstream_error: classified.upstreamError,
          agentic_origin: resolveAgenticOrigin(),
        },
      },
      { status: 500 },
    );
  }
}
