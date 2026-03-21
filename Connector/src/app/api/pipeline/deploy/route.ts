import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { readLegacyCicdTemplate } from '@/lib/legacy-assets';

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
  estimated_monthly_usd?: number;
  budget_limit_usd?: number;
  budget_override?: boolean;
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
          aws-region: \${{ vars.AWS_REGION || 'ap-south-1' }}`,
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
  const awsRegion = 'ap-south-1';
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

      const awsAccessKeyId = String(body.aws_access_key_id || '').trim();
      const awsSecretAccessKey = String(body.aws_secret_access_key || '').trim();
      const awsRegion = String(body.aws_region || 'ap-south-1').trim() || 'ap-south-1';

      if (!awsAccessKeyId || !awsSecretAccessKey) {
        return NextResponse.json(
          {
            error: 'AWS credentials are required for runtime deployment. Provide aws_access_key_id and aws_secret_access_key in this request.',
          },
          { status: 400 },
        );
      }

      const agenticRes = await fetch(`${AGENTIC_URL}/api/terraform/apply`, {
        method: 'POST',
        headers: { ...agenticHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_name: projectName,
          provider,
          files: baseFiles,
          aws_access_key_id: awsAccessKeyId,
          aws_secret_access_key: awsSecretAccessKey,
          aws_region: awsRegion,
        }),
        signal: AbortSignal.timeout(3_600_000),
      });
      const applyData = await agenticRes.json().catch(() => ({})) as Record<string, unknown>;
      if (!agenticRes.ok || applyData.success !== true) {
        return NextResponse.json(
          {
            error: String(applyData.error || 'Runtime Terraform apply failed.'),
            details: applyData.details ?? null,
            outputs: applyData.outputs ?? null,
          },
          { status: agenticRes.ok ? 500 : agenticRes.status },
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
      const awsRegion = String(body.aws_region || 'ap-south-1').trim() || 'ap-south-1';

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
    const msg = err instanceof Error ? err.message : 'Deployment failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
