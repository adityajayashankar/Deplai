import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { AGENTIC_URL } from '@/lib/agentic';

type HealthState = 'healthy' | 'degraded' | 'down';

interface HealthCheck {
  name: string;
  state: HealthState;
  detail: string;
}

interface AgenticHealthPayload {
  status?: string;
  checks?: Array<{ name?: string; state?: string; detail?: string }>;
}

const OPTIONAL_UPSTREAM_CHECKS = new Set(['neo4j']);

async function checkAgenticHealth(): Promise<{ check: HealthCheck; upstreamChecks: HealthCheck[]; reachable: boolean }> {
  try {
    const res = await fetch(`${AGENTIC_URL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    if (!res.ok) {
      return {
        check: {
          name: 'agentic_layer',
          state: 'down',
          detail: `Health endpoint returned ${res.status}`,
        },
        upstreamChecks: [],
        reachable: false,
      };
    }
    const data = await res.json().catch(() => ({})) as AgenticHealthPayload;
    const upstreamChecks = Array.isArray(data.checks)
      ? data.checks
        .filter((check) => check?.name && !String(check.name).startsWith('legacy_'))
        .map((check) => {
          const name = String(check.name);
          const normalizedState: HealthState = (check.state === 'healthy' || check.state === 'degraded' || check.state === 'down')
            ? check.state
            : 'degraded';
          const state: HealthState = normalizedState === 'down' && OPTIONAL_UPSTREAM_CHECKS.has(name)
            ? 'degraded'
            : normalizedState;
          return {
            name,
            state,
            detail: String(check.detail || ''),
          };
        })
      : [];
    const hasAnyHealthyUpstream = upstreamChecks.some((check) => check.state === 'healthy');
    const mappedState: HealthState = data.status === 'healthy'
      ? 'healthy'
      : data.status === 'down'
        ? (hasAnyHealthyUpstream ? 'degraded' : 'down')
        : 'degraded';
    return {
      check: {
        name: 'agentic_layer',
        state: mappedState,
        detail: mappedState === 'healthy' ? 'Connected' : mappedState === 'degraded' ? 'Reachable with dependency issues' : 'Agentic layer unavailable',
      },
      upstreamChecks,
      reachable: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unreachable';
    return {
      check: { name: 'agentic_layer', state: 'down', detail: msg },
      upstreamChecks: [],
      reachable: false,
    };
  }
}

export async function GET() {
  const { error } = await requireAuth();
  if (error) return error;

  const checks: HealthCheck[] = [];
  const agenticHealth = await checkAgenticHealth();
  checks.push(agenticHealth.check, ...agenticHealth.upstreamChecks);

  const upstreamState = (name: string): HealthState | undefined =>
    checks.find((c) => c.name === name)?.state;
  const agenticAvailable = agenticHealth.reachable;
  const dockerUp = checks.find(c => c.name === 'docker_engine')?.state === 'healthy';
  const neo4jUp = upstreamState('neo4j') === 'healthy';
  const architectureEngineUp = upstreamState('architecture') !== 'down';
  const costEngineUp = upstreamState('cost') !== 'down';
  const terraformEngineUp = upstreamState('terraform') !== 'down';
  const diagramEngineUp = architectureEngineUp;
  const serviceChecks: HealthCheck[] = [
    {
      name: 'scan',
      state: agenticAvailable && dockerUp ? 'healthy' : 'down',
      detail: agenticAvailable && dockerUp ? 'Ready' : !agenticAvailable ? 'Agentic layer unavailable' : 'Docker engine unavailable',
    },
    {
      name: 'remediation',
      state: agenticAvailable && dockerUp ? 'healthy' : 'down',
      detail: agenticAvailable && dockerUp ? (neo4jUp ? 'Ready' : 'Ready (KG will be skipped - Neo4j offline)') : !agenticAvailable ? 'Agentic layer unavailable' : 'Docker engine unavailable',
    },
    {
      name: 'kg_agent',
      state: neo4jUp ? 'healthy' : 'degraded',
      detail: neo4jUp ? 'Neo4j connected' : 'Neo4j offline - remediation will continue without KG enrichment',
    },
    { name: 'architecture', state: agenticAvailable && architectureEngineUp ? 'healthy' : 'down', detail: agenticAvailable && architectureEngineUp ? 'Ready' : 'Agentic layer unavailable' },
    { name: 'diagram', state: agenticAvailable && diagramEngineUp ? 'healthy' : 'down', detail: agenticAvailable && diagramEngineUp ? 'Ready' : 'Architecture JSON renderer offline' },
    { name: 'cost', state: agenticAvailable && costEngineUp ? 'healthy' : 'down', detail: agenticAvailable && costEngineUp ? 'Ready' : 'Agentic layer unavailable' },
    {
      name: 'terraform',
      state: agenticAvailable && terraformEngineUp ? 'healthy' : 'degraded',
      detail: agenticAvailable && terraformEngineUp
        ? 'LLM IaC generator reachable'
        : 'LLM IaC generator unavailable',
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

  const overallDrivers = [agenticHealth.check, ...serviceChecks];
  const hasDown = overallDrivers.some(c => c.state === 'down');
  const hasDegraded = overallDrivers.some(c => c.state === 'degraded');
  const overall: HealthState = hasDown ? 'down' : hasDegraded ? 'degraded' : 'healthy';

  return NextResponse.json({
    success: true,
    overall,
    checks,
    checked_at: new Date().toISOString(),
  });
}
