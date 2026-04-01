import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { ArchitectureJson, validateArchitectureJson } from '@/lib/architecture-contract';

interface ArchitectureBody {
  prompt: string;
  provider?: string;
  project_name?: string;
  qa_summary?: string;
  deployment_region?: string;
  llm_provider?: string;
  llm_api_key?: string;
  llm_model?: string;
}

const AWS_REGION_LABELS: Record<string, string> = {
  'ap-south-1': 'Asia Pacific (Mumbai)',
  'ap-south-2': 'Asia Pacific (Hyderabad)',
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-1': 'US West (N. California)',
  'us-west-2': 'US West (Oregon)',
  'eu-central-1': 'Europe (Frankfurt)',
  'eu-west-1': 'Europe (Ireland)',
  'eu-west-2': 'Europe (London)',
  'eu-west-3': 'Europe (Paris)',
  'eu-north-1': 'Europe (Stockholm)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
};

function normalizeProjectName(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return 'deplai-project';
  return raw.split('/').pop() || raw;
}

function awsRegionLabel(code: string): string {
  const v = String(code || '').trim().toLowerCase();
  return AWS_REGION_LABELS[v] || AWS_REGION_LABELS['ap-south-1'];
}

function resolveWebsiteBlockPublicAccessFromQa(qaSummary: string): boolean {
  const qaText = String(qaSummary || '');
  const text = qaText.toLowerCase();
  if (!text.trim()) return true;

  const qaPairs = qaText.split(/\n\s*\n/g);
  for (const pair of qaPairs) {
    const question = (pair.match(/Q:\s*(.+)/i)?.[1] || '').toLowerCase();
    const answer = (pair.match(/A:\s*(.+)/i)?.[1] || '').toLowerCase();
    if (!question || !answer) continue;
    if (!question.includes('block public access')) continue;
    if (/\b(off|disable|disabled|no|false)\b/.test(answer) && !/\bon\b/.test(answer)) return false;
    if (/\b(on|enable|enabled|yes|true)\b/.test(answer) && !/\boff\b/.test(answer)) return true;
  }

  if (
    text.includes('block public access off') ||
    text.includes('block public access: off') ||
    text.includes('disable block public access')
  ) return false;

  if (
    text.includes('block public access on') ||
    text.includes('block public access: on') ||
    text.includes('enable block public access')
  ) return true;

  return true;
}

function extractQaAnswer(qaSummary: string, includesText: string): string {
  const pairs = String(qaSummary || '').split(/\n\s*\n/g);
  for (const pair of pairs) {
    const question = (pair.match(/Q:\s*(.+)/i)?.[1] || '').toLowerCase();
    const answer = (pair.match(/A:\s*(.+)/i)?.[1] || '').trim();
    if (!question || !answer) continue;
    if (question.includes(includesText.toLowerCase())) {
      return answer;
    }
  }
  return '';
}

function parseInstanceTypeFromQa(qaSummary: string): string {
  const text = String(qaSummary || '').toLowerCase();
  const explicit = text.match(/\b([tmcr]\d[a-z]?(?:[a-z])?\.[a-z0-9]+)\b/);
  if (explicit) return explicit[1];

  const sizingAnswer = extractQaAnswer(qaSummary, 'ec2 sizing');
  const sizingText = `${text} ${sizingAnswer.toLowerCase()}`;

  if (sizingText.includes('memory-optimized') || sizingText.includes('memory optimized') || sizingText.includes('memory heavy')) {
    return 'r6i.large';
  }
  if (sizingText.includes('compute-optimized') || sizingText.includes('compute optimized') || sizingText.includes('cpu heavy')) {
    return 'c6i.large';
  }
  if (sizingText.includes('large')) return 't3.large';
  if (sizingText.includes('medium')) return 't3.medium';
  return 't3.micro';
}

