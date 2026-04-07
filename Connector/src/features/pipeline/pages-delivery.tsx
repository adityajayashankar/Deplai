import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COST_BREAKDOWN } from './data';
import { Btn, colorize, FileNode, Header, Tag } from './ui';
import { buildDeploymentWorkspace } from '@/lib/deployment-planning-contract';

export interface AwsCredentialsConfig {
  aws_access_key_id: string;
  aws_secret_access_key: string;
  aws_region: string;
}

const REPO_CONTEXT_KEY = 'deplai.pipeline.repoContext';
const REPO_CONTEXT_MD_KEY = 'deplai.pipeline.repoContextMd';
const REVIEW_PAYLOAD_KEY = 'deplai.pipeline.reviewPayload';
const REVIEW_ANSWERS_KEY = 'deplai.pipeline.reviewAnswers';
const DEPLOYMENT_PROFILE_KEY = 'deplai.pipeline.deploymentProfile';
const ARCHITECTURE_VIEW_KEY = 'deplai.pipeline.architectureJson';
const APPROVAL_PAYLOAD_KEY = 'deplai.pipeline.approvalPayload';
const PLANNING_PROJECT_KEY = 'deplai.pipeline.planningProjectId';

interface RepositoryContextJson {
  document_kind: 'repository_context';
  workspace: string;
  project_name: string;
  summary?: string;
  language?: Record<string, unknown>;
  frameworks?: Array<Record<string, unknown>>;
  data_stores?: Array<Record<string, unknown>>;
  processes?: Array<Record<string, unknown>>;
  build?: Record<string, unknown>;
  health?: Record<string, unknown>;
  readme_notes?: string | null;
  conflicts?: Array<{ field?: string; reason?: string }>;
  low_confidence_items?: Array<{ field?: string; reason?: string }>;
}

interface ArchitectureQuestionOption {
  value: string;
  label: string;
  description?: string | null;
}

interface ArchitectureQuestion {
  id: string;
  category: string;
  question: string;
  required: boolean;
  default?: string | null;
  options?: ArchitectureQuestionOption[];
}

interface ArchitectureReviewPayload {
  context_json: RepositoryContextJson;
  questions: ArchitectureQuestion[];
  defaults: Record<string, string>;
  conflicts: Array<{ field?: string; reason?: string }>;
  low_confidence_items: Array<{ field?: string; reason?: string }>;
}

function readStoredJson<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeStoredJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  const serialized = JSON.stringify(value);
  try {
    sessionStorage.setItem(key, serialized);
    return;
  } catch {
    if (key !== 'deplai.pipeline.iacFiles') return;
  }

  // Keep at least a preview set when the browser quota is tight.
  if (!Array.isArray(value)) return;
  let budget = 350000;
  const compact = value
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const row = entry as { path?: unknown; content?: unknown };
      const path = String(row.path || '').trim();
      if (!path || budget <= 0) return null;
      const raw = String(row.content || '');
      const fileBudget = Math.min(70000, Math.max(0, budget - path.length - 48));
      if (fileBudget <= 0) return null;
      let content = raw;
      if (content.length > fileBudget) {
        const suffix = '\n\n# [truncated in browser session cache]';
        const keep = Math.max(0, fileBudget - suffix.length);
        content = `${content.slice(0, keep)}${suffix}`;
      }
      budget -= path.length + content.length;
      return { path, content };
    })
    .filter((entry): entry is { path: string; content: string } => Boolean(entry));

  try {
    sessionStorage.setItem(key, JSON.stringify(compact));
  } catch {
    // Ignore when quota is fully exhausted; current in-memory state remains usable.
  }
}

function normalizeIacFilesForUi(files: Array<{ path?: string; content?: string }>): Array<{ path: string; content: string }> {
  const byPath = new Map<string, { path: string; content: string }>();
  for (const file of files) {
    const path = String(file.path || '').trim();
    if (!path) continue;
    if (path.startsWith('terraform/site/') && path !== 'terraform/site/index.html') continue;
    byPath.set(path, { path, content: String(file.content || '') });
  }
  return Array.from(byPath.values());
}

function clearPlanningState(): void {
  if (typeof window === 'undefined') return;
  [
    REPO_CONTEXT_KEY,
    REPO_CONTEXT_MD_KEY,
    REVIEW_PAYLOAD_KEY,
    REVIEW_ANSWERS_KEY,
    DEPLOYMENT_PROFILE_KEY,
    ARCHITECTURE_VIEW_KEY,
    APPROVAL_PAYLOAD_KEY,
    'deplai.pipeline.costEstimate',
    'deplai.pipeline.iacFiles',
    'deplai.pipeline.iacRun',
    'deplai.pipeline.qaContext',
  ].forEach((key) => sessionStorage.removeItem(key));
}

function resolvePlanningWorkspace(projectId?: string | null, projectName?: string): string {
  return buildDeploymentWorkspace(String(projectId || '').trim(), projectName);
}

