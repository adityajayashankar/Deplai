import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { AGENTIC_URL } from '@/lib/agentic';
import { getLegacyRootRuntimeStatus, getLegacyTerraformRagStatus } from '@/lib/legacy-assets';

type HealthState = 'healthy' | 'degraded' | 'down';

interface HealthCheck {
  name: string;
  state: HealthState;
  detail: string;
}

async function checkAgenticHealth(): Promise<HealthCheck> {
  try {
    const res = await fetch(`${AGENTIC_URL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    if (!res.ok) {
      return {
        name: 'agentic_layer',
        state: 'down',
        detail: `Health endpoint returned ${res.status}`,
      };
    }
    const data = await res.json().catch(() => ({})) as { status?: string };
    return {
      name: 'agentic_layer',
      state: data.status === 'healthy' ? 'healthy' : 'degraded',
      detail: data.status === 'healthy' ? 'Connected' : 'Unexpected health payload',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unreachable';
    return { name: 'agentic_layer', state: 'down', detail: msg };
  }
}

export async function GET() {
  const { error } = await requireAuth();
  if (error) return error;

  const checks: HealthCheck[] = [];
  const agentic = await checkAgenticHealth();
  checks.push(agentic);

  const agenticUp = agentic.state === 'healthy';
  const legacyTerraform = getLegacyTerraformRagStatus();
  const legacyRuntime = getLegacyRootRuntimeStatus();
  const serviceChecks: HealthCheck[] = [
    { name: 'scan', state: agenticUp ? 'healthy' : 'down', detail: agenticUp ? 'Ready' : 'Agentic layer unavailable' },
    { name: 'remediation', state: agenticUp ? 'healthy' : 'down', detail: agenticUp ? 'Ready' : 'Agentic layer unavailable' },
    { name: 'architecture', state: agenticUp ? 'healthy' : 'down', detail: agenticUp ? 'Ready' : 'Agentic layer unavailable' },
    { name: 'diagram', state: agenticUp ? 'healthy' : 'down', detail: agenticUp ? 'Ready' : 'Architecture JSON renderer offline' },
    { name: 'cost', state: agenticUp ? 'healthy' : 'down', detail: agenticUp ? 'Ready' : 'Agentic layer unavailable' },
    {
      name: 'terraform',
      state: agenticUp ? 'healthy' : 'degraded',
      detail: agenticUp
        ? 'RAG agent (with DeplAI_old vector DB fallback) + template fallback available'
        : 'RAG agent unavailable; Connector template fallback still available',
    },
    {
      name: 'legacy_terraform_rag_assets',
      state: legacyTerraform.available ? 'healthy' : 'degraded',
      detail: legacyTerraform.available
        ? `Legacy Terraform RAG assets detected (orchestrator=${legacyTerraform.has_orchestrator}, vector_db=${legacyTerraform.has_vector_db})`
        : 'Legacy Terraform RAG assets missing; only current module available',
    },
    {
      name: 'legacy_runtime_reference_pack',
      state: legacyRuntime.available ? 'healthy' : 'degraded',
      detail: legacyRuntime.available
        ? `Legacy runtime files available (${legacyRuntime.present_count}/${legacyRuntime.required_count}) for migration/reference`
        : 'Legacy runtime root files unavailable',
    },
    {
      name: 'gitops_deploy',
      state: process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY ? 'healthy' : 'degraded',
      detail: process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY
        ? 'GitHub integration configured'
        : 'GitHub App env vars missing; runtime PAT deploy still possible',
    },
    {
      name: 'runtime_deploy',
      state: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? 'healthy' : 'degraded',
      detail: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? 'AWS runtime deploy credentials configured'
        : 'AWS runtime deploy credentials missing; deploy route will require explicit credentials',
    },
  ];

  checks.push(...serviceChecks);

  const hasDown = checks.some(c => c.state === 'down');
  const hasDegraded = checks.some(c => c.state === 'degraded');
  const overall: HealthState = hasDown ? 'down' : hasDegraded ? 'degraded' : 'healthy';

  return NextResponse.json({
    success: true,
    overall,
    checks,
    checked_at: new Date().toISOString(),
  });
}