function parseStorageGbFromQa(qaSummary: string): { website: number; logs: number; ec2: number } {
  const text = String(qaSummary || '').toLowerCase();
  const explicitGb = Array.from(text.matchAll(/(\d{1,5})\s*gb\b/g)).map((m) => Number(m[1]));

  const websiteDefault = 10;
  const logsDefault = 10;
  const ec2Default = 8;

  if (explicitGb.length === 0) {
    return { website: websiteDefault, logs: logsDefault, ec2: ec2Default };
  }

  const maxSeen = Math.max(...explicitGb);
  const minSeen = Math.min(...explicitGb);
  return {
    website: Math.max(websiteDefault, Math.min(5000, maxSeen)),
    logs: Math.max(logsDefault, Math.min(5000, Math.round(maxSeen * 0.5))),
    ec2: Math.max(ec2Default, Math.min(2000, minSeen)),
  };
}

function parseTrafficProfile(qaSummary: string): { requestsPerMonth: number; instanceCount: number } {
  const text = String(qaSummary || '').toLowerCase();

  let peakRps = 0;
  const rpsMatch = text.match(/(\d{1,6})\s*(?:rps|req(?:uests)?\s*\/\s*s|requests per second)/i);
  if (rpsMatch) peakRps = Number(rpsMatch[1]);

  let monthlyRequests = 0;
  const monthlyMatch = text.match(/(\d{1,9})\s*(?:requests?\s*(?:per|\/)\s*month|rpmonth|req\/month)/i);
  if (monthlyMatch) monthlyRequests = Number(monthlyMatch[1]);

  if (!monthlyRequests && peakRps > 0) {
    monthlyRequests = peakRps * 60 * 60 * 24 * 30;
  }
  if (!monthlyRequests) {
    monthlyRequests = 3_000_000;
  }

  let instanceCount = 1;
  if (peakRps >= 300 || monthlyRequests >= 25_000_000) instanceCount = 2;
  if (peakRps >= 800 || monthlyRequests >= 60_000_000) instanceCount = 3;
  if (peakRps >= 2000 || monthlyRequests >= 150_000_000) instanceCount = 4;

  return { requestsPerMonth: monthlyRequests, instanceCount };
}

function isFreeTierMode(qaSummary: string, prompt: string): boolean {
  const text = `${qaSummary}\n${prompt}`.toLowerCase();
  return (
    text.includes('free tier') ||
    text.includes('aws free tier') ||
    text.includes('free-tier')
  );
}

function buildDeterministicAwsArchitecture(
  projectName: string,
  qaSummary: string,
  deploymentRegion: string,
  prompt: string,
): ArchitectureJson {
  const region = awsRegionLabel(deploymentRegion);
  const blockPublicAccess = resolveWebsiteBlockPublicAccessFromQa(qaSummary);
  const freeTier = isFreeTierMode(qaSummary, prompt);
  const instanceType = parseInstanceTypeFromQa(qaSummary);
  const storage = parseStorageGbFromQa(qaSummary);
  const traffic = parseTrafficProfile(qaSummary);
  const freeTierInstanceType = instanceType.includes('.micro') ? instanceType : 't3.micro';
  const safeInstanceType = freeTier ? freeTierInstanceType : instanceType;
  const safeTraffic = freeTier
    ? { requestsPerMonth: Math.min(1_000_000, traffic.requestsPerMonth), instanceCount: 1 }
    : traffic;
  const safeStorage = freeTier
    ? {
      website: Math.min(5, storage.website),
      logs: Math.min(5, storage.logs),
      ec2: Math.min(8, storage.ec2),
    }
    : storage;

  return {
    provider: 'aws',
    schema_version: '1.0',
    title: `Deterministic AWS Deploy Plan for ${projectName}`,
    metadata: {
      source: 'deterministic_template',
    },
    nodes: [
      {
        id: 'cloudFrontDistribution',
        type: 'AmazonCloudFront',
        label: 'CloudFront Distribution',
        region,
        attributes: {
          rootObject: 'index.html',
          origin: 'S3 Website Bucket (private via OAC)',
        },
      },
      {
        id: 'websiteBucket',
        type: 'AmazonS3',
        label: 'Website Bucket',
        region,
        attributes: {
          storageGB: safeStorage.website,
          projectedRequestsPerMonth: safeTraffic.requestsPerMonth,
          storageClass: 'Standard',
          blockPublicAccess,
          websiteHosting: true,
          freeTierMode: freeTier,
        },
      },
      {
        id: 'webAppServer',
        type: 'AmazonEC2',
        label: 'Web Server',
        region,
        attributes: {
          instanceType: safeInstanceType,
          instanceCount: safeTraffic.instanceCount,
          operatingSystem: 'Linux',
          tenancy: 'Shared',
          capacitystatus: 'Used',
          preInstalledSw: 'NA',
          termType: 'OnDemand',
          storageGB: safeStorage.ec2,
          volumeType: 'gp3',
          freeTierMode: freeTier,
        },
      },
      {
        id: 'defaultVpc',
        type: 'AmazonVPC',
        label: 'Default VPC (existing)',
        region,
        attributes: {
          source: 'data.aws_vpc.default',
        },
      },
      {
        id: 'defaultSubnet',
        type: 'AmazonSubnet',
        label: 'Default Subnet (existing)',
        region,
        attributes: {
          source: 'data.aws_subnets.default_in_vpc',
        },
      },
      {
        id: 'webSecurityGroup',
        type: 'AWSSecurityGroup',
        label: 'Web Security Group',
        region,
        attributes: {
          inbound: ['22/tcp', '80/tcp'],
          outbound: ['all'],
        },
      },
    ],
    edges: [
      { from: 'cloudFrontDistribution', to: 'websiteBucket', label: 'origin (OAC)' },
      { from: 'defaultVpc', to: 'defaultSubnet' },
      { from: 'defaultSubnet', to: 'webAppServer' },
      { from: 'webSecurityGroup', to: 'webAppServer' },
    ],
  };
}