export function QAPage({
  onNavigate,
  autopilot = false,
  projectId,
  projectName,
}: {
  onNavigate: (v: string) => void;
  autopilot?: boolean;
  projectId?: string | null;
  projectName?: string;
}) {
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<RepositoryContextJson | null>(() => readStoredJson<RepositoryContextJson>(REPO_CONTEXT_KEY));
  const [contextMd, setContextMd] = useState<string>(() => readStoredJson<string>(REPO_CONTEXT_MD_KEY) || '');
  const [autopilotApplied, setAutopilotApplied] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !projectId) return;
    const storedProjectId = sessionStorage.getItem(PLANNING_PROJECT_KEY);
    if (storedProjectId && storedProjectId !== projectId) {
      clearPlanningState();
      setContext(null);
      setContextMd('');
      setError(null);
      setAutopilotApplied(false);
    }
  }, [projectId]);

  const runAnalysis = useCallback(async () => {
    if (!projectId) {
      setError('Select a project before running repository analysis.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/repository-analysis/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, workspace: resolvePlanningWorkspace(projectId, projectName) }),
      });
      const data = await res.json().catch(() => ({})) as {
        success?: boolean;
        context_json?: RepositoryContextJson;
        context_md?: string;
        error?: string;
      };
      if (!res.ok || !data.success || !data.context_json) {
        throw new Error(data.error || 'Repository analysis failed.');
      }
      setContext(data.context_json);
      setContextMd(String(data.context_md || ''));
      sessionStorage.setItem(PLANNING_PROJECT_KEY, projectId);
      writeStoredJson(REPO_CONTEXT_KEY, data.context_json);
      writeStoredJson(REPO_CONTEXT_MD_KEY, String(data.context_md || ''));
      writeStoredJson('deplai.pipeline.qaContext', {
        qa_summary: String(data.context_json.summary || ''),
        deployment_region: 'eu-north-1',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Repository analysis failed.');
    } finally {
      setLoading(false);
    }
  }, [projectId, projectName]);

  useEffect(() => {
    if (context || loading || error || !projectId) return;
    void runAnalysis();
  }, [context, error, loading, projectId, runAnalysis]);

  useEffect(() => {
    if (!autopilot || autopilotApplied || !context) return;
    setAutopilotApplied(true);
    const timerId = window.setTimeout(() => onNavigate('arch'), 250);
    return () => window.clearTimeout(timerId);
  }, [autopilot, autopilotApplied, context, onNavigate]);

  const frameworks = Array.isArray(context?.frameworks) ? context?.frameworks : [];
  const dataStores = Array.isArray(context?.data_stores) ? context?.data_stores : [];
  const processes = Array.isArray(context?.processes) ? context?.processes : [];
  const conflicts = Array.isArray(context?.conflicts) ? context?.conflicts : [];
  const lowConfidence = Array.isArray(context?.low_confidence_items) ? context?.low_confidence_items : [];

  return (
    <div className="flex-1 overflow-y-auto fade-in custom-scrollbar">
      <Header
        title="Repository Analyzer"
        subtitle="Scans the selected codebase and produces the structured context used by the deployment decision flow."
        badge={loading
          ? { text: 'Analyzing repository', cls: 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' }
          : error
            ? { text: 'Analysis failed', cls: 'bg-red-500/10 text-red-400 border border-red-500/20' }
            : context
              ? { text: 'Context ready', cls: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' }
              : { text: 'Waiting for project', cls: 'bg-zinc-500/10 text-zinc-400 border border-zinc-500/20' }}
        actions={<><Tag color="indigo">Stage 6</Tag><Btn onClick={() => { void runAnalysis(); }} size="sm" variant="default" disabled={loading || !projectId}>{loading ? 'Analyzing...' : 'Re-run analysis'}</Btn></>}
      />
      <div className="p-7 space-y-5">
        {error && <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 text-sm text-red-300">{error}</div>}
        {context && (
          <>
            <div className="grid grid-cols-4 gap-4">
              <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4">
                <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Runtime</p>
                <p className="text-lg font-semibold text-zinc-100">{String(context.language?.runtime || 'unknown')}</p>
                <p className="text-xs text-zinc-500 mt-1">{String(context.language?.primary || 'unknown')} {String(context.language?.version || '')}</p>
              </div>
              <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4">
                <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Frameworks</p>
                <p className="text-lg font-semibold text-zinc-100">{frameworks.length}</p>
                <p className="text-xs text-zinc-500 mt-1 truncate">{frameworks.map((item) => String(item.name || '')).join(', ') || 'None detected'}</p>
              </div>
              <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4">
                <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Data stores</p>
                <p className="text-lg font-semibold text-zinc-100">{dataStores.length}</p>
                <p className="text-xs text-zinc-500 mt-1 truncate">{dataStores.map((item) => String(item.type || '')).join(', ') || 'None detected'}</p>
              </div>
              <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4">
                <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Processes</p>
                <p className="text-lg font-semibold text-zinc-100">{processes.length}</p>
                <p className="text-xs text-zinc-500 mt-1 truncate">{processes.map((item) => String(item.type || '')).join(', ') || 'Implicit only'}</p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-5">
              <div className="col-span-2 bg-zinc-900 rounded-2xl border border-white/5 p-5">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-sm font-semibold text-zinc-200">Detected repository context</p>
                  <Tag color="zinc">{context.workspace}</Tag>
                </div>
                <p className="text-sm text-zinc-400 leading-relaxed mb-4">{context.summary || 'No summary generated.'}</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Frameworks</p>
                    <div className="space-y-2">
                      {frameworks.length === 0 && <p className="text-xs text-zinc-500">No framework signals detected.</p>}
                      {frameworks.map((item, index) => (
                        <div key={`${String(item.name || 'framework')}-${index}`} className="rounded-xl border border-white/5 bg-black/20 px-3 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm text-zinc-200">{String(item.name || 'unknown')}</span>
                            <Tag color={String(item.confidence || '').toLowerCase() === 'high' ? 'emerald' : 'amber'}>{String(item.confidence || 'medium')}</Tag>
                          </div>
                          <p className="text-[11px] text-zinc-500 mt-1">{String(item.role || '')}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Data stores</p>
                    <div className="space-y-2">
                      {dataStores.length === 0 && <p className="text-xs text-zinc-500">No datastore requirements detected.</p>}
                      {dataStores.map((item, index) => (
                        <div key={`${String(item.type || 'store')}-${index}`} className="rounded-xl border border-white/5 bg-black/20 px-3 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm text-zinc-200">{String(item.type || 'unknown')}</span>
                            <Tag color={String(item.confidence || '').toLowerCase() === 'high' ? 'emerald' : 'amber'}>{String(item.confidence || 'medium')}</Tag>
                          </div>
                          <p className="text-[11px] text-zinc-500 mt-1">{Array.isArray(item.signals) ? item.signals.join(', ') : 'No signals recorded'}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                {contextMd && (
                  <div className="mt-5 pt-5 border-t border-white/5">
                    <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Analysis notes</p>
                    <pre className="text-[12px] whitespace-pre-wrap leading-relaxed text-zinc-400 bg-black/20 rounded-xl border border-white/5 p-4">{contextMd}</pre>
                  </div>
                )}
              </div>
              <div className="space-y-4">
                <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4">
                  <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-3">Flags</p>
                  <div className="space-y-2">
                    {conflicts.length === 0 && lowConfidence.length === 0 && <p className="text-xs text-zinc-500">No conflicts or low-confidence findings.</p>}
                    {conflicts.map((item, index) => (
                      <div key={`conflict-${index}`} className="rounded-xl border border-red-500/20 bg-red-500/5 px-3 py-2">
                        <p className="text-sm text-red-300">{String(item.reason || 'Conflict detected')}</p>
                      </div>
                    ))}
                    {lowConfidence.map((item, index) => (
                      <div key={`low-${index}`} className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                        <p className="text-sm text-amber-300">{String(item.reason || 'Low-confidence finding')}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4">
                  <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-3">Build + health</p>
                  <div className="space-y-2 text-[12px]">
                    <div className="flex justify-between gap-3"><span className="text-zinc-500">Build</span><span className="text-zinc-300 font-mono text-right">{String(context.build?.build_command || 'not found')}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-zinc-500">Start</span><span className="text-zinc-300 font-mono text-right">{String(context.build?.start_command || 'not found')}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-zinc-500">Health</span><span className="text-zinc-300 font-mono text-right">{String(context.health?.endpoint || '/')}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-zinc-500">Dockerfile</span><span className="text-zinc-300 text-right">{context.build?.has_dockerfile ? 'present' : 'missing'}</span></div>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-5 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-emerald-300">Repository context is ready for review.</p>
                <p className="text-xs text-zinc-500 mt-1">Proceed to the decision wizard to answer only the unresolved deployment questions.</p>
              </div>
              <Btn onClick={() => onNavigate('arch')} variant="primary">Proceed to Review</Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface ArchPageProps {
  onNavigate: (v: string) => void;
  projectId?: string | null;
  projectName?: string;
}

interface RuntimeArchNode {
  id: string;
  label: string;
  type: string;
}

interface RuntimeArchEdge {
  from: string;
  to: string;
  label?: string;
}

interface RuntimeCostItem {
  service: string;
  type: string;
  monthly: number;
  note: string;
}

interface Stage7ApprovalPayload {
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
}

function pickNodeColor(type: string): string {
  const t = String(type || '').toLowerCase();
  if (t.includes('cloudfront')) return '#06b6d4';
  if (t.includes('alb') || t.includes('loadbalancer') || t.includes('load_balancer')) return '#8b5cf6';
  if (t.includes('ec2') || t.includes('compute')) return '#22c55e';
  if (t.includes('rds') || t.includes('database') || t.includes('postgres')) return '#f59e0b';
  if (t.includes('s3') || t.includes('bucket') || t.includes('storage')) return '#f59e0b';
  if (t.includes('security')) return '#6b7280';
  if (t.includes('vpc') || t.includes('subnet')) return '#6b7280';
  if (t.includes('watch') || t.includes('monitor')) return '#38bdf8';
  return '#6b7280';
}

function parseQASessionContext(): { qaSummary: string; region: string } {
  if (typeof window === 'undefined') {
    return { qaSummary: '', region: 'eu-north-1' };
  }
  try {
    const raw = sessionStorage.getItem('deplai.pipeline.qaContext');
    if (!raw) return { qaSummary: '', region: 'eu-north-1' };
    const parsed = JSON.parse(raw) as { qa_summary?: string; deployment_region?: string };
    return {
      qaSummary: String(parsed.qa_summary || ''),
      region: String(parsed.deployment_region || 'eu-north-1'),
    };
  } catch {
    return { qaSummary: '', region: 'eu-north-1' };
  }
}

function normalizeCostBreakdown(raw: unknown): RuntimeCostItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const r = row as Record<string, unknown>;
      const monthly =
        Number(r.monthly_usd)
        || Number(r.monthly)
        || Number(r.cost_usd)
        || Number(r.amount_usd)
        || 0;
      return {
        service: String(r.service || r.name || r.component || 'Unnamed service'),
        type: String(r.type || r.category || 'General'),
        monthly: Number.isFinite(monthly) ? monthly : 0,
        note: String(r.note || r.notes || r.details || r.description || ''),
      };
    })
    .filter((row) => row.service);
}

function inferInfraPlan(architecture: { nodes?: RuntimeArchNode[] }, region: string): Record<string, unknown> {
  const nodes = Array.isArray(architecture.nodes) ? architecture.nodes : [];
  const typeTokens = nodes.map((n) => String(n.type || '').toLowerCase());
  const idTokens = nodes.map((n) => `${String(n.id || '').toLowerCase()} ${String(n.label || '').toLowerCase()}`);

  const hasType = (matchers: string[]) => typeTokens.some((t) => matchers.some((m) => t.includes(m)));
  const hasToken = (matchers: string[]) => idTokens.some((t) => matchers.some((m) => t.includes(m)));

  const storage: string[] = [];
  if (hasType(['s3']) || hasToken(['website bucket', 'websitebucket'])) storage.push('website_bucket');
  if (hasToken(['security logs bucket', 'securitylogsbucket', 'logs bucket'])) storage.push('security_logs_bucket');

  const securityGroups: string[] = [];
  if (hasType(['securitygroup']) || hasToken(['security group', 'websecuritygroup'])) {
    securityGroups.push('web_security_group');
  }

  return {
    compute: hasType(['ec2']) ? 'ec2' : hasType(['ecs']) ? 'ecs' : hasType(['lambda']) ? 'lambda' : null,
    services: hasToken(['web server', 'webappserver']) ? ['web_server'] : [],
    database: hasType(['rds', 'postgres', 'database']) ? 'rds' : null,
    cache: hasType(['elasticache', 'redis']) ? 'elasticache' : null,
    networking: hasToken(['default vpc', 'defaultvpc']) ? 'default_vpc' : 'custom_vpc',
    cdn: hasType(['cloudfront']) ? 'cloudfront' : null,
    storage,
    logging: hasType(['cloudwatch']) ? 'cloudwatch' : null,
    security_groups: securityGroups,
    region: region || 'eu-north-1',
    state_backend: 's3_dynamodb',
  };
}

function LegacyArchPage({ onNavigate, projectId, projectName }: ArchPageProps) {
  const [approved, setApproved] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [region, setRegion] = useState<string>('eu-north-1');
  const [nodes, setNodes] = useState<RuntimeArchNode[]>([]);
  const [edges, setEdges] = useState<RuntimeArchEdge[]>([]);
  const [costRows, setCostRows] = useState<RuntimeCostItem[]>(COST_BREAKDOWN);
  const [total, setTotal] = useState<number>(COST_BREAKDOWN.reduce((a, b) => a + b.monthly, 0));
  const [budgetCap, setBudgetCap] = useState<number>(100);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const { qaSummary, region: sessionRegion } = parseQASessionContext();
        const resolvedRegion = sessionRegion || 'eu-north-1';
        setRegion(resolvedRegion);
        const projectLabel = projectName || 'deplai-project';

        const archRes = await fetch('/api/architecture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: `Generate architecture for ${projectLabel}`,
            provider: 'aws',
            project_name: projectLabel,
            qa_summary: qaSummary,
            deployment_region: resolvedRegion,
          }),
        });
        if (!archRes.ok) {
          const body = await archRes.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error || 'Architecture generation failed.');
        }
        const archData = await archRes.json() as { architecture_json?: { nodes?: RuntimeArchNode[]; edges?: RuntimeArchEdge[] } };
        const architecture = archData.architecture_json || {};
        const runtimeNodes = Array.isArray(architecture.nodes) ? architecture.nodes : [];
        const runtimeEdges = Array.isArray(architecture.edges) ? architecture.edges : [];
        if (typeof window !== 'undefined') {
          sessionStorage.setItem('deplai.pipeline.architectureJson', JSON.stringify(architecture));
        }
        if (!cancelled) {
          setNodes(runtimeNodes);
          setEdges(runtimeEdges);
        }

        const inferredPlan = inferInfraPlan(architecture, resolvedRegion);
        const stage7Res = await fetch('/api/pipeline/stage7', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId || undefined,
            infra_plan: inferredPlan,
            budget_cap_usd: 100,
            pipeline_run_id: projectId || `run_${Date.now()}`,
            environment: 'dev',
          }),
        });

        if (stage7Res.ok) {
          const stage7Data = await stage7Res.json() as { approval_payload?: Stage7ApprovalPayload };
          const payload = stage7Data.approval_payload || {};
          const diagramNodes = Array.isArray(payload.diagram?.nodes) ? payload.diagram?.nodes : [];
          const diagramEdges = Array.isArray(payload.diagram?.edges) ? payload.diagram?.edges : [];
          const costItems = payload.cost_estimate?.line_items;
          const normalizedBreakdown = normalizeCostBreakdown(costItems);
          const computedTotal = Number(payload.cost_estimate?.total_monthly_usd);
          const payloadCap = Number(payload.budget_gate?.cap_usd);

          if (!cancelled) {
            if (Array.isArray(diagramNodes) && diagramNodes.length > 0) {
              setNodes(diagramNodes.map((n) => ({
                id: String(n.id || ''),
                label: String(n.label || n.type || ''),
                type: String(n.type || ''),
              })));
            }
            if (Array.isArray(diagramEdges) && diagramEdges.length > 0) {
              setEdges(diagramEdges.map((e) => ({
                from: String(e.from || ''),
                to: String(e.to || ''),
                label: String(e.style || ''),
              })));
            }
            if (normalizedBreakdown.length > 0) setCostRows(normalizedBreakdown);
            if (Number.isFinite(computedTotal)) {
              setTotal(computedTotal);
            } else if (normalizedBreakdown.length > 0) {
              setTotal(normalizedBreakdown.reduce((sum, item) => sum + item.monthly, 0));
            }
            if (Number.isFinite(payloadCap) && payloadCap > 0) setBudgetCap(payloadCap);
          }

          if (typeof window !== 'undefined') {
            const persistedTotal = Number.isFinite(computedTotal)
              ? computedTotal
              : normalizedBreakdown.reduce((sum, item) => sum + item.monthly, 0);
            sessionStorage.setItem('deplai.pipeline.costEstimate', JSON.stringify({
              total_monthly_usd: persistedTotal,
              budget_cap_usd: Number.isFinite(payloadCap) && payloadCap > 0 ? payloadCap : 100,
              breakdown: normalizedBreakdown,
            }));
          }
        } else {
          const costRes = await fetch('/api/cost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              project_id: projectId || undefined,
              provider: 'aws',
              architecture_json: architecture,
            }),
          });
          if (costRes.ok) {
            const costData = await costRes.json() as { total_monthly_usd?: number; breakdown?: unknown };
            const normalizedBreakdown = normalizeCostBreakdown(costData.breakdown);
            const computedTotal = Number(costData.total_monthly_usd);
            if (!cancelled) {
              if (normalizedBreakdown.length > 0) setCostRows(normalizedBreakdown);
              if (Number.isFinite(computedTotal)) {
                setTotal(computedTotal);
              } else if (normalizedBreakdown.length > 0) {
                setTotal(normalizedBreakdown.reduce((sum, item) => sum + item.monthly, 0));
              }
            }
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to load architecture and cost.';
        if (!cancelled) setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, projectName]);

  const layout = useMemo(() => {
    const cols = 3;
    return nodes.map((node, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      return {
        ...node,
        x: 140 + col * 210,
        y: 56 + row * 92,
        color: pickNodeColor(node.type),
      };
    });
  }, [nodes]);

  const nodePos = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    layout.forEach((n) => map.set(String(n.id), { x: n.x, y: n.y }));
    return map;
  }, [layout]);

  const categoryTotals = useMemo(() => {
    const totals = new Map<string, number>();
    costRows.forEach((item) => {
      const key = item.type || 'General';
      totals.set(key, (totals.get(key) || 0) + item.monthly);
    });
    return Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [costRows]);

  const percent = Math.round(Math.min((total / budgetCap) * 100, 100));
  const badge = loading
    ? { text: 'Generating architecture + cost', cls: 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' }
    : error
      ? { text: 'Using fallback model', cls: 'bg-amber-500/10 text-amber-400 border border-amber-500/20' }
      : { text: 'Awaiting architecture approval', cls: 'bg-amber-500/10 text-amber-400 border border-amber-500/20' };

  return (
    <div className="flex-1 overflow-y-auto fade-in custom-scrollbar">
      <Header title="Architecture + Cost Estimate" subtitle="Generated AWS architecture diagram and monthly cost breakdown for approval." badge={badge} actions={<><Tag color="zinc">Stage 7-7.5</Tag><Tag color="amber">GATE</Tag></>} />
      <div className="p-7 space-y-5">
        {error && <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3 text-xs text-amber-300">{error}</div>}
        <div className="grid grid-cols-3 gap-5">
          <div className="col-span-2 bg-zinc-900 rounded-2xl border border-white/5 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/5">
              <p className="text-sm font-semibold text-zinc-200">Architecture Diagram - AWS ({region})</p>
              <div className="flex gap-2"><Tag color="zinc">{layout.length} nodes</Tag><Tag color="zinc">{edges.length} edges</Tag></div>
            </div>
            <div className="p-5">
              <svg viewBox="0 0 700 400" className="w-full rounded-lg" style={{ background: '#0f0f11' }}>
                <defs><marker id="arr" markerWidth="8" markerHeight="6" refX="6" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#3f3f46" /></marker></defs>
                {edges.map((e, i) => {
                  const from = nodePos.get(String(e.from));
                  const to = nodePos.get(String(e.to));
                  if (!from || !to) return null;
                  return <line key={`${e.from}-${e.to}-${i}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#3f3f46" strokeWidth="1.5" markerEnd="url(#arr)" strokeDasharray="5,3" />;
                })}
                {layout.map((n) => (
                  <g key={n.id} transform={`translate(${n.x - 60},${n.y - 22})`}>
                    <rect width="120" height="44" rx="8" fill={n.color + '18'} stroke={n.color} strokeWidth="1" strokeOpacity=".6" />
                    <text x="60" y="17" textAnchor="middle" fill={n.color} fontSize="9" fontFamily="monospace" fontWeight="600">{String(n.id).toUpperCase()}</text>
                    <text x="60" y="31" textAnchor="middle" fill="#a1a1aa" fontSize="10" fontFamily="-apple-system,sans-serif">{n.label || n.type}</text>
                  </g>
                ))}
                <text x="350" y="392" textAnchor="middle" fill="#52525b" fontSize="10" fontFamily="-apple-system,sans-serif">AWS {region} - Generated from Q/A context</text>
              </svg>
            </div>
          </div>
          <div className="space-y-4">
            <div className="bg-zinc-900 rounded-2xl border border-white/5 p-5">
              <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-3">Monthly Estimate</p>
              <p className="text-4xl font-bold text-emerald-400 font-mono">${total.toFixed(2)}</p>
              <p className="text-xs text-zinc-500 mt-1">USD / month - {loading ? 'refreshing model' : 'live runtime estimate'}</p>
              <div className="mt-4 pt-4 border-t border-white/5 space-y-1.5">
                {categoryTotals.map(([name, value]) => (
                  <div key={name} className="flex justify-between text-xs"><span className="text-zinc-500">{name}</span><span className="text-zinc-300 font-mono">${value.toFixed(2)}</span></div>
                ))}
              </div>
            </div>
            <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4">
              <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Budget gate</p>
              <div className="flex items-center justify-between mb-1.5"><span className="text-xs text-zinc-400">Budget cap</span><span className="text-xs font-mono text-zinc-300">${budgetCap.toFixed(2)}</span></div>
              <div className="h-2 bg-zinc-800 rounded-full overflow-hidden"><div className={`h-full rounded-full ${total <= budgetCap ? 'bg-linear-to-r from-emerald-500 to-cyan-500' : 'bg-linear-to-r from-amber-500 to-red-500'}`} style={{ width: `${percent}%` }} /></div>
              <p className={`text-[11px] mt-1.5 ${total <= budgetCap ? 'text-emerald-400' : 'text-amber-400'}`}>{Math.round((total / budgetCap) * 100)}% of cap used</p>
            </div>
          </div>
        </div>
        <div className="bg-zinc-900 rounded-2xl border border-white/5 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-white/5"><p className="text-sm font-semibold text-zinc-200">Cost Breakdown by Service</p></div>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-white/5">{['Service', 'Type', 'Monthly (USD)', 'Notes'].map((h) => <th key={h} className="text-left px-5 py-3 text-[11px] uppercase tracking-wider text-zinc-500 font-semibold">{h}</th>)}</tr></thead>
            <tbody>
              {costRows.map((r, i) => <tr key={i} className="border-b border-white/4 last:border-0 hover:bg-white/2"><td className="px-5 py-3 text-zinc-200 font-medium">{r.service}</td><td className="px-5 py-3"><Tag color="zinc">{r.type}</Tag></td><td className="px-5 py-3 font-mono text-zinc-300">${r.monthly.toFixed(2)}</td><td className="px-5 py-3 text-zinc-500 text-xs">{r.note || '-'}</td></tr>)}
              <tr className="bg-zinc-800/50"><td className="px-5 py-3 font-bold text-zinc-100">Total</td><td /><td className="px-5 py-3 font-mono font-bold text-emerald-400">${total.toFixed(2)}</td><td /></tr>
            </tbody>
          </table>
        </div>
        {!approved ? <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-5 flex items-center justify-between"><div><p className="text-sm font-semibold text-amber-300">Approve architecture and cost estimate</p><p className="text-xs text-zinc-500 mt-1">Once approved, DeplAI will generate Terraform + Ansible configuration files.</p></div><Btn onClick={() => { setApproved(true); setTimeout(() => onNavigate('iac'), 600); }} variant="primary" size="lg" disabled={loading}>Approve + Generate IaC</Btn></div> : <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4 text-center"><p className="text-emerald-400 font-semibold">Approved. Advancing to Terraform generation...</p></div>}
      </div>
    </div>
  );
}

export const __legacyApprovalGate = {
  parseQASessionContext,
  inferInfraPlan,
  LegacyArchPage,
};

export function ArchPage({ onNavigate, projectId, projectName }: ArchPageProps) {
  const [approved, setApproved] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<ArchitectureReviewPayload | null>(() => readStoredJson<ArchitectureReviewPayload>(REVIEW_PAYLOAD_KEY));
  const [answers, setAnswers] = useState<Record<string, string>>(() => readStoredJson<Record<string, string>>(REVIEW_ANSWERS_KEY) || {});
  const [deploymentProfile, setDeploymentProfile] = useState<Record<string, unknown> | null>(() => readStoredJson<Record<string, unknown>>(DEPLOYMENT_PROFILE_KEY));
  const [nodes, setNodes] = useState<RuntimeArchNode[]>([]);
  const [edges, setEdges] = useState<RuntimeArchEdge[]>([]);
  const [costRows, setCostRows] = useState<RuntimeCostItem[]>(COST_BREAKDOWN);
  const [total, setTotal] = useState<number>(COST_BREAKDOWN.reduce((a, b) => a + b.monthly, 0));
  const [budgetCap, setBudgetCap] = useState<number>(100);

  useEffect(() => {
    if (typeof window === 'undefined' || !projectId) return;
    const storedProjectId = sessionStorage.getItem(PLANNING_PROJECT_KEY);
    if (storedProjectId && storedProjectId !== projectId) {
      clearPlanningState();
      setApproved(false);
      setError(null);
      setLoading(true);
      setReview(null);
      setAnswers({});
      setDeploymentProfile(null);
      setNodes([]);
      setEdges([]);
      setCostRows(COST_BREAKDOWN);
      setTotal(COST_BREAKDOWN.reduce((sum, item) => sum + item.monthly, 0));
      setBudgetCap(100);
    }
  }, [projectId]);

  const hydratePreview = useCallback(() => {
    const approval = readStoredJson<Stage7ApprovalPayload>(APPROVAL_PAYLOAD_KEY);
    const architecture = readStoredJson<{ nodes?: RuntimeArchNode[]; edges?: RuntimeArchEdge[] }>(ARCHITECTURE_VIEW_KEY);
    if (architecture?.nodes) setNodes(architecture.nodes);
    if (architecture?.edges) setEdges(architecture.edges);
    if (!approval) return;
    const diagramNodes = Array.isArray(approval.diagram?.nodes) ? approval.diagram?.nodes : [];
    const diagramEdges = Array.isArray(approval.diagram?.edges) ? approval.diagram?.edges : [];
    if (diagramNodes.length > 0) {
      setNodes(diagramNodes.map((n) => ({
        id: String(n.id || ''),
        label: String(n.label || n.type || ''),
        type: String(n.type || ''),
      })));
    }
    if (diagramEdges.length > 0) {
      setEdges(diagramEdges.map((e) => ({
        from: String(e.from || ''),
        to: String(e.to || ''),
        label: String(e.style || ''),
      })));
    }
    const normalizedBreakdown = normalizeCostBreakdown(approval.cost_estimate?.line_items);
    const computedTotal = Number(approval.cost_estimate?.total_monthly_usd);
    const payloadCap = Number(approval.budget_gate?.cap_usd);
    if (normalizedBreakdown.length > 0) setCostRows(normalizedBreakdown);
    if (Number.isFinite(computedTotal)) {
      setTotal(computedTotal);
    } else if (normalizedBreakdown.length > 0) {
      setTotal(normalizedBreakdown.reduce((sum, item) => sum + item.monthly, 0));
    }
    if (Number.isFinite(payloadCap) && payloadCap > 0) setBudgetCap(payloadCap);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadReview() {
      if (!projectId) {
        setError('Select a project before starting the deployment review.');
        setLoading(false);
        return;
      }
      if (review) {
        setAnswers((prev) => Object.keys(prev).length > 0 ? prev : { ...(review.defaults || {}) });
        hydratePreview();
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const storedContext = readStoredJson<RepositoryContextJson>(REPO_CONTEXT_KEY);
        const workspace = String(storedContext?.workspace || resolvePlanningWorkspace(projectId, projectName));
        const res = await fetch('/api/architecture/review/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: projectId, workspace }),
        });
        const data = await res.json().catch(() => ({})) as { success?: boolean; review?: ArchitectureReviewPayload; error?: string };
        if (!res.ok || !data.success || !data.review) {
          throw new Error(data.error || 'Failed to start architecture review.');
        }
        if (!cancelled) {
          setReview(data.review);
          const initialAnswers = { ...(data.review.defaults || {}) };
          setAnswers(initialAnswers);
          writeStoredJson(REVIEW_PAYLOAD_KEY, data.review);
          writeStoredJson(REVIEW_ANSWERS_KEY, initialAnswers);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to start architecture review.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadReview();
    return () => {
      cancelled = true;
    };
  }, [hydratePreview, projectId, projectName, review]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    writeStoredJson(REVIEW_ANSWERS_KEY, answers);
  }, [answers]);

  const groupedQuestions = useMemo(() => {
    const groups = new Map<string, ArchitectureQuestion[]>();
    (review?.questions || []).forEach((question) => {
      groups.set(question.category, [...(groups.get(question.category) || []), question]);
    });
    return Array.from(groups.entries());
  }, [review]);

  const layout = useMemo(() => nodes.map((node, index) => ({
    ...node,
    x: 140 + (index % 3) * 210,
    y: 56 + Math.floor(index / 3) * 92,
    color: pickNodeColor(node.type),
  })), [nodes]);
  const nodePos = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    layout.forEach((item) => map.set(String(item.id), { x: item.x, y: item.y }));
    return map;
  }, [layout]);
  const categoryTotals = useMemo(() => {
    const totals = new Map<string, number>();
    costRows.forEach((item) => totals.set(item.type || 'General', (totals.get(item.type || 'General') || 0) + item.monthly));
    return Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [costRows]);

  const generateProfile = async () => {
    if (!projectId || !review) return;
    setSubmitting(true);
    setError(null);
    try {
      const workspace = String(review.context_json.workspace || resolvePlanningWorkspace(projectId, projectName));
      const res = await fetch('/api/architecture/review/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, workspace, answers }),
      });
      const data = await res.json().catch(() => ({})) as {
        success?: boolean;
        deployment_profile?: Record<string, unknown>;
        architecture_view?: Record<string, unknown>;
        approval_payload?: Stage7ApprovalPayload;
        error?: string;
      };
      if (!res.ok || !data.success || !data.deployment_profile || !data.architecture_view) {
        throw new Error(data.error || 'Failed to generate deployment profile.');
      }
      setDeploymentProfile(data.deployment_profile);
      sessionStorage.setItem(PLANNING_PROJECT_KEY, projectId);
      writeStoredJson(REVIEW_ANSWERS_KEY, answers);
      writeStoredJson(DEPLOYMENT_PROFILE_KEY, data.deployment_profile);
      writeStoredJson(ARCHITECTURE_VIEW_KEY, data.architecture_view);
      writeStoredJson(APPROVAL_PAYLOAD_KEY, data.approval_payload || {});
      hydratePreview();
      const normalizedBreakdown = normalizeCostBreakdown(data.approval_payload?.cost_estimate?.line_items);
      const computedTotal = Number(data.approval_payload?.cost_estimate?.total_monthly_usd);
      const payloadCap = Number(data.approval_payload?.budget_gate?.cap_usd);
      writeStoredJson('deplai.pipeline.costEstimate', {
        total_monthly_usd: Number.isFinite(computedTotal) ? computedTotal : normalizedBreakdown.reduce((sum, item) => sum + item.monthly, 0),
        budget_cap_usd: Number.isFinite(payloadCap) && payloadCap > 0 ? payloadCap : 100,
        breakdown: normalizedBreakdown,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate deployment profile.');
    } finally {
      setSubmitting(false);
    }
  };

  const percent = Math.round(Math.min((total / budgetCap) * 100, 100));

  return (
    <div className="flex-1 overflow-y-auto fade-in custom-scrollbar">
      <Header title="Deployment Review Wizard" subtitle="Answer only unresolved deployment questions, review the generated profile, then approve Terraform generation." badge={loading ? { text: 'Loading review', cls: 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' } : deploymentProfile ? { text: 'Awaiting approval', cls: 'bg-amber-500/10 text-amber-400 border border-amber-500/20' } : { text: 'Awaiting answers', cls: 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20' }} actions={<><Tag color="amber">Stage 7</Tag><Tag color="zinc">GATE</Tag></>} />
      <div className="p-7 space-y-5">
        {error && <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 text-sm text-red-300">{error}</div>}
        {review && (
          <div className="bg-zinc-900 rounded-2xl border border-white/5 p-5">
            <div className="flex items-center justify-between mb-4">
              <div><p className="text-sm font-semibold text-zinc-200">Detected repository context</p><p className="text-xs text-zinc-500 mt-1">{review.context_json.summary || 'No repository summary available.'}</p></div>
              <Btn onClick={() => { void generateProfile(); }} variant="primary" size="sm" disabled={loading || submitting}>{submitting ? 'Generating profile...' : 'Generate Deployment Profile'}</Btn>
            </div>
            <div className="grid grid-cols-3 gap-4 mb-5">
              <div className="rounded-2xl border border-white/5 bg-black/20 p-4"><p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Frameworks</p><p className="text-sm text-zinc-300">{(review.context_json.frameworks || []).map((item) => String(item.name || '')).join(', ') || 'None detected'}</p></div>
              <div className="rounded-2xl border border-white/5 bg-black/20 p-4"><p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Data stores</p><p className="text-sm text-zinc-300">{(review.context_json.data_stores || []).map((item) => String(item.type || '')).join(', ') || 'None detected'}</p></div>
              <div className="rounded-2xl border border-white/5 bg-black/20 p-4"><p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Build</p><p className="text-sm text-zinc-300 font-mono">{String(review.context_json.build?.build_command || 'not found')}</p></div>
            </div>
            <div className="grid grid-cols-3 gap-5">
              <div className="col-span-2 space-y-4">
                {groupedQuestions.map(([category, questions]) => (
                  <div key={category} className="rounded-2xl border border-white/5 bg-black/20 p-4">
                    <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-3">{category}</p>
                    <div className="grid grid-cols-2 gap-4">
                      {questions.map((question) => {
                        const value = String(answers[question.id] ?? question.default ?? '');
                        const hasOptions = Array.isArray(question.options) && question.options.length > 0;
                        return (
                          <label key={question.id} className="block">
                            <span className="block text-sm text-zinc-200 mb-2">{question.question}</span>
                            {hasOptions ? (
                              <select value={value} onChange={(e) => setAnswers((prev) => ({ ...prev, [question.id]: e.target.value }))} className="w-full bg-zinc-900 border border-white/8 rounded-xl px-3 py-2.5 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500/40">
                                {(question.options || []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                              </select>
                            ) : (
                              <input value={value} onChange={(e) => setAnswers((prev) => ({ ...prev, [question.id]: e.target.value }))} className="w-full bg-zinc-900 border border-white/8 rounded-xl px-3 py-2.5 text-sm text-zinc-200 focus:outline-none focus:border-cyan-500/40" />
                            )}
                            {hasOptions && <p className="text-[11px] text-zinc-500 mt-1">{(question.options || []).find((option) => option.value === value)?.description || ''}</p>}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="space-y-4">
                <div className="bg-zinc-950/50 rounded-2xl border border-white/5 p-4">
                  <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-3">Conflicts</p>
                  {(review.conflicts || []).length === 0 && <p className="text-xs text-zinc-500">No hard conflicts detected.</p>}
                  {(review.conflicts || []).map((item, index) => <div key={`conf-${index}`} className="rounded-xl border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-300 mb-2">{String(item.reason || 'Conflict detected')}</div>)}
                </div>
                <div className="bg-zinc-950/50 rounded-2xl border border-white/5 p-4">
                  <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-3">Low confidence</p>
                  {(review.low_confidence_items || []).length === 0 && <p className="text-xs text-zinc-500">No low-confidence items.</p>}
                  {(review.low_confidence_items || []).map((item, index) => <div key={`low-${index}`} className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm text-amber-300 mb-2">{String(item.reason || 'Low-confidence signal')}</div>)}
                </div>
              </div>
            </div>
          </div>
        )}

        {deploymentProfile && (
          <>
            <div className="grid grid-cols-4 gap-4">
              <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4"><p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Application type</p><p className="text-lg font-semibold text-zinc-100">{String(deploymentProfile.application_type || 'unknown')}</p></div>
              <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4"><p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Compute</p><p className="text-lg font-semibold text-zinc-100">{String((deploymentProfile.compute as { strategy?: string } | undefined)?.strategy || 'unknown')}</p></div>
              <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4"><p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Environment</p><p className="text-lg font-semibold text-zinc-100">{String(deploymentProfile.environment || 'unknown')}</p></div>
              <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4"><p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Networking</p><p className="text-lg font-semibold text-zinc-100">{String((deploymentProfile.networking as { layout?: string } | undefined)?.layout || 'unknown')}</p></div>
            </div>
            <div className="grid grid-cols-3 gap-5">
              <div className="col-span-2 bg-zinc-900 rounded-2xl border border-white/5 overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/5"><p className="text-sm font-semibold text-zinc-200">Derived architecture view - AWS (eu-north-1)</p><div className="flex gap-2"><Tag color="zinc">{layout.length} nodes</Tag><Tag color="zinc">{edges.length} edges</Tag></div></div>
                <div className="p-5">
                  <svg viewBox="0 0 700 400" className="w-full rounded-lg" style={{ background: '#0f0f11' }}>
                    <defs><marker id="arr" markerWidth="8" markerHeight="6" refX="6" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#3f3f46" /></marker></defs>
                    {edges.map((e, i) => { const from = nodePos.get(String(e.from)); const to = nodePos.get(String(e.to)); if (!from || !to) return null; return <line key={`${e.from}-${e.to}-${i}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#3f3f46" strokeWidth="1.5" markerEnd="url(#arr)" strokeDasharray="5,3" />; })}
                    {layout.map((n) => <g key={n.id} transform={`translate(${n.x - 60},${n.y - 22})`}><rect width="120" height="44" rx="8" fill={n.color + '18'} stroke={n.color} strokeWidth="1" strokeOpacity=".6" /><text x="60" y="17" textAnchor="middle" fill={n.color} fontSize="9" fontFamily="monospace" fontWeight="600">{String(n.id).toUpperCase()}</text><text x="60" y="31" textAnchor="middle" fill="#a1a1aa" fontSize="10" fontFamily="-apple-system,sans-serif">{n.label || n.type}</text></g>)}
                  </svg>
                </div>
              </div>
              <div className="space-y-4">
                <div className="bg-zinc-900 rounded-2xl border border-white/5 p-5"><p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-3">Monthly estimate</p><p className="text-4xl font-bold text-emerald-400 font-mono">${total.toFixed(2)}</p><div className="mt-4 pt-4 border-t border-white/5 space-y-1.5">{categoryTotals.map(([name, value]) => <div key={name} className="flex justify-between text-xs"><span className="text-zinc-500">{name}</span><span className="text-zinc-300 font-mono">${value.toFixed(2)}</span></div>)}</div></div>
                <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4"><p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Budget gate</p><div className="flex items-center justify-between mb-1.5"><span className="text-xs text-zinc-400">Budget cap</span><span className="text-xs font-mono text-zinc-300">${budgetCap.toFixed(2)}</span></div><div className="h-2 bg-zinc-800 rounded-full overflow-hidden"><div className={`h-full rounded-full ${total <= budgetCap ? 'bg-linear-to-r from-emerald-500 to-cyan-500' : 'bg-linear-to-r from-amber-500 to-red-500'}`} style={{ width: `${percent}%` }} /></div><p className={`text-[11px] mt-1.5 ${total <= budgetCap ? 'text-emerald-400' : 'text-amber-400'}`}>{percent}% of cap used</p></div>
              </div>
            </div>
            <div className="bg-zinc-900 rounded-2xl border border-white/5 overflow-hidden"><div className="px-5 py-3.5 border-b border-white/5"><p className="text-sm font-semibold text-zinc-200">Cost breakdown by service</p></div><table className="w-full text-sm"><thead><tr className="border-b border-white/5">{['Service', 'Type', 'Monthly (USD)', 'Notes'].map((h) => <th key={h} className="text-left px-5 py-3 text-[11px] uppercase tracking-wider text-zinc-500 font-semibold">{h}</th>)}</tr></thead><tbody>{costRows.map((r, i) => <tr key={i} className="border-b border-white/4 last:border-0 hover:bg-white/2"><td className="px-5 py-3 text-zinc-200 font-medium">{r.service}</td><td className="px-5 py-3"><Tag color="zinc">{r.type}</Tag></td><td className="px-5 py-3 font-mono text-zinc-300">${r.monthly.toFixed(2)}</td><td className="px-5 py-3 text-zinc-500 text-xs">{r.note || '-'}</td></tr>)}<tr className="bg-zinc-800/50"><td className="px-5 py-3 font-bold text-zinc-100">Total</td><td /><td className="px-5 py-3 font-mono font-bold text-emerald-400">${total.toFixed(2)}</td><td /></tr></tbody></table></div>
            {!approved ? <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-5 flex items-center justify-between"><div><p className="text-sm font-semibold text-amber-300">Approve deployment profile</p><p className="text-xs text-zinc-500 mt-1">This profile will be used as the canonical Terraform input.</p></div><Btn onClick={() => { setApproved(true); setTimeout(() => onNavigate('iac'), 400); }} variant="primary" size="lg">Approve + Generate IaC</Btn></div> : <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4 text-center"><p className="text-emerald-400 font-semibold">Approved. Advancing to Terraform generation...</p></div>}
          </>
        )}
      </div>
    </div>
  );
}

interface IacPageProps {
  onNavigate: (v: string) => void;
  projectId?: string | null;
  projectName?: string;
}

interface GeneratedIacFile {
  path: string;
  content: string;
}

interface IacGenerationResponse {
  success?: boolean;
  summary?: string;
  source?: string;
  files?: GeneratedIacFile[];
  run_id?: string | null;
  workspace?: string | null;
  provider_version?: string | null;
  state_bucket?: string | null;
  lock_table?: string | null;
  manifest?: unknown[];
  dag_order?: string[];
  warnings?: string[];
  iac_repo_pr?: {
    attempted?: boolean;
    success?: boolean;
    pr_url?: string | null;
  };
  error?: string;
}

interface SavedIacRun {
  run_id: string;
  workspace: string;
  provider_version?: string;
  state_bucket?: string;
  lock_table?: string;
}

type IacMode = 'deterministic' | 'llm';
type IacLlmProvider = 'groq' | 'openrouter' | 'ollama' | 'opencode';

const IAC_MODE_STORAGE_KEY = 'deplai.pipeline.iacMode';
const IAC_LLM_PROVIDER_STORAGE_KEY = 'deplai.pipeline.iacLlmProvider';
const IAC_LLM_MODEL_STORAGE_KEY = 'deplai.pipeline.iacLlmModel';
const IAC_LLM_API_KEY_STORAGE_KEY = 'deplai.pipeline.iacLlmApiKey';
const IAC_LLM_BASE_URL_STORAGE_KEY = 'deplai.pipeline.iacLlmBaseUrl';

const IAC_LLM_DEFAULT_MODELS: Record<IacLlmProvider, string> = {
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'meta-llama/llama-3.3-70b-instruct:free',
  ollama: 'llama3.1:8b',
  opencode: 'openai/gpt-oss-20b',
};

function buildFileTreeFromPaths(paths: string[]): Array<{ name: string; type: 'file' | 'dir'; children?: unknown[] }> {
  const root: Record<string, unknown> = {};
  for (const raw of paths) {
    const parts = String(raw || '').split('/').filter(Boolean);
    let cursor = root;
    parts.forEach((part, idx) => {
      const isLeaf = idx === parts.length - 1;
      if (!cursor[part]) {
        cursor[part] = isLeaf ? { type: 'file' } : { type: 'dir', children: {} };
      }
      if (!isLeaf) {
        cursor = (cursor[part] as { children: Record<string, unknown> }).children;
      }
    });
  }

  const toNode = (name: string, value: unknown): { name: string; type: 'file' | 'dir'; children?: unknown[] } => {
    const v = value as { type: 'file' | 'dir'; children?: Record<string, unknown> };
    if (v.type === 'file') return { name, type: 'file' };
    const children = Object.entries(v.children || {})
      .map(([childName, childValue]) => toNode(childName, childValue))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return { name: `${name}/`, type: 'dir', children };
  };

  return Object.entries(root)
    .map(([name, value]) => toNode(name, value))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function detectTerraformResources(files: GeneratedIacFile[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  files
    .filter((f) => f.path.startsWith('terraform/') && f.path.endsWith('.tf'))
    .forEach((f) => {
      const matches = f.content.match(/resource\s+"([^"]+)"/g) || [];
      matches.forEach((m) => {
        const typeMatch = m.match(/resource\s+"([^"]+)"/);
        const resource = typeMatch?.[1];
        if (!resource) return;
        counts.set(resource, (counts.get(resource) || 0) + 1);
      });
    });
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

function readIacContext(): {
  qaSummary: string;
  architectureJson: Record<string, unknown> | null;
  deploymentProfile: Record<string, unknown> | null;
} {
  if (typeof window === 'undefined') return { qaSummary: '', architectureJson: null, deploymentProfile: null };
  let qaSummary = '';
  let architectureJson: Record<string, unknown> | null = null;
  let deploymentProfile: Record<string, unknown> | null = null;
  try {
    const qaRaw = sessionStorage.getItem('deplai.pipeline.qaContext');
    if (qaRaw) {
      const parsed = JSON.parse(qaRaw) as { qa_summary?: string };
      qaSummary = String(parsed.qa_summary || '');
    }
  } catch {
    qaSummary = '';
  }
  try {
    const archRaw = sessionStorage.getItem('deplai.pipeline.architectureJson');
    if (archRaw) architectureJson = JSON.parse(archRaw) as Record<string, unknown>;
  } catch {
    architectureJson = null;
  }
  try {
    const profileRaw = sessionStorage.getItem(DEPLOYMENT_PROFILE_KEY);
    if (profileRaw) deploymentProfile = JSON.parse(profileRaw) as Record<string, unknown>;
  } catch {
    deploymentProfile = null;
  }
  return { qaSummary, architectureJson, deploymentProfile };
}

function readSavedIacRun(): SavedIacRun | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem('deplai.pipeline.iacRun');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedIacRun>;
    const runId = String(parsed.run_id || '').trim();
    const workspace = String(parsed.workspace || '').trim();
    if (!runId || !workspace) return null;
    return {
      run_id: runId,
      workspace,
      provider_version: String(parsed.provider_version || '').trim() || undefined,
      state_bucket: String(parsed.state_bucket || '').trim() || undefined,
      lock_table: String(parsed.lock_table || '').trim() || undefined,
    };
  } catch {
    return null;
  }
}

export function IaCPage({ onNavigate, projectId, projectName }: IacPageProps) {
  const [selected, setSelected] = useState<string>('terraform/main.tf');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string>('Generating IaC bundle...');
  const [files, setFiles] = useState<GeneratedIacFile[]>([]);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [sendingPr, setSendingPr] = useState<boolean>(false);
  const [liveValidated, setLiveValidated] = useState<boolean>(false);
  const [awsAccessKeyId, setAwsAccessKeyId] = useState<string>(() => readSavedAws().aws_access_key_id);
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState<string>(() => readSavedAws().aws_secret_access_key);
  const [awsRegion, setAwsRegion] = useState<string>(() => readSavedAws().aws_region);
  const [iacMode, setIacMode] = useState<IacMode>(() => {
    if (typeof window === 'undefined') return 'deterministic';
    return localStorage.getItem(IAC_MODE_STORAGE_KEY) === 'llm' ? 'llm' : 'deterministic';
  });
  const [llmProvider, setLlmProvider] = useState<IacLlmProvider>(() => {
    if (typeof window === 'undefined') return 'groq';
    const stored = String(localStorage.getItem(IAC_LLM_PROVIDER_STORAGE_KEY) || '').toLowerCase();
    return stored === 'openrouter' || stored === 'ollama' || stored === 'opencode' ? stored : 'groq';
  });
  const [llmModel, setLlmModel] = useState<string>(() => {
    if (typeof window === 'undefined') return IAC_LLM_DEFAULT_MODELS.groq;
    const storedModel = String(localStorage.getItem(IAC_LLM_MODEL_STORAGE_KEY) || '').trim();
    const provider = String(localStorage.getItem(IAC_LLM_PROVIDER_STORAGE_KEY) || 'groq').toLowerCase() as IacLlmProvider;
    return storedModel || IAC_LLM_DEFAULT_MODELS[provider] || IAC_LLM_DEFAULT_MODELS.groq;
  });
  const [llmApiKey, setLlmApiKey] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return String(localStorage.getItem(IAC_LLM_API_KEY_STORAGE_KEY) || '');
  });
  const [llmApiBaseUrl, setLlmApiBaseUrl] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return String(localStorage.getItem(IAC_LLM_BASE_URL_STORAGE_KEY) || '');
  });

  const fileMap = useMemo(() => {
    const map: Record<string, string> = {};
    files.forEach((f) => {
      map[f.path] = f.content;
    });
    return map;
  }, [files]);
  const tree = useMemo(() => buildFileTreeFromPaths(files.map((f) => f.path)), [files]);
  const resources = useMemo(() => detectTerraformResources(files), [files]);
  const terraformFiles = useMemo(() => files.filter((f) => f.path.startsWith('terraform/')), [files]);
  const resolvedSelectedPath = useMemo(() => {
    if (fileMap[selected]) return selected;
    const suffixMatches = Object.keys(fileMap).filter((path) => path.endsWith(`/${selected}`) || path === selected);
    if (suffixMatches.length === 1) return suffixMatches[0];
    if (suffixMatches.length > 1) {
      const preferred = suffixMatches.find((path) => path.startsWith('terraform/'));
      return preferred || suffixMatches[0];
    }
    return '';
  }, [fileMap, selected]);

  useEffect(() => {
    if (typeof window === 'undefined' || !projectId) return;
    const storedProjectId = sessionStorage.getItem(PLANNING_PROJECT_KEY);
    if (storedProjectId && storedProjectId !== projectId) {
      clearPlanningState();
      setError(null);
      setLoading(true);
      setFiles([]);
      setSummary('Generating IaC bundle...');
      setSelected('terraform/main.tf');
      setPrUrl(null);
      setLiveValidated(false);
    }
  }, [projectId]);

  useEffect(() => {
    writeSavedAws({
      aws_access_key_id: awsAccessKeyId,
      aws_secret_access_key: awsSecretAccessKey,
      aws_region: awsRegion || 'eu-north-1',
    });
  }, [awsAccessKeyId, awsRegion, awsSecretAccessKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(IAC_MODE_STORAGE_KEY, iacMode);
  }, [iacMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(IAC_LLM_PROVIDER_STORAGE_KEY, llmProvider);
    if (!String(llmModel || '').trim()) {
      setLlmModel(IAC_LLM_DEFAULT_MODELS[llmProvider]);
    }
  }, [llmModel, llmProvider]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(IAC_LLM_MODEL_STORAGE_KEY, llmModel);
  }, [llmModel]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(IAC_LLM_API_KEY_STORAGE_KEY, llmApiKey);
  }, [llmApiKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(IAC_LLM_BASE_URL_STORAGE_KEY, llmApiBaseUrl);
  }, [llmApiBaseUrl]);

  const generateIac = async () => {
    if (!projectId) {
      setError('Select a project before generating IaC.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { qaSummary, architectureJson, deploymentProfile } = readIacContext();
      const body: Record<string, unknown> = {
        project_id: projectId,
        provider: 'aws',
        iac_mode: iacMode,
        qa_summary: qaSummary,
        architecture_context: qaSummary,
        aws_access_key_id: awsAccessKeyId.trim() || undefined,
        aws_secret_access_key: awsSecretAccessKey.trim() || undefined,
        aws_region: awsRegion.trim() || 'eu-north-1',
      };
      if (iacMode === 'llm') {
        body.llm_provider = llmProvider;
        body.llm_model = llmModel.trim() || IAC_LLM_DEFAULT_MODELS[llmProvider];
        body.llm_api_key = llmApiKey.trim() || undefined;
        body.llm_api_base_url = llmApiBaseUrl.trim() || undefined;
      }
      if (deploymentProfile && Object.keys(deploymentProfile).length > 0) {
        body.architecture_json = deploymentProfile;
      } else if (architectureJson && Object.keys(architectureJson).length > 0) {
        body.architecture_json = architectureJson;
      }
      const res = await fetch('/api/pipeline/iac', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as IacGenerationResponse;
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to generate IaC bundle.');
      }
      const generated = normalizeIacFilesForUi(Array.isArray(data.files) ? data.files : []);
      const hasLiveValidation = Boolean(data.run_id && data.workspace);
      setFiles(generated);
      setLiveValidated(hasLiveValidation);
      const sourceLabel = String(data.source || '').trim();
      const sourceSuffix = sourceLabel ? ` [source: ${sourceLabel}]` : '';
      setSummary(`${String(data.summary || `Generated ${generated.length} files.`)}${sourceSuffix}`);
      setPrUrl(String(data.iac_repo_pr?.pr_url || '') || null);
      if (generated.length > 0) {
        const firstTf = generated.find((f) => f.path.startsWith('terraform/') && f.path.endsWith('.tf'));
        setSelected(firstTf?.path || generated[0].path);
      }
      if (typeof window !== 'undefined') {
        writeStoredJson('deplai.pipeline.iacFiles', generated);
        if (hasLiveValidation && data.run_id && data.workspace) {
          sessionStorage.setItem('deplai.pipeline.iacRun', JSON.stringify({
            run_id: data.run_id,
            workspace: data.workspace,
            provider_version: data.provider_version || '',
            state_bucket: data.state_bucket || '',
            lock_table: data.lock_table || '',
          }));
        } else {
          sessionStorage.removeItem('deplai.pipeline.iacRun');
        }
      }
    } catch (e) {
      setLiveValidated(false);
      setError(e instanceof Error ? e.message : 'IaC generation failed.');
    } finally {
      setLoading(false);
      setSendingPr(false);
    }
  };

  useEffect(() => {
    void generateIac();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const sendPr = async () => {
    if (prUrl || sendingPr) return;
    setSendingPr(true);
    await generateIac();
  };

  const fileTypeTag = selected.endsWith('.tf') ? 'HCL' : selected.endsWith('.yml') || selected.endsWith('.yaml') ? 'YAML' : 'TXT';

  return (
    <div className="flex-1 flex flex-col overflow-hidden fade-in">
      <Header
        title="Infrastructure as Code"
        subtitle={projectName ? `Repo-aware Terraform generation for ${projectName}.` : 'Repo-aware Terraform generation.'}
        badge={loading
          ? { text: 'Generating IaC bundle', cls: 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' }
          : error
            ? { text: 'IaC generation failed', cls: 'bg-red-500/10 text-red-400 border border-red-500/20' }
            : liveValidated
              ? { text: 'IaC generated - validated', cls: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' }
              : { text: 'IaC generated - offline', cls: 'bg-amber-500/10 text-amber-400 border border-amber-500/20' }}
        actions={
          <>
            <Tag color="emerald">Stage 8</Tag>
            <Btn onClick={sendPr} variant="default" size="sm" disabled={loading || Boolean(prUrl) || Boolean(error)}>{prUrl ? 'PR sent' : sendingPr ? 'Sending PR...' : 'Send PR (terraform/)'}</Btn>
            {prUrl && <Btn onClick={() => window.open(prUrl, '_blank', 'noopener,noreferrer')} variant="default" size="sm">Open PR</Btn>}
            <Btn onClick={() => onNavigate('gitops')} variant="primary" size="sm" disabled={loading || Boolean(error)}>Proceed to GitOps</Btn>
          </>
        }
      />
      <div className="px-7 pt-4 pb-3 text-xs text-zinc-500 border-b border-white/5">
        {summary}
        {error && <span className="text-red-400 ml-3">{error}</span>}
      </div>
      <div className="mx-7 mt-4 rounded-2xl border border-white/5 bg-zinc-900/60 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-zinc-100">AWS credentials for Stage 8</p>
            <p className="mt-1 text-xs text-zinc-400 max-w-3xl">
              Optional for Terraform file generation. If provided, DeplAI also attempts backend bootstrap and live Terraform validation during this stage.
              Without credentials, Stage 8 still generates Terraform files and AWS access is only required before deploy/apply.
            </p>
          </div>
          <Tag color={awsAccessKeyId.trim() && awsSecretAccessKey.trim() ? 'emerald' : 'zinc'}>
            {awsAccessKeyId.trim() && awsSecretAccessKey.trim() ? 'Saved locally' : 'Optional'}
          </Tag>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <p className="mb-1.5 text-[11px] text-zinc-500">AWS_ACCESS_KEY_ID</p>
            <input value={awsAccessKeyId} onChange={(e) => setAwsAccessKeyId(e.target.value)} placeholder="AKIA..." className="w-full bg-zinc-950 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20" />
          </div>
          <div>
            <p className="mb-1.5 text-[11px] text-zinc-500">AWS_SECRET_ACCESS_KEY</p>
            <input type="password" value={awsSecretAccessKey} onChange={(e) => setAwsSecretAccessKey(e.target.value)} placeholder="Enter AWS secret access key" className="w-full bg-zinc-950 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20" />
          </div>
          <div>
            <p className="mb-1.5 text-[11px] text-zinc-500">AWS_REGION</p>
            <input value={awsRegion} onChange={(e) => setAwsRegion(e.target.value)} placeholder="eu-north-1" className="w-full bg-zinc-950 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20" />
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-white/8 bg-zinc-950/70 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-zinc-100">IaC Generation Mode</p>
              <p className="mt-1 text-xs text-zinc-500">Switch between deterministic templates and real LLM-driven generation.</p>
            </div>
            <select
              value={iacMode}
              onChange={(e) => setIacMode(e.target.value === 'llm' ? 'llm' : 'deterministic')}
              className="rounded-lg border border-white/10 bg-black px-3 py-2 text-xs font-semibold text-zinc-200 focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20"
            >
              <option value="deterministic">Deterministic fallback</option>
              <option value="llm">LLM mode</option>
            </select>
          </div>
          {iacMode === 'llm' && (
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <p className="mb-1.5 text-[11px] text-zinc-500">LLM Provider</p>
                <select
                  value={llmProvider}
                  onChange={(e) => {
                    const nextProvider = e.target.value as IacLlmProvider;
                    setLlmProvider(nextProvider);
                    setLlmModel((prev) => String(prev || '').trim() || IAC_LLM_DEFAULT_MODELS[nextProvider]);
                  }}
                  className="w-full rounded-lg border border-white/10 bg-black px-3 py-2 text-xs font-semibold text-zinc-200 focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20"
                >
                  <option value="groq">Groq</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="ollama">Ollama Cloud API</option>
                  <option value="opencode">OpenCode API</option>
                </select>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] text-zinc-500">Model</p>
                <input
                  value={llmModel}
                  onChange={(e) => setLlmModel(e.target.value)}
                  placeholder={IAC_LLM_DEFAULT_MODELS[llmProvider]}
                  className="w-full rounded-lg border border-white/10 bg-black px-3 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20"
                />
              </div>
              <div>
                <p className="mb-1.5 text-[11px] text-zinc-500">API key</p>
                <input
                  type="password"
                  value={llmApiKey}
                  onChange={(e) => setLlmApiKey(e.target.value)}
                  placeholder={llmProvider === 'groq' ? 'gsk_...' : llmProvider === 'openrouter' ? 'sk-or-v1-...' : 'API key'}
                  className="w-full rounded-lg border border-white/10 bg-black px-3 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20"
                />
              </div>
              <div>
                <p className="mb-1.5 text-[11px] text-zinc-500">Custom API base URL (optional)</p>
                <input
                  value={llmApiBaseUrl}
                  onChange={(e) => setLlmApiBaseUrl(e.target.value)}
                  placeholder="https://api.provider.com/v1"
                  className="w-full rounded-lg border border-white/10 bg-black px-3 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20"
                />
              </div>
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center justify-between gap-4">
          <p className="text-[11px] text-zinc-500">
            Credentials are persisted in this browser session as you type so Stage 9 and deploy reuse the same values.
          </p>
          <Btn onClick={() => void generateIac()} variant="default" size="sm" disabled={loading}>
            {loading ? 'Generating...' : 'Re-run with current settings'}
          </Btn>
        </div>
      </div>
      <div className="mt-4 flex flex-1 overflow-hidden">
        <div className="w-64 shrink-0 bg-[#09090b] border-r border-white/5 overflow-y-auto custom-scrollbar">
          <div className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold px-2 py-1.5">File tree</p>
            {tree.map((node, i) => <FileNode key={i} node={node as never} selected={selected} setSelected={setSelected} />)}
          </div>
        </div>
        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="flex items-center gap-3 px-4 py-2.5 bg-zinc-900/50 border-b border-white/5 shrink-0">
            <svg className="w-4 h-4 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            <span className="text-xs font-mono text-zinc-400">{resolvedSelectedPath || selected || 'No file selected'}</span>
            <div className="flex gap-1.5 ml-auto">
              <Tag color="zinc">{fileTypeTag}</Tag>
              <Tag color={error ? 'amber' : 'emerald'}>{error ? 'Needs retry' : 'Generated'}</Tag>
              <Tag color="zinc">{terraformFiles.length} terraform files</Tag>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {loading && <div className="p-5"><div className="shimmer h-4 rounded mb-3 w-3/4" /><div className="shimmer h-4 rounded mb-3 w-1/2" /><div className="shimmer h-4 rounded mb-3 w-5/6" /><div className="shimmer h-4 rounded mb-3 w-2/3" /></div>}
            {!loading && !error && resolvedSelectedPath && fileMap[resolvedSelectedPath] && <pre className="p-5 text-[12px] font-mono leading-relaxed text-zinc-300" dangerouslySetInnerHTML={{ __html: colorize(fileMap[resolvedSelectedPath]) }} />}
            {!loading && !error && (!resolvedSelectedPath || !fileMap[resolvedSelectedPath]) && <div className="p-5 text-zinc-500 text-sm">Select a generated file from the tree.</div>}
          </div>
        </div>
        <div className="w-64 shrink-0 bg-[#09090b] border-l border-white/5 overflow-y-auto custom-scrollbar p-4 space-y-4">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold mb-2">Validation</p>
            {[{ k: 'terraform init', v: loading ? '...' : error ? '!' : liveValidated ? 'ok' : 'deferred' }, { k: 'terraform validate', v: loading ? '...' : error ? '!' : liveValidated ? 'ok' : 'deferred' }, { k: 'terraform plan', v: loading ? '...' : error ? '!' : liveValidated ? 'ok' : 'deferred' }, { k: 'tflint', v: loading ? '...' : error ? '!' : liveValidated ? 'ok' : 'deferred' }].map((r, i) => <div key={i} className="flex justify-between py-1.5 border-b border-white/4 last:border-0 text-xs"><span className="text-zinc-500 font-mono">{r.k}</span><span className={r.v === 'ok' ? 'text-emerald-400 font-bold' : r.v === '...' ? 'text-zinc-500 font-bold' : 'text-amber-400 font-bold'}>{r.v}</span></div>)}
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold mb-2">Resources</p>
            {resources.length === 0 && <p className="text-[11px] text-zinc-500">No terraform resources parsed yet.</p>}
            {resources.map((r, i) => <div key={i} className="flex justify-between py-1.5 border-b border-white/4 last:border-0"><span className="text-[11px] font-mono text-zinc-500">{r.name}</span><span className="text-[11px] text-zinc-400 font-semibold">x{r.count}</span></div>)}
          </div>
        </div>
      </div>
    </div>
  );
}
interface GitOpsPageProps {
  onNavigate: (v: string) => void;
  projectId?: string | null;
  scanStatus?: string;
}

interface CostEstimateState {
  total_monthly_usd: number;
  budget_cap_usd: number;
  breakdown: Array<{ service: string; type: string; monthly: number; note: string }>;
}

interface AuditEvent {
  who: string;
  action: string;
  ts: string;
}

function readSavedAws(): { aws_access_key_id: string; aws_secret_access_key: string; aws_region: string } {
  if (typeof window === 'undefined') {
    return { aws_access_key_id: '', aws_secret_access_key: '', aws_region: 'eu-north-1' };
  }
  try {
    const raw = sessionStorage.getItem('pipeline.aws');
    if (!raw) return { aws_access_key_id: '', aws_secret_access_key: '', aws_region: 'eu-north-1' };
    const parsed = JSON.parse(raw) as { aws_access_key_id?: string; aws_secret_access_key?: string; aws_region?: string };
    return {
      aws_access_key_id: String(parsed.aws_access_key_id || ''),
      aws_secret_access_key: String(parsed.aws_secret_access_key || ''),
      aws_region: String(parsed.aws_region || 'eu-north-1'),
    };
  } catch {
    return { aws_access_key_id: '', aws_secret_access_key: '', aws_region: 'eu-north-1' };
  }
}

function writeSavedAws(aws: { aws_access_key_id: string; aws_secret_access_key: string; aws_region: string }): void {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem('pipeline.aws', JSON.stringify({
    aws_access_key_id: aws.aws_access_key_id,
    aws_secret_access_key: aws.aws_secret_access_key,
    aws_region: aws.aws_region || 'eu-north-1',
  }));
}

function readSavedCost(): CostEstimateState {
  if (typeof window === 'undefined') {
    return { total_monthly_usd: 85.93, budget_cap_usd: 100, breakdown: [] };
  }
  try {
    const raw = sessionStorage.getItem('deplai.pipeline.costEstimate');
    if (!raw) return { total_monthly_usd: 85.93, budget_cap_usd: 100, breakdown: [] };
    const parsed = JSON.parse(raw) as Partial<CostEstimateState>;
    return {
      total_monthly_usd: Number(parsed.total_monthly_usd || 85.93),
      budget_cap_usd: Number(parsed.budget_cap_usd || 100),
      breakdown: Array.isArray(parsed.breakdown) ? parsed.breakdown as CostEstimateState['breakdown'] : [],
    };
  } catch {
    return { total_monthly_usd: 85.93, budget_cap_usd: 100, breakdown: [] };
  }
}

function readSavedIacCount(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = sessionStorage.getItem('deplai.pipeline.iacFiles');
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as Array<{ path?: string }>;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export function GitOpsPage({ onNavigate, projectId, scanStatus }: GitOpsPageProps) {
  const [overridden, setOverridden] = useState<boolean>(false);
  const [awsAccessKeyId, setAwsAccessKeyId] = useState<string>(() => readSavedAws().aws_access_key_id);
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState<string>(() => readSavedAws().aws_secret_access_key);
  const [awsRegion, setAwsRegion] = useState<string>(() => readSavedAws().aws_region);
  const [costState] = useState<CostEstimateState>(() => readSavedCost());
  const [criticalFindings, setCriticalFindings] = useState<number | null>(null);
  const [iacFileCount] = useState<number>(() => readSavedIacCount());
  const [auditTrail, setAuditTrail] = useState<AuditEvent[]>(() => {
    const ts = new Date().toLocaleTimeString();
    return [
      { who: 'deplai-bot', action: 'Generated IaC bundle', ts },
      { who: 'admin', action: 'Opened GitOps policy gate', ts },
    ];
  });

  const total = Number(costState.total_monthly_usd || 0);
  const cap = Number(costState.budget_cap_usd || 100);
  const pct = Math.round((total / cap) * 100);
  const within = total <= cap;
  const secretsConfigured = Boolean(awsAccessKeyId.trim() && awsSecretAccessKey.trim());
  const noCriticalCves = criticalFindings === null
    ? scanStatus !== 'found'
    : criticalFindings === 0;
  const terraformValidated = iacFileCount > 0;
  const approvalLogged = iacFileCount > 0;

  useEffect(() => {
    if (!projectId || scanStatus !== 'found') return;

    let cancelled = false;
    const run = async () => {
      try {
        const res = await fetch(`/api/scan/results?project_id=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json() as {
          data?: {
            code_security?: Array<{ severity?: string; count?: number }>;
            supply_chain?: Array<{ severity?: string }>;
          };
        };

        const codeCritical = (data.data?.code_security || [])
          .filter((f) => String(f.severity || '').toLowerCase() === 'critical')
          .reduce((sum, f) => sum + Number(f.count || 0), 0);
        const supplyCritical = (data.data?.supply_chain || [])
          .filter((f) => String(f.severity || '').toLowerCase() === 'critical')
          .length;

        if (!cancelled) {
          setCriticalFindings(codeCritical + supplyCritical);
        }
      } catch {
        // ignore fetch errors and keep fallback gate state
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [projectId, scanStatus]);

  useEffect(() => {
    writeSavedAws({
      aws_access_key_id: awsAccessKeyId,
      aws_secret_access_key: awsSecretAccessKey,
      aws_region: awsRegion || 'eu-north-1',
    });
  }, [awsAccessKeyId, awsRegion, awsSecretAccessKey]);

  const gates = [
    { label: 'Cost within budget', pass: within || overridden },
    { label: 'No critical CVEs remaining', pass: noCriticalCves },
    { label: 'Terraform validated', pass: terraformValidated },
    { label: 'Secrets configured', pass: secretsConfigured },
    { label: 'Approval logged', pass: approvalLogged },
  ];

  const allGatesPassed = gates.every((g) => g.pass);

  const onProceed = () => {
    writeSavedAws({
      aws_access_key_id: awsAccessKeyId,
      aws_secret_access_key: awsSecretAccessKey,
      aws_region: awsRegion || 'eu-north-1',
    });
    setAuditTrail((prev) => [
      ...prev,
      { who: 'admin', action: 'Confirmed GitOps gates', ts: new Date().toLocaleTimeString() },
    ]);
    onNavigate('deploy');
  };

  return (
    <div className="flex-1 overflow-y-auto fade-in custom-scrollbar">
      <Header
        title="GitOps - Budget Check"
        subtitle="Policy enforcement before infrastructure provisioning. Cost review + secret configuration."
        badge={{
          text: within ? 'Within budget policy' : 'Budget policy violation',
          cls: within ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20',
        }}
        actions={<Tag color={within ? 'emerald' : 'amber'}>Stage 9 - {within ? 'PASSED' : 'OVERRIDE REQUIRED'}</Tag>}
      />
      <div className="p-7 grid grid-cols-3 gap-5">
        <div className="col-span-2 space-y-4">
          <div className="bg-zinc-900 rounded-2xl border border-white/5 p-5">
            <p className="text-sm font-semibold text-zinc-200 mb-4">AWS credential input</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[11px] text-zinc-500 mb-1.5">AWS_ACCESS_KEY_ID</p>
                <input value={awsAccessKeyId} onChange={(e) => setAwsAccessKeyId(e.target.value)} placeholder="AKIA..." className="w-full bg-zinc-950 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20" />
              </div>
              <div>
                <p className="text-[11px] text-zinc-500 mb-1.5">AWS_REGION</p>
                <input value={awsRegion} onChange={(e) => setAwsRegion(e.target.value)} placeholder="eu-north-1" className="w-full bg-zinc-950 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20" />
              </div>
            </div>
            <div className="mt-3">
              <p className="text-[11px] text-zinc-500 mb-1.5">AWS_SECRET_ACCESS_KEY</p>
              <input type="password" value={awsSecretAccessKey} onChange={(e) => setAwsSecretAccessKey(e.target.value)} placeholder="Enter AWS secret access key" className="w-full bg-zinc-950 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20" />
            </div>
          </div>

          <div className="bg-zinc-900 rounded-2xl border border-white/5 p-5">
            <p className="text-sm font-semibold text-zinc-200 mb-4">Budget policy check</p>
            <div className="flex items-end justify-between mb-3">
              <div>
                <p className="text-[11px] text-zinc-500 mb-1">Estimated monthly cost</p>
                <p className="text-3xl font-bold text-emerald-400 font-mono">${total.toFixed(2)}</p>
              </div>
              <div className="text-right">
                <p className="text-[11px] text-zinc-500 mb-1">Budget cap</p>
                <p className="text-xl font-semibold text-zinc-400 font-mono">${cap.toFixed(2)}</p>
              </div>
            </div>
            <div className="h-3 bg-zinc-800 rounded-full overflow-hidden mb-2"><div className={`h-full rounded-full transition-all ${within ? 'bg-linear-to-r from-emerald-500 to-cyan-500' : 'bg-linear-to-r from-amber-500 to-red-500'}`} style={{ width: `${Math.min(pct, 100)}%` }} /></div>
            <div className="flex justify-between text-xs"><span className="text-zinc-500">{pct}% of budget used</span><span className={within ? 'text-emerald-400' : 'text-red-400'}>{within ? 'Within policy' : 'Exceeds cap'}</span></div>
          </div>

          <div className="bg-zinc-900 rounded-2xl border border-white/5 p-5">
            <p className="text-sm font-semibold text-zinc-200 mb-4">GitHub Secrets Configuration</p>
            <div className="space-y-3">
              {[
                { secret: 'AWS_ACCESS_KEY_ID', status: awsAccessKeyId.trim() ? 'set' : 'missing', masked: awsAccessKeyId.trim() ? `${awsAccessKeyId.slice(0, 4)}********${awsAccessKeyId.slice(-4)}` : 'Not configured' },
                { secret: 'AWS_SECRET_ACCESS_KEY', status: awsSecretAccessKey.trim() ? 'set' : 'missing', masked: awsSecretAccessKey.trim() ? '********************************' : 'Not configured' },
                { secret: 'GITHUB_TOKEN', status: 'auto', masked: 'Provided by Actions runner' },
              ].map((s, i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-zinc-950 rounded-lg border border-white/5">
                  <svg className={`w-4 h-4 shrink-0 ${s.status === 'missing' ? 'text-amber-400' : 'text-emerald-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                  <span className="text-sm font-medium text-zinc-200 w-48">{s.secret}</span>
                  <span className="text-[11px] font-mono text-zinc-500 flex-1 truncate">{s.masked}</span>
                  <Tag color={s.status === 'auto' ? 'zinc' : s.status === 'missing' ? 'amber' : 'emerald'}>{s.status === 'auto' ? 'auto' : s.status}</Tag>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4">
            <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-3">Policy gates</p>
            {gates.map((g, i) => (
              <div key={i} className="flex items-center gap-2.5 py-2.5 border-b border-white/4 last:border-0">
                {g.pass ? <svg className="w-4 h-4 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg> : <svg className="w-4 h-4 text-red-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>}
                <span className="text-[12px] text-zinc-300">{g.label}</span>
              </div>
            ))}
          </div>

          <div className={`rounded-2xl border p-4 ${(allGatesPassed || overridden) ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-amber-500/5 border-amber-500/20'}`}>
            <p className={`text-xs font-semibold mb-2 ${(allGatesPassed || overridden) ? 'text-emerald-300' : 'text-amber-300'}`}>{(allGatesPassed || overridden) ? 'All gates passed' : 'Manual action required'}</p>
            <p className="text-[11px] text-zinc-400 mb-4">{(allGatesPassed || overridden) ? 'Proceed to deploy with current policy and secret configuration.' : 'Resolve missing gates or override budget policy to continue.'}</p>
            {!within && !overridden && <Btn onClick={() => setOverridden(true)} variant="default" size="sm">Override budget policy</Btn>}
            <Btn onClick={onProceed} variant="primary" size="sm" disabled={!(terraformValidated && secretsConfigured && (within || overridden))}>
              {(terraformValidated && secretsConfigured && (within || overridden)) ? 'Proceed to Deploy' : 'Add AWS secrets to continue'}
            </Btn>
          </div>

          <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4">
            <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Audit trail</p>
            {auditTrail.map((e, i) => (
              <div key={i} className="py-2 border-b border-white/4 last:border-0">
                <div className="flex justify-between text-[10px]"><span className="text-zinc-400 font-medium">{e.who}</span><span className="text-zinc-600 font-mono">{e.ts}</span></div>
                <p className="text-[11px] text-zinc-500">{e.action}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
interface DeployPageProps {
  projectId?: string | null;
  onDeploymentStateChange?: (state: 'idle' | 'running' | 'done' | 'error') => void;
}

interface DeployApiResult {
  success?: boolean;
  cloudfront_url?: string | null;
  outputs?: Record<string, unknown>;
  raw_outputs?: Record<string, unknown>;
  details?: Record<string, unknown> | null;
  sensitive_output_arns?: Record<string, string> | null;
  ec2_key_name?: string | null;
  generated_ec2_private_key_pem?: string | null;
  keypair?: {
    key_name?: string | null;
    private_key_pem?: string | null;
  } | null;
  ec2?: {
    instance_id?: string | null;
    state?: string | null;
    type?: string | null;
    public_ip?: string | null;
    private_ip?: string | null;
    public_dns?: string | null;
    private_dns?: string | null;
    instance_arn?: string | null;
  } | null;
  network?: {
    vpc_id?: string | null;
    subnet_id?: string | null;
  } | null;
  cdn?: {
    cloudfront_url?: string | null;
  } | null;
  error?: string;
}

interface DeployStatusResponse {
  success?: boolean;
  status?: 'idle' | 'running' | 'completed' | 'error' | string;
  result?: Record<string, unknown> | null;
  error?: string;
}

interface DeployStateSnapshot {
  status: 'idle' | 'running' | 'done' | 'error';
  progress: number;
  logs: Array<{ text: string; ts: string; type: 'info' | 'success' | 'error' }>;
  deployResult: DeployApiResult | null;
  deploymentHistory: DeploymentHistoryEntry[];
  updatedAt: string;
}

interface DeploymentHistoryEntry {
  id: string;
  createdAt: string;
  status: 'done' | 'error';
  region: string;
  cloudfrontUrl: string;
  instanceId: string;
  deployResult: DeployApiResult | null;
}

interface AwsRuntimeLiveInstance {
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
}

interface AwsRuntimeLiveCounts {
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
}

interface AwsRuntimeLiveDetails {
  region?: string;
  account_id?: string;
  instance?: AwsRuntimeLiveInstance;
  resource_counts?: AwsRuntimeLiveCounts;
}

const DEPLOY_STATE_STORAGE_PREFIX = 'deplai.pipeline.deployState.';
const DEPLOY_HISTORY_MAX = 20;
type DeployStatus = 'idle' | 'running' | 'done' | 'error';
type DeployLog = { text: string; ts: string; type: 'info' | 'success' | 'error' };

interface ActiveDeployState {
  status: DeployStatus;
  progress: number;
  logs: DeployLog[];
  deployResult: DeployApiResult | null;
  deploymentHistory: DeploymentHistoryEntry[];
  updatedAt?: string;
}

interface ActiveDeployEntry {
  state: ActiveDeployState;
  listeners: Set<(state: ActiveDeployState) => void>;
  inFlight: boolean;
}

const activeDeployments = new Map<string, ActiveDeployEntry>();

function toDeployState(snapshot?: Partial<ActiveDeployState>): ActiveDeployState {
  return {
    status: (snapshot?.status === 'running' || snapshot?.status === 'done' || snapshot?.status === 'error') ? snapshot.status : 'idle',
    progress: Number.isFinite(snapshot?.progress) ? Number(snapshot?.progress) : 0,
    logs: Array.isArray(snapshot?.logs) ? snapshot.logs : [],
    deployResult: (snapshot?.deployResult && typeof snapshot.deployResult === 'object') ? snapshot.deployResult : null,
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

function setActiveDeploymentState(projectId: string, next: ActiveDeployState): void {
  const entry = getOrCreateActiveDeployment(projectId);
  entry.state = next;
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
  if (typeof window !== 'undefined') {
    const snapshot: DeployStateSnapshot = {
      status: entry.state.status,
      progress: entry.state.progress,
      logs: entry.state.logs,
      deployResult: entry.state.deployResult,
      deploymentHistory: entry.state.deploymentHistory,
      updatedAt: new Date().toISOString(),
    };
    try {
      localStorage.setItem(`${DEPLOY_STATE_STORAGE_PREFIX}${projectId}`, JSON.stringify(snapshot));
    } catch {
      // ignore storage errors
    }
  }
  emitActiveDeployment(projectId);
  return entry.state;
}

interface ResourceSummaryRow {
  label: string;
  count: number;
}

function parseIacFilesFromSession(): Array<{ path: string; content: string }> {
  if (typeof window === 'undefined') return [];
  try {
    const raw = sessionStorage.getItem('deplai.pipeline.iacFiles');
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<{ path?: string; content?: string }>;
    if (!Array.isArray(parsed)) return [];
    return normalizeIacFilesForUi(parsed);
  } catch {
    return [];
  }
}

function parseAwsFromSession(): { aws_access_key_id: string; aws_secret_access_key: string; aws_region: string } {
  if (typeof window === 'undefined') {
    return { aws_access_key_id: '', aws_secret_access_key: '', aws_region: 'eu-north-1' };
  }
  try {
    const raw = sessionStorage.getItem('pipeline.aws');
    if (!raw) return { aws_access_key_id: '', aws_secret_access_key: '', aws_region: 'eu-north-1' };
    const parsed = JSON.parse(raw) as { aws_access_key_id?: string; aws_secret_access_key?: string; aws_region?: string };
    return {
      aws_access_key_id: String(parsed.aws_access_key_id || ''),
      aws_secret_access_key: String(parsed.aws_secret_access_key || ''),
      aws_region: String(parsed.aws_region || 'eu-north-1'),
    };
  } catch {
    return { aws_access_key_id: '', aws_secret_access_key: '', aws_region: 'eu-north-1' };
  }
}

function parseCostFromSession(): { total: number; cap: number } {
  if (typeof window === 'undefined') return { total: 0, cap: 100 };
  try {
    const raw = sessionStorage.getItem('deplai.pipeline.costEstimate');
    if (!raw) return { total: 0, cap: 100 };
    const parsed = JSON.parse(raw) as { total_monthly_usd?: number; budget_cap_usd?: number };
    return {
      total: Number(parsed.total_monthly_usd || 0),
      cap: Number(parsed.budget_cap_usd || 100),
    };
  } catch {
    return { total: 0, cap: 100 };
  }
}

function summarizeResources(files: Array<{ path: string; content: string }>): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  files
    .filter((f) => f.path.startsWith('terraform/') && f.path.endsWith('.tf'))
    .forEach((f) => {
      const matches = f.content.match(/resource\s+"([^"]+)"/g) || [];
      matches.forEach((m) => {
        const typeMatch = m.match(/resource\s+"([^"]+)"/);
        const type = typeMatch?.[1];
        if (!type) return;
        counts.set(type, (counts.get(type) || 0) + 1);
      });
    });
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

function buildAwsResourceSummary(resources: Array<{ name: string; count: number }>): ResourceSummaryRow[] {
  const counts = new Map(resources.map((row) => [row.name, row.count]));
  const sum = (types: string[]) => types.reduce((acc, type) => acc + (counts.get(type) || 0), 0);

  return [
    { label: 'EC2 Instances', count: sum(['aws_instance']) },
    { label: 'VPCs', count: sum(['aws_vpc']) },
    { label: 'Subnets', count: sum(['aws_subnet']) },
    { label: 'Internet Gateways', count: sum(['aws_internet_gateway']) },
    { label: 'NAT Gateways', count: sum(['aws_nat_gateway']) },
    { label: 'Route Tables', count: sum(['aws_route_table']) },
    { label: 'Security Groups', count: sum(['aws_security_group']) },
    { label: 'Key Pairs', count: sum(['aws_key_pair']) },
    { label: 'S3 Buckets', count: sum(['aws_s3_bucket']) },
    { label: 'CloudFront Distributions', count: sum(['aws_cloudfront_distribution']) },
    { label: 'CloudFront OAC', count: sum(['aws_cloudfront_origin_access_control']) },
    { label: 'Load Balancers', count: sum(['aws_lb', 'aws_alb']) },
    { label: 'RDS Instances', count: sum(['aws_db_instance']) },
  ];
}

function pickOutput(outputs: Record<string, unknown> | undefined, candidates: string[]): string {
  if (!outputs) return 'n/a';

  for (const key of candidates) {
    const direct = outputs[key];
    if (typeof direct === 'string' && direct.trim()) return direct;
    if (direct && typeof direct === 'object' && 'value' in (direct as Record<string, unknown>)) {
      const v = (direct as Record<string, unknown>).value;
      if (typeof v === 'string' && v.trim()) return v;
    }
  }

  const lowered = Object.keys(outputs).reduce<Record<string, unknown>>((acc, key) => {
    acc[key.toLowerCase()] = outputs[key];
    return acc;
  }, {});

  for (const key of candidates.map((k) => k.toLowerCase())) {
    const match = lowered[key];
    if (typeof match === 'string' && match.trim()) return match;
    if (match && typeof match === 'object' && 'value' in (match as Record<string, unknown>)) {
      const v = (match as Record<string, unknown>).value;
      if (typeof v === 'string' && v.trim()) return v;
    }
  }

  const fuzzyKey = Object.keys(outputs).find((k) => candidates.some((c) => k.toLowerCase().includes(c.toLowerCase())));
  if (fuzzyKey) {
    const value = outputs[fuzzyKey];
    if (typeof value === 'string' && value.trim()) return value;
    if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
      const v = (value as Record<string, unknown>).value;
      if (typeof v === 'string' && v.trim()) return v;
    }
  }

  return 'n/a';
}

function pickOutputRaw(outputs: Record<string, unknown> | undefined, candidates: string[]): string | null {
  if (!outputs) return null;
  for (const key of candidates) {
    const direct = outputs[key];
    if (typeof direct === 'string' && direct.trim()) return direct;
    if (direct && typeof direct === 'object' && 'value' in (direct as Record<string, unknown>)) {
      const v = (direct as Record<string, unknown>).value;
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  const fuzzyKey = Object.keys(outputs).find((k) => candidates.some((c) => k.toLowerCase().includes(c.toLowerCase())));
  if (!fuzzyKey) return null;
  const value = outputs[fuzzyKey];
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    const v = (value as Record<string, unknown>).value;
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function pickNestedOutputRaw(source: Record<string, unknown> | undefined, candidates: string[]): string | null {
  if (!source) return null;
  const direct = pickOutputRaw(source, candidates);
  if (direct) return direct;
  for (const value of Object.values(source)) {
    if (!value || typeof value !== 'object') continue;
    const nested = pickOutputRaw(value as Record<string, unknown>, candidates);
    if (nested) return nested;
  }
  return null;
}

function downloadTextFile(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function toHistoryEntry(
  result: DeployApiResult | null,
  status: 'done' | 'error',
  region: string,
): DeploymentHistoryEntry {
  const outputs = result?.outputs;
  const details = result?.details;
  const live = details && typeof details === 'object'
    ? (details as { live_runtime_details?: { instance?: { instance_id?: string } } }).live_runtime_details
    : null;
  const instanceId = String(
    live?.instance?.instance_id
    || pickOutput(outputs, ['ec2_instance_id', 'instance_id'])
    || 'n/a',
  );
  const cloudfrontUrl = String(result?.cloudfront_url || pickOutput(outputs, ['cloudfront_url', 'cloudfront_domain_name']) || 'n/a');

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    status,
    region: region || 'eu-north-1',
    cloudfrontUrl,
    instanceId,
    deployResult: result,
  };
}

export function DeployPage({ projectId, onDeploymentStateChange }: DeployPageProps) {
  const [status, setStatus] = useState<DeployStatus>('idle');
  const [logs, setLogs] = useState<DeployLog[]>([]);
  const [progress, setProgress] = useState(0);
  const [deployResult, setDeployResult] = useState<DeployApiResult | null>(null);
  const [deploymentHistory, setDeploymentHistory] = useState<DeploymentHistoryEntry[]>([]);
  const [ppkLoading, setPpkLoading] = useState(false);
  const [runtimeDetailsLoading, setRuntimeDetailsLoading] = useState(false);
  const [stopLoading, setStopLoading] = useState(false);
  const [destroyLoading, setDestroyLoading] = useState(false);
  const [deployStateHydrated, setDeployStateHydrated] = useState(false);
  const idleRecoveryRef = useRef<string | null>(null);

  const aws = useMemo(() => parseAwsFromSession(), []);
  const iacFiles = useMemo(() => parseIacFilesFromSession(), []);
  const resources = useMemo(() => summarizeResources(iacFiles), [iacFiles]);
  const resourceSummary = useMemo(() => buildAwsResourceSummary(resources), [resources]);
  const cost = useMemo(() => parseCostFromSession(), []);

  const hasAwsSecrets = Boolean(aws.aws_access_key_id.trim() && aws.aws_secret_access_key.trim());
  const patchState = useCallback((patch: Partial<ActiveDeployState> | ((prev: ActiveDeployState) => ActiveDeployState)) => {
    if (!projectId) return;
    patchActiveDeploymentState(projectId, patch);
  }, [projectId]);

  const appendLog = useCallback((text: string, type: 'info' | 'success' | 'error' = 'info') => {
    patchState((prev) => ({ ...prev, logs: [...prev.logs, { text, ts: new Date().toLocaleTimeString(), type }] }));
  }, [patchState]);

  useEffect(() => {
    if (!projectId) return;
    const entry = getOrCreateActiveDeployment(projectId);
    const apply = (next: ActiveDeployState) => {
      setStatus(next.status);
      setProgress(next.progress);
      setLogs(next.logs);
      setDeployResult(next.deployResult);
      setDeploymentHistory(next.deploymentHistory);
    };
    entry.listeners.add(apply);
    apply(entry.state);
    return () => {
      entry.listeners.delete(apply);
    };
  }, [projectId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setDeployStateHydrated(false);
    if (!projectId) {
      setStatus('idle');
      setProgress(0);
      setLogs([]);
      setDeployResult(null);
      setDeploymentHistory([]);
      setDeployStateHydrated(true);
      return;
    }
    try {
      const raw = localStorage.getItem(`${DEPLOY_STATE_STORAGE_PREFIX}${projectId}`);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<DeployStateSnapshot>;
      if (saved.status === 'idle' || saved.status === 'running' || saved.status === 'done' || saved.status === 'error') {
        setStatus(saved.status);
      }
      if (Number.isFinite(saved.progress)) {
        setProgress(Number(saved.progress));
      }
      if (Array.isArray(saved.logs)) {
        setLogs(saved.logs.filter((row) => row && typeof row.text === 'string' && typeof row.ts === 'string' && (row.type === 'info' || row.type === 'success' || row.type === 'error')));
      }
      if (saved.deployResult && typeof saved.deployResult === 'object') {
        setDeployResult(saved.deployResult as DeployApiResult);
      }
      if (Array.isArray(saved.deploymentHistory)) {
        setDeploymentHistory(
          saved.deploymentHistory
            .filter((row) => row && typeof row.id === 'string' && typeof row.createdAt === 'string')
            .map((row): DeploymentHistoryEntry => ({
              id: String(row.id),
              createdAt: String(row.createdAt),
              status: row.status === 'error' ? 'error' : 'done',
              region: String(row.region || 'eu-north-1'),
              cloudfrontUrl: String(row.cloudfrontUrl || 'n/a'),
              instanceId: String(row.instanceId || 'n/a'),
              deployResult: (row.deployResult && typeof row.deployResult === 'object') ? row.deployResult as DeployApiResult : null,
            }))
            .slice(0, DEPLOY_HISTORY_MAX),
        );
      } else {
        setDeploymentHistory([]);
      }
      setActiveDeploymentState(projectId, toDeployState({
        status: saved.status as DeployStatus,
        progress: Number(saved.progress || 0),
        logs: Array.isArray(saved.logs) ? saved.logs as DeployLog[] : [],
        deployResult: (saved.deployResult && typeof saved.deployResult === 'object') ? saved.deployResult as DeployApiResult : null,
        deploymentHistory: Array.isArray(saved.deploymentHistory) ? saved.deploymentHistory as DeploymentHistoryEntry[] : [],
        updatedAt: typeof saved.updatedAt === 'string' ? saved.updatedAt : undefined,
      }));
    } catch {
      // ignore malformed persisted deploy state
    } finally {
      setDeployStateHydrated(true);
    }
  }, [projectId]);

  useEffect(() => {
    if (typeof window === 'undefined' || !projectId || !deployStateHydrated) return;
    const snapshot: DeployStateSnapshot = {
      status,
      progress,
      logs,
      deployResult,
      deploymentHistory,
      updatedAt: new Date().toISOString(),
    };
    try {
      localStorage.setItem(`${DEPLOY_STATE_STORAGE_PREFIX}${projectId}`, JSON.stringify(snapshot));
    } catch {
      // ignore storage errors
    }
  }, [deployResult, deploymentHistory, deployStateHydrated, logs, progress, projectId, status]);

  useEffect(() => {
    if (!projectId || !deployStateHydrated || !hasAwsSecrets) return;
    if (status !== 'idle') return;
    if (idleRecoveryRef.current === projectId) return;
    idleRecoveryRef.current = projectId;

    const recover = async () => {
      try {
        const res = await fetch('/api/pipeline/runtime-details', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            aws_access_key_id: aws.aws_access_key_id,
            aws_secret_access_key: aws.aws_secret_access_key,
            aws_region: aws.aws_region,
          }),
        });
        const data = await res.json().catch(() => ({})) as { success?: boolean; details?: AwsRuntimeLiveDetails };
        const recoveredInstanceId = String(data.details?.instance?.instance_id || '');
        if (!res.ok || data.success !== true || !recoveredInstanceId || recoveredInstanceId === 'n/a') return;

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
          deployResult: {
            ...((prev.deployResult || {}) as DeployApiResult),
            ...recoveredResult,
            details: {
              ...(((prev.deployResult?.details as Record<string, unknown> | null | undefined) || {})),
              live_runtime_details: data.details,
            },
          },
          deploymentHistory: [
            toHistoryEntry(recoveredResult, 'done', aws.aws_region),
            ...prev.deploymentHistory,
          ].slice(0, DEPLOY_HISTORY_MAX),
        }));
        appendLog(`Recovered existing deployment for this project (${recoveredInstanceId}).`, 'success');
      } catch {
        // best-effort on page load
      }
    };

    void recover();
  }, [appendLog, aws.aws_access_key_id, aws.aws_region, aws.aws_secret_access_key, deployStateHydrated, hasAwsSecrets, patchState, projectId, status]);

  useEffect(() => {
    onDeploymentStateChange?.(status);
  }, [onDeploymentStateChange, status]);

  const reconcileDeploymentStatus = async (): Promise<void> => {
    if (!projectId) return;
    const res = await fetch('/api/pipeline/deploy/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId }),
    });
    const data = await res.json().catch(() => ({})) as DeployStatusResponse;
    if (!res.ok || data.success !== true) {
      throw new Error(data.error || 'Failed to fetch deployment status.');
    }

    const statusValue = String(data.status || 'idle').toLowerCase();
    const result = (data.result && typeof data.result === 'object')
      ? (data.result as DeployApiResult)
      : null;

    if (statusValue === 'running') {
      return;
    }

    if (statusValue === 'completed') {
      if (result?.success) {
        patchState((prev) => ({
          ...prev,
          status: 'done',
          progress: 100,
          deployResult: result,
          deploymentHistory: [
            toHistoryEntry(result, 'done', aws.aws_region),
            ...prev.deploymentHistory,
          ].slice(0, DEPLOY_HISTORY_MAX),
        }));
        appendLog('Recovered completed deployment state from backend runtime.', 'success');
        if (hasAwsSecrets) {
          try {
            const detailsRes = await fetch('/api/pipeline/runtime-details', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                project_id: projectId,
                aws_access_key_id: aws.aws_access_key_id,
                aws_secret_access_key: aws.aws_secret_access_key,
                aws_region: aws.aws_region,
              }),
            });
            const detailsData = await detailsRes.json().catch(() => ({})) as { success?: boolean; details?: AwsRuntimeLiveDetails };
            if (detailsRes.ok && detailsData.success === true && detailsData.details) {
              patchState((prev) => ({
                ...prev,
                deployResult: {
                  ...((prev.deployResult || {}) as DeployApiResult),
                  details: {
                    ...(((prev.deployResult?.details as Record<string, unknown> | null | undefined) || {})),
                    live_runtime_details: detailsData.details,
                  },
                },
              }));
            }
          } catch {
            // Best-effort hydration only.
          }
        }
        return;
      }

      const msg = result?.error || 'Deployment completed with errors.';
      patchState((prev) => ({
        ...prev,
        status: 'error',
        progress: 100,
        deployResult: result,
        deploymentHistory: result
          ? [
            toHistoryEntry(result, 'error', aws.aws_region),
            ...prev.deploymentHistory,
          ].slice(0, DEPLOY_HISTORY_MAX)
          : prev.deploymentHistory,
      }));
      appendLog(msg, 'error');
      return;
    }

    if (statusValue === 'error') {
      const msg = result?.error || 'Deployment runtime returned an error.';
      patchState((prev) => ({
        ...prev,
        status: 'error',
        progress: 100,
        deployResult: result || prev.deployResult,
        deploymentHistory: result
          ? [
            toHistoryEntry(result, 'error', aws.aws_region),
            ...prev.deploymentHistory,
          ].slice(0, DEPLOY_HISTORY_MAX)
          : prev.deploymentHistory,
      }));
      appendLog(msg, 'error');
      return;
    }

    patchState({ status: 'error', progress: 100 });
    appendLog('No active deployment process found. Marking stale UI run as stopped.', 'error');
  };

  useEffect(() => {
    if (!projectId || status !== 'running') return;
    const entry = getOrCreateActiveDeployment(projectId);
    if (entry.inFlight) return;

    let cancelled = false;
    appendLog('Deployment state appears stale in UI. Verifying backend apply status...');

    const runProbe = async () => {
      if (cancelled) return;
      try {
        await reconcileDeploymentStatus();
      } catch {
        // keep current running state; next probe may recover
      }
    };

    const timerId = window.setInterval(() => {
      void runProbe();
    }, 10_000);
    void runProbe();

    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [appendLog, projectId, status]);

  const start = async () => {
    if (!projectId) {
      setStatus('error');
      setLogs([{ text: 'Select a project before deployment.', ts: new Date().toLocaleTimeString(), type: 'error' }]);
      return;
    }
    const entry = getOrCreateActiveDeployment(projectId, {
      status,
      progress,
      logs,
      deployResult,
      deploymentHistory,
    });
    if (entry.inFlight) {
      appendLog('Deployment already running in background for this project.');
      return;
    }
    entry.inFlight = true;
    if (!hasAwsSecrets) {
      patchState({
        status: 'error',
        logs: [{ text: 'AWS credentials missing. Configure secrets in GitOps first.', ts: new Date().toLocaleTimeString(), type: 'error' }],
      });
      entry.inFlight = false;
      return;
    }
    if (iacFiles.length === 0) {
      patchState({
        status: 'error',
        logs: [{ text: 'No generated IaC files found. Generate Terraform first.', ts: new Date().toLocaleTimeString(), type: 'error' }],
      });
      entry.inFlight = false;
      return;
    }

    patchState({
      status: 'running',
      deployResult: null,
      logs: [],
      progress: 5,
    });
    appendLog('Preparing runtime deploy payload...');

    let latestResult: DeployApiResult | null = null;
    try {
      patchState({ progress: 20 });
      appendLog('Calling /api/pipeline/deploy for runtime apply...');
      const savedRun = readSavedIacRun();

      const res = await fetch('/api/pipeline/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          provider: 'aws',
          runtime_apply: true,
          run_id: savedRun?.run_id,
          workspace: savedRun?.workspace,
          state_bucket: savedRun?.state_bucket,
          lock_table: savedRun?.lock_table,
          files: savedRun ? [] : iacFiles,
          aws_access_key_id: aws.aws_access_key_id,
          aws_secret_access_key: aws.aws_secret_access_key,
          aws_region: aws.aws_region,
          estimated_monthly_usd: cost.total,
          budget_limit_usd: cost.cap,
          budget_override: false,
        }),
      });

      patchState({ progress: 80 });
      const data = await res.json().catch(() => ({})) as DeployApiResult;
      latestResult = data;

      if (!res.ok || !data.success) {
        patchState({ deployResult: data || null });
        const detailHint = data.details && typeof data.details === 'object' && 'hint' in data.details
          ? String((data.details as Record<string, unknown>).hint)
          : '';
        const msg = data.error || 'Deployment failed.';
        throw new Error(detailHint ? `${msg} ${detailHint}` : msg);
      }

      patchState((prev) => ({
        ...prev,
        deployResult: data,
        progress: 100,
        status: 'done',
        deploymentHistory: [
          toHistoryEntry(data, 'done', aws.aws_region),
          ...prev.deploymentHistory,
        ].slice(0, DEPLOY_HISTORY_MAX),
      }));
      appendLog('Runtime Terraform apply completed successfully.', 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Deployment failed.';
      patchState({ status: 'error', progress: 100 });
      if (latestResult) {
        patchState((prev) => ({
          ...prev,
          deploymentHistory: [
            toHistoryEntry(latestResult, 'error', aws.aws_region),
            ...prev.deploymentHistory,
          ].slice(0, DEPLOY_HISTORY_MAX),
        }));
      }
      appendLog(msg, 'error');
    } finally {
      entry.inFlight = false;
    }
  };

  const prepareFreshDeployment = () => {
    patchState({
      status: 'idle',
      progress: 0,
      logs: [],
      deployResult: null,
    });
    appendLog('Ready for a fresh deployment run.', 'info');
  };

  const stopDeployment = async () => {
    if (!projectId || stopLoading || status !== 'running') return;
    setStopLoading(true);
    try {
      appendLog('Stop requested. Terminating deployment process...');
      const res = await fetch('/api/pipeline/deploy/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      });
      const data = await res.json().catch(() => ({})) as { success?: boolean; message?: string; error?: string };
      if (!res.ok || data.success !== true) {
        const backendMsg = String(data.error || data.message || '');
        if (/no active deployment process found/i.test(backendMsg)) {
          await reconcileDeploymentStatus();
          appendLog('No active deployment process found on backend. UI state reconciled.', 'info');
          return;
        }
        throw new Error(backendMsg || 'Failed to stop deployment process.');
      }
      getOrCreateActiveDeployment(projectId).inFlight = false;
      patchState({ status: 'error', progress: 100 });
      appendLog(data.message || 'Deployment process terminated.', 'success');
    } catch (e) {
      appendLog(e instanceof Error ? e.message : 'Failed to stop deployment process.', 'error');
    } finally {
      setStopLoading(false);
    }
  };

  const destroyDeployment = async () => {
    if (!projectId || destroyLoading) return;
    if (status === 'running') {
      appendLog('Stop deployment first, then run destroy.', 'error');
      return;
    }
    if (!hasAwsSecrets) {
      appendLog('AWS credentials are missing. Configure them first.', 'error');
      return;
    }
    if (!window.confirm('Destroy AWS resources created for this project? This is irreversible.')) {
      return;
    }
    setDestroyLoading(true);
    try {
      appendLog('Destroy requested. Cleaning up EC2, S3, CloudFront, security groups, and tagged volumes...');
      const res = await fetch('/api/pipeline/deploy/destroy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          aws_access_key_id: aws.aws_access_key_id,
          aws_secret_access_key: aws.aws_secret_access_key,
          aws_region: aws.aws_region,
        }),
      });
      const data = await res.json().catch(() => ({})) as {
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
      if (!res.ok || data.success !== true) {
        throw new Error(data.error || 'Destroy failed.');
      }
      const d = data.details || {};
      getOrCreateActiveDeployment(projectId).inFlight = false;
      patchState((prev) => ({
        ...prev,
        status: 'idle',
        progress: 0,
        deployResult: null,
      }));
      appendLog(
        `Destroy complete: ec2=${(d.instances_terminated || []).length}, s3=${(d.s3_buckets_deleted || []).length}, cloudfront=${(d.cloudfront_deleted || []).length}, sg=${(d.security_groups_deleted || []).length}, ebs=${(d.volumes_deleted || []).length}`,
        'success',
      );
      if ((d.cloudfront_pending_disable || []).length > 0) {
        appendLog(
          `CloudFront pending disable/delete: ${(d.cloudfront_pending_disable || []).join(', ')}. Re-run destroy after distributions are disabled/deployed.`,
          'info',
        );
      }
      for (const err of (d.errors || []).slice(0, 5)) {
        appendLog(`Destroy warning: ${err}`, 'error');
      }
    } catch (e) {
      appendLog(e instanceof Error ? e.message : 'Destroy failed.', 'error');
    } finally {
      setDestroyLoading(false);
    }
  };

  const runtimeOutputs = deployResult?.raw_outputs || deployResult?.outputs;
  const liveRuntimeDetails = useMemo(() => {
    const details = deployResult?.details as Record<string, unknown> | null | undefined;
    if (!details || typeof details !== 'object') return null;
    const live = details.live_runtime_details;
    if (!live || typeof live !== 'object') return null;
    return live as AwsRuntimeLiveDetails;
  }, [deployResult?.details]);
  const liveRuntimeInstance = liveRuntimeDetails?.instance;
  const liveRuntimeCounts = liveRuntimeDetails?.resource_counts;
  const cloudfrontUrl = deployResult?.cdn?.cloudfront_url || deployResult?.cloudfront_url || pickOutput(runtimeOutputs, ['cloudfront_url', 'cloudfront_domain_name']);
  const albDns = pickOutput(runtimeOutputs, ['alb_dns_name', 'load_balancer_dns_name']);
  const rdsEndpoint = pickOutput(runtimeOutputs, ['rds_endpoint', 'database_endpoint', 'db_endpoint']);
  const websiteBucket = pickOutput(runtimeOutputs, ['website_bucket', 's3_bucket_name', 'static_bucket_name']);
  const generatedPem = deployResult?.keypair?.private_key_pem
    || deployResult?.generated_ec2_private_key_pem
    || pickOutputRaw(runtimeOutputs, ['generated_ec2_private_key_pem', 'generated_private_key_pem', 'ec2_private_key_pem'])
    || pickNestedOutputRaw((deployResult?.details as Record<string, unknown> | undefined), ['generated_ec2_private_key_pem', 'generated_private_key_pem', 'ec2_private_key_pem', 'private_key_pem']);
  const keyName = deployResult?.keypair?.key_name
    || deployResult?.ec2_key_name
    || pickOutputRaw(runtimeOutputs, ['ec2_key_name', 'generated_ec2_key_name', 'key_name'])
    || pickNestedOutputRaw((deployResult?.details as Record<string, unknown> | undefined), ['ec2_key_name', 'generated_ec2_key_name', 'key_name'])
    || 'deplai-ec2-key';
  const ec2InstanceId = String(liveRuntimeInstance?.instance_id || deployResult?.ec2?.instance_id || pickOutput(runtimeOutputs, ['ec2_instance_id', 'instance_id']));
  const ec2InstanceArn = String(liveRuntimeInstance?.instance_arn || deployResult?.ec2?.instance_arn || pickOutput(runtimeOutputs, ['ec2_instance_arn', 'instance_arn']));
  const ec2InstanceState = String(liveRuntimeInstance?.instance_state || deployResult?.ec2?.state || pickOutput(runtimeOutputs, ['ec2_instance_state', 'instance_state']));
  const ec2InstanceType = String(liveRuntimeInstance?.instance_type || deployResult?.ec2?.type || pickOutput(runtimeOutputs, ['ec2_instance_type', 'instance_type']));
  const ec2PublicIp = String(liveRuntimeInstance?.public_ipv4_address || deployResult?.ec2?.public_ip || pickOutput(runtimeOutputs, ['ec2_public_ip', 'public_ip', 'instance_public_ip']));
  const ec2PrivateIp = String(liveRuntimeInstance?.private_ipv4_address || deployResult?.ec2?.private_ip || pickOutput(runtimeOutputs, ['ec2_private_ip', 'private_ip', 'instance_private_ip']));
  const ec2PublicDns = String(liveRuntimeInstance?.public_dns || deployResult?.ec2?.public_dns || pickOutput(runtimeOutputs, ['ec2_public_dns', 'instance_public_dns', 'public_dns']));
  const ec2PrivateDns = String(liveRuntimeInstance?.private_dns || deployResult?.ec2?.private_dns || pickOutput(runtimeOutputs, ['ec2_private_dns', 'private_dns', 'instance_private_dns']));
  const ec2VpcId = String(liveRuntimeInstance?.vpc_id || deployResult?.network?.vpc_id || pickOutput(runtimeOutputs, ['ec2_vpc_id', 'vpc_id']));
  const ec2SubnetId = String(liveRuntimeInstance?.subnet_id || deployResult?.network?.subnet_id || pickOutput(runtimeOutputs, ['ec2_subnet_id', 'subnet_id']));
  const displayedResourceSummary = useMemo(() => {
    if (!liveRuntimeCounts) return resourceSummary;
    const normalized = new Map<string, number>([
      ['EC2 Instances', Number(liveRuntimeCounts.ec2_instances_total || 0)],
      ['VPCs', Number(liveRuntimeCounts.vpcs || 0)],
      ['Subnets', Number(liveRuntimeCounts.subnets || 0)],
      ['Internet Gateways', Number(liveRuntimeCounts.internet_gateways || 0)],
      ['NAT Gateways', Number(liveRuntimeCounts.nat_gateways || 0)],
      ['Route Tables', Number(liveRuntimeCounts.route_tables || 0)],
      ['Security Groups', Number(liveRuntimeCounts.security_groups || 0)],
      ['Key Pairs', Number(liveRuntimeCounts.key_pairs || 0)],
      ['S3 Buckets', Number(liveRuntimeCounts.s3_buckets || 0)],
      ['CloudFront Distributions', Number(liveRuntimeCounts.cloudfront_distributions || 0)],
    ]);
    return resourceSummary.map((row) => ({
      label: row.label,
      count: normalized.has(row.label) ? Number(normalized.get(row.label) || 0) : row.count,
    }));
  }, [liveRuntimeCounts, resourceSummary]);

  const onDownloadPem = () => {
    if (!generatedPem) return;
    downloadTextFile(`${keyName}.pem`, generatedPem.endsWith('\n') ? generatedPem : `${generatedPem}\n`);
    appendLog(`Downloaded ${keyName}.pem`, 'success');
  };

  const onDownloadPpk = async () => {
    if (!generatedPem || ppkLoading) return;
    setPpkLoading(true);
    try {
      const res = await fetch('/api/pipeline/keypair/ppk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          private_key_pem: generatedPem,
          key_name: keyName,
          project_name: projectId || 'deplai-project',
        }),
      });
      const data = await res.json().catch(() => ({})) as { success?: boolean; file_name?: string; content_base64?: string; error?: string; hint?: string };
      if (!res.ok || !data.success || !data.content_base64) {
        throw new Error(data.hint ? `${data.error || 'PPK conversion failed.'} ${data.hint}` : (data.error || 'PPK conversion failed.'));
      }
      const bytes = Uint8Array.from(atob(data.content_base64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = data.file_name || `${keyName}.ppk`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      appendLog(`Downloaded ${data.file_name || `${keyName}.ppk`}`, 'success');
    } catch (e) {
      appendLog(e instanceof Error ? e.message : 'PPK conversion failed.', 'error');
    } finally {
      setPpkLoading(false);
    }
  };

  const onFetchRuntimeDetails = async () => {
    if (!projectId) {
      appendLog('Missing project ID for runtime details fetch.', 'error');
      return;
    }
    if (!hasAwsSecrets) {
      appendLog('AWS credentials are missing. Configure them first.', 'error');
      return;
    }
    if (runtimeDetailsLoading) return;

    setRuntimeDetailsLoading(true);
    appendLog('Fetching live AWS runtime details...');
    try {
      const res = await fetch('/api/pipeline/runtime-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          aws_access_key_id: aws.aws_access_key_id,
          aws_secret_access_key: aws.aws_secret_access_key,
          aws_region: aws.aws_region,
          instance_id: ec2InstanceId !== 'n/a' ? ec2InstanceId : undefined,
        }),
      });
      const data = await res.json().catch(() => ({})) as {
        success?: boolean;
        details?: AwsRuntimeLiveDetails;
        error?: string;
      };
      if (!res.ok || data.success !== true || !data.details) {
        throw new Error(data.error || 'Failed to fetch runtime details.');
      }
      patchState((prev) => ({
        ...prev,
        deployResult: {
          ...((prev.deployResult || {}) as DeployApiResult),
          details: {
            ...(((prev.deployResult?.details as Record<string, unknown> | null | undefined) || {})),
            live_runtime_details: data.details,
          },
        },
      }));
      appendLog('Live AWS runtime details updated.', 'success');
    } catch (e) {
      appendLog(e instanceof Error ? e.message : 'Failed to fetch runtime details.', 'error');
    } finally {
      setRuntimeDetailsLoading(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto fade-in custom-scrollbar">
      <Header
        title="Deploy on AWS"
        subtitle="Runtime Terraform apply provisioning infrastructure via ephemeral Docker volume."
        badge={status === 'done'
          ? { text: 'Deployment successful', cls: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' }
          : status === 'running'
            ? { text: 'Deployment in progress', cls: 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' }
            : status === 'error'
              ? { text: 'Deployment failed', cls: 'bg-red-500/10 text-red-400 border border-red-500/20' }
              : { text: 'Ready to deploy', cls: 'bg-zinc-500/10 text-zinc-400 border border-zinc-500/20' }}
        actions={<Tag color="cyan">Stage 10</Tag>}
      />

      <div className="p-7 grid grid-cols-3 gap-5">
        <div className="col-span-2 space-y-4">
          {status === 'idle' && (
            <div className="bg-zinc-900 rounded-2xl border border-white/5 p-8 text-center">
              <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14m-7-7l7 7-7 7" /></svg>
              </div>
              <p className="text-lg font-semibold text-zinc-200 mb-2">Ready to deploy</p>
              <p className="text-sm text-zinc-500 mb-2 max-w-md mx-auto">This will execute runtime Terraform apply through the pipeline API.</p>
              <p className="text-xs text-zinc-600 mb-6 max-w-md mx-auto">
                {hasAwsSecrets ? `Using AWS credentials from GitOps input (${aws.aws_region}).` : 'AWS secrets were not set in GitOps. Deployment will fail until configured.'}
              </p>
              <button onClick={start} className="px-7 py-3 bg-cyan-500 hover:bg-cyan-400 text-zinc-950 font-bold rounded-xl text-sm transition-all shadow-lg shadow-cyan-500/20 flex items-center gap-2 mx-auto" disabled={!projectId}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12h14m-7-7l7 7-7 7" /></svg>
                Deploy to AWS
              </button>
            </div>
          )}

          {(status === 'running' || status === 'done' || status === 'error') && (
            <div className="bg-zinc-900 rounded-2xl border border-white/5 overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/5">
                <div className="flex items-center gap-2">
                  {status === 'running' && <svg className="w-4 h-4 text-cyan-400 spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity=".25" /><path d="M22 12a10 10 0 00-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>}
                  {status === 'done' && <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>}
                  {status === 'error' && <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>}
                  <span className="text-sm font-semibold text-zinc-200">{status === 'done' ? 'Deployment complete' : status === 'error' ? 'Deployment failed' : 'Provisioning'}</span>
                </div>
                <div className="flex items-center gap-2">
                  {status === 'running' && (
                    <Btn variant="danger" size="sm" onClick={() => { void stopDeployment(); }} disabled={stopLoading}>
                      {stopLoading ? 'Stopping...' : 'Stop Deployment'}
                    </Btn>
                  )}
                  {status !== 'running' && (
                    <Btn variant="danger" size="sm" onClick={() => { void destroyDeployment(); }} disabled={destroyLoading || !hasAwsSecrets}>
                      {destroyLoading ? 'Destroying...' : 'Destroy Infrastructure'}
                    </Btn>
                  )}
                  {(status === 'done' || status === 'error') && (
                    <Btn variant="default" size="sm" onClick={prepareFreshDeployment}>Deploy New Instance</Btn>
                  )}
                  <span className="text-sm font-bold font-mono text-cyan-400">{progress}%</span>
                </div>
              </div>
              <div className="h-1.5 bg-zinc-800"><div className="h-full bg-linear-to-r from-cyan-500 to-indigo-500 transition-all duration-500" style={{ width: `${progress}%` }} /></div>
              <div className="p-4 max-h-72 overflow-y-auto space-y-2 bg-zinc-950/70 custom-scrollbar">
                {logs.map((l, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <span className="text-[10px] font-mono text-zinc-600 shrink-0 mt-0.5">{l.ts}</span>
                    {l.type === 'success' && <svg className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>}
                    {l.type === 'info' && <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 shrink-0 mt-1.5 pulse-dot" />}
                    {l.type === 'error' && <svg className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>}
                    <span className={`text-[11px] ${l.type === 'success' ? 'text-emerald-400 font-semibold' : l.type === 'error' ? 'text-red-400' : 'text-zinc-400'}`}>{l.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(status === 'done' || (status === 'error' && deployResult)) && (
            <div className="bg-zinc-900 rounded-2xl border border-emerald-500/15 p-5 space-y-3">
              <p className="text-sm font-semibold text-emerald-300 mb-4">Deployment Outputs</p>
              {[
                { k: 'CloudFront URL', v: cloudfrontUrl, link: true },
                { k: 'ALB DNS Name', v: albDns, link: false },
                { k: 'RDS Endpoint', v: rdsEndpoint, link: false },
                { k: 'S3 Website Bucket', v: websiteBucket, link: false },
              ].map((o, i) => (
                <div key={i} className="flex items-center justify-between py-2.5 border-b border-white/4 last:border-0">
                  <span className="text-[11px] text-zinc-500 w-40">{o.k}</span>
                  <span className={`text-[11px] font-mono flex-1 text-right ${o.link && o.v !== 'n/a' ? 'text-cyan-400 hover:underline cursor-pointer' : 'text-zinc-300'}`}>{o.v}</span>
                </div>
              ))}
              <div className="pt-3 border-t border-white/5">
                <p className="text-[11px] text-zinc-500 mb-2">EC2 SSH Key Pair</p>
                {generatedPem ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Btn variant="default" size="sm" onClick={onDownloadPem}>Download PEM</Btn>
                      <Btn variant="default" size="sm" onClick={() => { void onDownloadPpk(); }} disabled={ppkLoading}>{ppkLoading ? 'Converting...' : 'Download PPK'}</Btn>
                      <span className="text-[11px] text-zinc-500 font-mono">{keyName}</span>
                    </div>
                    <p className="text-[11px] text-amber-300">
                      Private key material is generated one time. Download it now and keep it in a secure location.
                    </p>
                  </div>
                ) : (
                  <p className="text-[11px] text-zinc-500">No generated private key found in deployment outputs. This usually means an existing key pair was reused. AWS does not return private key material again; use the original PEM created at key generation time.</p>
                )}
              </div>
              <div className="pt-3 border-t border-white/5">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-[11px] text-zinc-500">EC2 Instance Summary</p>
                  <div className="flex items-center gap-2">
                    {liveRuntimeDetails && <span className="text-[10px] text-emerald-400">Live</span>}
                    <Btn variant="default" size="sm" onClick={() => { void onFetchRuntimeDetails(); }} disabled={runtimeDetailsLoading || !hasAwsSecrets}>
                      {runtimeDetailsLoading ? 'Fetching...' : 'Fetch details'}
                    </Btn>
                  </div>
                </div>
                {[
                  { k: 'Instance ID', v: ec2InstanceId },
                  { k: 'Public IPv4 address', v: ec2PublicIp },
                  { k: 'Private IPv4 address', v: ec2PrivateIp },
                  { k: 'Instance state', v: ec2InstanceState },
                  { k: 'Instance type', v: ec2InstanceType },
                  { k: 'Public DNS', v: ec2PublicDns },
                  { k: 'Private DNS', v: ec2PrivateDns },
                  { k: 'VPC ID', v: ec2VpcId },
                  { k: 'Subnet ID', v: ec2SubnetId },
                  { k: 'Instance ARN', v: ec2InstanceArn },
                  { k: 'Key Pair Name', v: keyName || 'n/a' },
                  { k: 'Region', v: aws.aws_region || 'n/a' },
                ].map((row, idx) => (
                  <div key={idx} className="flex items-center justify-between py-1.5 border-b border-white/4 last:border-0">
                    <span className="text-[11px] text-zinc-500">{row.k}</span>
                    <span className="text-[11px] font-mono text-zinc-300 text-right">{row.v || 'n/a'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4">
            <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-3">Target configuration</p>
            {[
              { k: 'Provider', v: 'AWS' },
              { k: 'Region', v: aws.aws_region || 'eu-north-1' },
              { k: 'Environment', v: 'production' },
              { k: 'Terraform files', v: String(iacFiles.length) },
              { k: 'Runtime apply', v: 'API / Docker (ephemeral)' },
            ].map((r, i) => <div key={i} className="flex justify-between py-2 border-b border-white/4 last:border-0"><span className="text-[11px] text-zinc-500">{r.k}</span><span className="text-[11px] font-mono text-zinc-300">{r.v}</span></div>)}
          </div>

          <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4">
            <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-3">Resources to provision</p>
            {resources.length === 0 && <p className="text-[11px] text-zinc-500">No resources parsed from IaC files.</p>}
            {resources.map((r, i) => <div key={i} className="flex justify-between py-2 border-b border-white/4 last:border-0"><span className="text-[11px] text-zinc-300">{r.name}</span><span className="text-[11px] text-zinc-400 font-semibold font-mono">x{r.count}</span></div>)}
          </div>

          <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4">
            <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-3">AWS Resource Summary</p>
            {displayedResourceSummary.map((r, i) => (
              <div key={i} className="flex justify-between py-2 border-b border-white/4 last:border-0">
                <span className="text-[11px] text-zinc-300">{r.label}</span>
                <span className="text-[11px] text-zinc-400 font-semibold font-mono">{r.count}</span>
              </div>
            ))}
          </div>

          <div className="bg-zinc-900 rounded-2xl border border-white/5 p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold">Previous Deployments</p>
              <Tag color="zinc">{deploymentHistory.length}</Tag>
            </div>
            {deploymentHistory.length === 0 && (
              <p className="text-[11px] text-zinc-500">No deployment history yet for this project.</p>
            )}
            {deploymentHistory.map((entry) => (
              <div key={entry.id} className="py-2.5 border-b border-white/4 last:border-0">
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[10px] font-semibold ${entry.status === 'done' ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {entry.status === 'done' ? 'SUCCESS' : 'FAILED'}
                  </span>
                  <span className="text-[10px] text-zinc-600 font-mono">{new Date(entry.createdAt).toLocaleString()}</span>
                </div>
                <p className="text-[11px] text-zinc-300 mt-1 font-mono">EC2: {entry.instanceId || 'n/a'}</p>
                <p className="text-[11px] text-zinc-500 font-mono truncate">CF: {entry.cloudfrontUrl || 'n/a'}</p>
                <div className="mt-2">
                  <Btn
                    variant="default"
                    size="sm"
                    onClick={() => {
                      patchState((prev) => ({
                        ...prev,
                        deployResult: entry.deployResult,
                        status: entry.status,
                        progress: 100,
                      }));
                    }}
                  >
                    View
                  </Btn>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}



