import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { readLegacyCicdTemplate } from '@/lib/legacy-assets';

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
  github_pat?: string;
  runtime_apply?: boolean;
  repo_name?: string;
  description?: string;
  is_private?: boolean;
  files?: GeneratedFile[];
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_region?: string;
  enforce_free_tier_ec2?: boolean;
  estimated_monthly_usd?: number;
  budget_limit_usd?: number;
  budget_override?: boolean;
}

function resolveAgenticOrigin(): string {
  try {
    return new URL(AGENTIC_URL).origin;
  } catch {
    return AGENTIC_URL;
  }
}

function classifyUpstreamError(err: unknown): { error: string; hint: string; upstreamError: string } {
  const raw = err instanceof Error ? err.message : String(err || 'unknown upstream error');
  const lowered = raw.toLowerCase();

  if (lowered.includes('timeout')) {
    return {
      error: 'Deployment runtime timed out before Terraform apply completed.',
      hint: 'The apply may still be in-flight. Check Connector logs and AWS console, then retry if nothing is active.',
      upstreamError: raw,
    };
  }
  if (
    lowered.includes('fetch failed') ||
    lowered.includes('econnrefused') ||
    lowered.includes('enotfound') ||
    lowered.includes('network')
  ) {
    return {
      error: 'Connector could not reach the deployment runtime service.',
      hint: 'Verify AGENTIC_LAYER_URL is reachable from the Connector runtime and that the Agentic Layer service is healthy.',
      upstreamError: raw,
    };
  }

  return {
    error: 'Deployment runtime request failed before Terraform apply response was received.',
    hint: 'Check Connector and Agentic Layer logs for transport/proxy/server timeout issues.',
    upstreamError: raw,
  };
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

  await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`,
    pat,
    'PATCH',
    { name, value: trimmed },
  );

  await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/variables`,
    pat,
    'POST',
    { name, value: trimmed },
  );
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

function containsAwsInstanceResource(files: GeneratedFile[]): boolean {
  return files.some((file) => {
    const path = normalizePath(String(file.path || '')).toLowerCase();
    if (!path.endsWith('.tf')) return false;
    const content = String(file.content || '');
    return /resource\s+"aws_instance"\s+"[^"]+"/i.test(content);
  });
}