/**
 * POST /api/architecture
 * Generate an architecture JSON from a natural language description.
 * Proxies to Agentic Layer POST /api/architecture/generate.
 */
export async function POST(req: NextRequest) {
  try {
    const { error } = await requireAuth();
    if (error) return error;

    const body = await req.json() as ArchitectureBody;
    const prompt = String(body.prompt || '').trim();
    if (!prompt) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const provider = String(body.provider || 'aws').trim().toLowerCase();

    const explicitLlmRequested = Boolean(body.llm_provider || body.llm_api_key || body.llm_model);

    if (provider === 'aws' && !explicitLlmRequested) {
      const projectName = normalizeProjectName(String(body.project_name || ''));
      const qaSummary = String(body.qa_summary || '');
      const deploymentRegion = String(body.deployment_region || 'ap-south-1');
      const deterministicArchitecture = buildDeterministicAwsArchitecture(projectName, qaSummary, deploymentRegion, prompt);
      const archValidation = validateArchitectureJson(deterministicArchitecture);
      if (!archValidation.valid || !archValidation.normalized) {
        return NextResponse.json(
          { error: `Generated deterministic architecture failed validation: ${archValidation.errors.join('; ')}` },
          { status: 500 },
        );
      }
      return NextResponse.json({
        success: true,
        provider,
        architecture_json: archValidation.normalized,
        source: 'deterministic_template',
      });
    }

    const agenticRes = await fetch(`${AGENTIC_URL}/api/architecture/generate`, {
      method: 'POST',
      headers: {
        ...agenticHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        provider,
        llm_provider: body.llm_provider || null,
        llm_api_key: body.llm_api_key || null,
        llm_model: body.llm_model || null,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    const data = await agenticRes.json();

    if (!agenticRes.ok || !data.success) {
      return NextResponse.json(
        { error: data.error || 'Architecture generation failed' },
        { status: agenticRes.ok ? 500 : agenticRes.status },
      );
    }
    const archValidation = validateArchitectureJson(data.architecture_json);
    if (!archValidation.valid || !archValidation.normalized) {
      return NextResponse.json(
        { error: `Generated architecture failed contract validation: ${archValidation.errors.join('; ')}` },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      provider,
      architecture_json: archValidation.normalized,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Architecture generation error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