function detectStaleAwsTerraformBundle(files: GeneratedFile[]): string[] {
  const tfFiles = files
    .filter((file) => normalizePath(String(file.path || '')).toLowerCase().endsWith('.tf'))
    .map((file) => String(file.content || ''));
  if (tfFiles.length === 0) return ['No Terraform .tf files were provided in deploy payload.'];

  const combined = tfFiles.join('\n');
  const reasons: string[] = [];

  const hasUseDefaultVpcVar = /variable\s+"use_default_vpc"\s*\{/i.test(combined);
  const hasLegacyVpcCreate = /resource\s+"aws_vpc"\s+"main"\s*\{/i.test(combined);
  const hasVpcConditionalCount = /resource\s+"aws_vpc"\s+"main"\s*\{[\s\S]*?count\s*=\s*var\.use_default_vpc\s*\?\s*0\s*:\s*1/i.test(combined);
  if (hasLegacyVpcCreate && (!hasUseDefaultVpcVar || !hasVpcConditionalCount)) {
    reasons.push('Terraform bundle still creates aws_vpc.main without default-VPC conditional mode.');
  }

  const hasLegacyOacName = /resource\s+"aws_cloudfront_origin_access_control"\s+"oac"\s*\{[\s\S]*?name\s*=\s*"\$\{var\.project_name\}-oac"/i.test(combined);
  if (hasLegacyOacName) {
    reasons.push('CloudFront OAC name is static and may collide on reruns.');
  }

  const hasExistingKeyPairVar = /variable\s+"existing_ec2_key_pair_name"\s*\{/i.test(combined);
  const hasGeneratedKeyPair = /resource\s+"aws_key_pair"\s+"generated"\s*\{/i.test(combined);
  if (hasGeneratedKeyPair && !hasExistingKeyPairVar) {
    reasons.push('EC2 key pair reuse variable is missing; duplicate key-pair imports can fail.');
  }

  return reasons;
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

    const owned = await verifyProjectOwnership(user.id, projectId);
    if ('error' in owned) return owned.error;

    const provider = clampProvider(body.provider);
    const projectName = String(owned.project?.name || owned.project?.full_name || projectId).split('/').pop() || projectId;
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

    const baseFiles = Array.isArray(body.files) ? body.files : [];
    if (baseFiles.length === 0) {
      return NextResponse.json(
        { error: 'No generated IaC files provided. Generate Terraform/Ansible first.' },
        { status: 400 },
      );
    }
    const runtimeMode = body.runtime_apply === true;
    const MAX_FILES = runtimeMode ? 3000 : 120;
    const MAX_FILE_BYTES = runtimeMode ? 8_000_000 : 700_000;
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
      if (provider !== 'aws') {
        return NextResponse.json(
          { error: 'runtime_apply currently supports AWS only.' },
          { status: 400 },
        );
      }

      const staleReasons = detectStaleAwsTerraformBundle(baseFiles);
      if (staleReasons.length > 0) {
        return NextResponse.json(
          {
            error: 'Provided Terraform bundle is outdated for current AWS runtime safety constraints. Regenerate Stage 8 IaC and retry deploy.',
            details: {
              reasons: staleReasons,
              required_actions: [
                'Re-run Stage 8 (Generate terraform + ansible) to refresh files.',
                'Ensure generated Terraform includes variable "use_default_vpc" and unique CloudFront OAC naming.',
                'Retry deploy after refreshed bundle is loaded in UI state.',
              ],
            },
          },
          { status: 409 },
        );
      }

      const awsAccessKeyId = String(body.aws_access_key_id || process.env.AWS_ACCESS_KEY_ID || '').trim();
      const awsSecretAccessKey = String(body.aws_secret_access_key || process.env.AWS_SECRET_ACCESS_KEY || '').trim();
      const awsRegion = String(body.aws_region || 'eu-north-1').trim() || 'eu-north-1';
      const enforceFreeTierEc2 = body.enforce_free_tier_ec2 !== false;

      if (!awsAccessKeyId || !awsSecretAccessKey) {
        return NextResponse.json(
          {
            error: 'AWS credentials are required for runtime deployment. Provide aws_access_key_id/aws_secret_access_key or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY on the server.',
          },
          { status: 400 },
        );
      }

      const applyRequest = {
        project_name: projectName,
        provider,
        files: baseFiles,
        aws_access_key_id: awsAccessKeyId,
        aws_secret_access_key: awsSecretAccessKey,
        aws_region: awsRegion,
        enforce_free_tier_ec2: enforceFreeTierEc2,
      };
      let agenticRes: Response;
      try {
        agenticRes = await fetch(`${AGENTIC_URL}/api/terraform/apply`, {
          method: 'POST',
          headers: { ...agenticHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(applyRequest),
          signal: AbortSignal.timeout(3_600_000),
        });
      } catch (upstreamErr) {
        const classified = classifyUpstreamError(upstreamErr);
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
      }

      const applyRaw = await agenticRes.text();
      let applyData: Record<string, unknown> = {};
      if (applyRaw.trim()) {
        try {
          applyData = JSON.parse(applyRaw) as Record<string, unknown>;
        } catch {
          applyData = { raw_response_tail: applyRaw.slice(-2000) };
        }
      }
      if (!agenticRes.ok || applyData.success !== true) {
        return NextResponse.json(
          {
            error: String(applyData.error || 'Runtime Terraform apply failed.'),
            details:
              applyData.details ??
              (applyData.raw_response_tail
                ? { upstream_raw_response_tail: applyData.raw_response_tail }
                : null),
            outputs: applyData.outputs ?? null,
          },
          { status: agenticRes.ok ? 500 : agenticRes.status },
        );
      }

      const expectedEc2 = containsAwsInstanceResource(baseFiles);
      const applyDetails = (applyData.details as Record<string, unknown> | null | undefined) ?? undefined;
      const runtimeOutputs = (applyData.outputs as Record<string, unknown> | null | undefined) ?? undefined;
      const ec2FallbackApplied = Boolean(applyDetails?.ec2_fallback_applied);
      const ec2InstanceId = extractOutputString(runtimeOutputs, ['ec2_instance_id', 'instance_id']);

      if (expectedEc2 && (ec2FallbackApplied || !ec2InstanceId)) {
        return NextResponse.json(
          {
            error: ec2FallbackApplied
              ? 'Deployment incomplete: EC2 provisioning was disabled by quota fallback, so required EC2 resources were not created.'
              : 'Deployment incomplete: Terraform apply succeeded but no EC2 instance was provisioned.',
            details: {
              expected_ec2: true,
              ec2_fallback_applied: ec2FallbackApplied,
              ec2_instance_id: ec2InstanceId,
              apply_details: applyDetails ?? null,
            },
            outputs: runtimeOutputs ?? null,
          },
          { status: 409 },
        );
      }

      return NextResponse.json({
        success: true,
        provider,
        project_id: projectId,
        mode: 'runtime_apply',
        cloudfront_url: applyData.cloudfront_url ?? null,
        outputs: applyData.outputs ?? {},
        details: applyData.details ?? null,
        ec2_key_name: extractStringFromRecord(
          {
            ...(((applyData.outputs as Record<string, unknown> | undefined) ?? {})),
            ...(((applyData.details as Record<string, unknown> | undefined) ?? {})),
            ...applyData,
          },
          ['ec2_key_name', 'generated_ec2_key_name', 'key_name'],
        ),
        generated_ec2_private_key_pem: extractStringFromRecord(
          {
            ...(((applyData.outputs as Record<string, unknown> | undefined) ?? {})),
            ...(((applyData.details as Record<string, unknown> | undefined) ?? {})),
            ...applyData,
          },
          ['generated_ec2_private_key_pem', 'generated_private_key_pem', 'ec2_private_key_pem', 'private_key_pem'],
        ),
      });
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
    if (provider === 'aws') {
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
