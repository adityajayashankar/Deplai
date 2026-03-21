'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useScan, type ScanMessage } from '@/lib/scan-context';
import {
  CheckCircle, CircleDashed, Loader, AlertTriangle, XCircle,
  Terminal, DollarSign, Play, RotateCcw,
  Server, Lock, Send,
  MessageSquare, Wifi, Cpu, Layers, GitMerge,
  FastForward, ArrowUpRight
} from 'lucide-react';

type StageStatus = 'pending' | 'running' | 'paused' | 'success' | 'failed' | 'skipped';

interface Stage {
  id: number;
  label: string;
  status: StageStatus;
  duration?: string;
  isGate?: boolean;
}

interface DashboardUser {
  login: string;
  name: string;
  avatarUrl: string;
}

interface ProjectItem {
  id: string;
  type: 'local' | 'github';
  name?: string;
  owner?: string;
  repo?: string;
  installationId?: string;
}

interface HealthCheck {
  name: string;
  state: 'healthy' | 'degraded' | 'down';
  detail: string;
}

interface HealthPayload {
  checks?: HealthCheck[];
}

interface ScanResultsData {
  supply_chain?: Array<{ severity?: string }>;
  code_security?: Array<{ severity?: string; count?: number }>;
}

interface GeneratedFile {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
}

interface DeploymentSummary {
  cloudfrontUrl: string | null;
  instanceUrl: string | null;
  instancePublicIp: string | null;
  securityLogsBucket: string | null;
  websiteBucket: string | null;
}

interface DiagramNodePreview {
  id: string;
  label: string;
  type: string;
  icon_name: string;
  icon_url: string;
}

const MESSAGE_STYLES: Record<string, { color: string; prefix: string }> = {
  success:          { color: 'text-green-400',                    prefix: '[+]'          },
  warning:          { color: 'text-yellow-400',                   prefix: '[!]'          },
  phase:            { color: 'text-blue-400 font-bold',           prefix: ''             },
  error:            { color: 'text-red-500',                      prefix: '[ERR]'        },
  info:             { color: 'text-gray-300',                     prefix: '[*]'          },
  kg_phase:         { color: 'text-violet-400 font-medium',       prefix: '[KG]'         },
  planner_phase:    { color: 'text-orange-400 font-medium',       prefix: '[PLANNER]'    },
  supervisor_phase: { color: 'text-sky-400 font-bold',            prefix: '[SUPERVISOR]' },
  proposer_phase:   { color: 'text-amber-400 font-medium',        prefix: '[PROPOSER]'   },
  critic_phase:     { color: 'text-rose-400 font-medium',         prefix: '[CRITIC]'     },
  synthesizer_phase:{ color: 'text-emerald-400 font-medium',      prefix: '[SYNTH]'      },
};

function DeplaiMark() {
  return (
    <svg viewBox="0 0 28 28" className="w-5 h-5" fill="none" aria-hidden="true">
      <polygon points="14,2 25,8 25,20 14,26 3,20 3,8" stroke="currentColor" strokeWidth="1.5" className="text-cyan-300" />
      <circle cx="14" cy="14" r="3" fill="currentColor" className="text-cyan-300" />
    </svg>
  );
}

const INITIAL_STAGES: Stage[] = [
  { id: 0, label: 'preflight checks', status: 'pending' },
  { id: 1, label: 'run_scan (SAST/SCA)', status: 'pending' },
  { id: 2, label: 'KG Agent analysis', status: 'pending' },
  { id: 3, label: 'remediate vulnerabilities', status: 'pending' },
  { id: 4, label: 'create PR', status: 'pending' },
  { id: 4.5, label: 'merge gate', status: 'pending', isGate: true },
  { id: 4.6, label: 'post-merge actions', status: 'pending' },
  { id: 6, label: 'Q/A context gathering', status: 'pending', isGate: true },
  { id: 7, label: 'generate diagram + estimate_cost', status: 'pending' },
  { id: 7.5, label: 'approve architecture + cost', status: 'pending', isGate: true },
  { id: 8, label: 'generate terraform (+ansible skeleton)', status: 'pending' },
  { id: 9, label: 'gitops (budget check)', status: 'pending', isGate: true },
  { id: 10, label: 'deploy on AWS', status: 'pending', isGate: true }
];

const MAX_CYCLES = 2;
const FREE_TIER_MODE = (process.env.NEXT_PUBLIC_AWS_FREE_TIER_MODE || 'true').toLowerCase() === 'true';
const BUDGET_CAP = FREE_TIER_MODE
  ? Number(process.env.NEXT_PUBLIC_FREE_TIER_BUDGET_USD || 5)
  : 100;
const WS_BASE_URL = process.env.NEXT_PUBLIC_AGENTIC_WS_URL || 'ws://localhost:8000';
const PIPELINE_SELECTED_PROJECT_KEY = 'deplai.pipeline.selected-project-id';
const QA_QUESTIONS = [
  'What AWS region do you want to deploy in, and do you need multi-AZ resilience?',
  'For this repository, what runtime stack and entrypoint should run on EC2 (for example: Python + uvicorn, Node + pm2, Java + systemd)?',
  'How should code be built on the instance for large repos (build command, artifact path, and expected build time)?',
  'What baseline EC2 sizing do you expect for this repo (vCPU/RAM), and do you need burstable, compute-optimized, or memory-optimized instances?',
  'What traffic/load profile do you expect (peak RPS, concurrent users, or batch throughput)?',
  'Do you need horizontal scaling now (ASG + ALB), or is a single-instance rollout acceptable for phase 1?',
  'What storage footprint do you need on EC2/EBS (repo checkout size, generated artifacts, logs, and growth per month)?',
  'Do any background jobs or long-running workers need separate process management from the web service?',
  'Which ports/protocols must be exposed publicly, and which should stay private within VPC only?',
  'Should this be internet-facing via CloudFront, and do you have a custom domain/certificate ready?',
  'For S3 website hosting, should Block Public Access remain ON (recommended) or be turned OFF?',
  'What secret/config strategy should be used (SSM Parameter Store, Secrets Manager, or env-only at runtime)?',
  'What observability do you require at launch (CloudWatch metrics/log retention, alarms, dashboards, tracing)?',
  'Any strict compliance, backup/DR, or cost guardrails we must enforce before deployment?',
];

function defaultAnswerForQuestion(question: string): string {
  const q = question.toLowerCase();
  if (q.includes('region')) return 'ap-south-1, single-AZ is acceptable for now (AWS Free Tier mode).';
  if (q.includes('runtime stack') || q.includes('entrypoint')) return 'Python service, run with uvicorn using one process.';
  if (q.includes('build on the instance')) return 'Use minimal build steps, cache dependencies, keep build under 5 minutes.';
  if (q.includes('ec2 sizing')) return 'Use t3.micro baseline only (Free Tier safe).';
  if (q.includes('traffic/load')) return 'Very low traffic, under 1M requests per month, single instance only.';
  if (q.includes('horizontal scaling')) return 'Single-instance rollout for phase 1.';
  if (q.includes('storage footprint')) return 'Keep storage minimal: <=5GB website, <=5GB logs, and exactly 8GB EC2 root volume on gp3.';
  if (q.includes('background jobs')) return 'No separate workers required initially.';
  if (q.includes('ports/protocols')) return 'Expose only HTTP/HTTPS; keep all internal services private.';
  if (q.includes('internet-facing') || q.includes('custom domain')) return 'Internet-facing via CloudFront, no custom domain yet.';
  if (q.includes('block public access')) return 'Keep Block Public Access ON.';
  if (q.includes('secret/config strategy')) return 'Use environment variables for now; migrate to SSM later.';
  if (q.includes('observability')) return 'Basic CloudWatch logs and essential alarms only, short retention.';
  if (q.includes('compliance') || q.includes('cost guardrails')) return 'Enforce AWS Free Tier constraints and hard low-cost posture.';
  return 'Use minimal-cost default configuration.';
}

function buildDefaultQaSummary(): string {
  return QA_QUESTIONS.map((q) => `Q: ${q}\nA: ${defaultAnswerForQuestion(q)}`).join('\n\n');
}

export default function App() {
  const router = useRouter();
  const {
    startScan,
    startRemediation,
    approveRemediationRescan,
    getScanState,
    getRemediationState,
    resetAll,
  } = useScan();
  const [stages, setStages] = useState<Stage[]>(INITIAL_STAGES);
  const [activeStageId, setActiveStageId] = useState<number | null>(null);
  const [cycle, setCycle] = useState(1);
  const [logs, setLogs] = useState<{ id: string; text: string }[]>([]);
  const [majorFindingsRemaining, setMajorFindingsRemaining] = useState<number | null>(null);
  const [costEstimate, setCostEstimate] = useState(0);
  const [qaSummary, setQaSummary] = useState('');
  const [architectureJson, setArchitectureJson] = useState<Record<string, unknown> | null>(null);
  const [generatedIacFiles, setGeneratedIacFiles] = useState<GeneratedFile[]>([]);
  const [generatedDiagram, setGeneratedDiagram] = useState<string | null>(null);
  const [generatedDiagramNodes, setGeneratedDiagramNodes] = useState<DiagramNodePreview[]>([]);
  const [deploymentSummary, setDeploymentSummary] = useState<DeploymentSummary | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [budgetOverridden, setBudgetOverridden] = useState(false);
  const [runtimeGithubToken, setRuntimeGithubToken] = useState('');
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('');
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState('');
  const [awsRegion, setAwsRegion] = useState('ap-south-1');
  const [isRunning, setIsRunning] = useState(false);
  const [pipelineState, setPipelineState] = useState<'idle' | 'running' | 'paused' | 'failed' | 'completed'>('idle');
  const [isManuallyPaused, setIsManuallyPaused] = useState(false);
  const [user, setUser] = useState<DashboardUser | null>(null);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [pipelineRunId, setPipelineRunId] = useState(0);
  const [remediationPrUrl, setRemediationPrUrl] = useState<string | null>(null);

  const [qaMessages, setQaMessages] = useState<{ role: 'agent' | 'user', text: string }[]>([
    { role: 'agent', text: QA_QUESTIONS[0] }
  ]);
  const [qaStep, setQaStep] = useState(0);
  const [qaInput, setQaInput] = useState('');
  const [isAgentTyping, setIsAgentTyping] = useState(false);
  const [pipelineWsMessages, setPipelineWsMessages] = useState<ScanMessage[]>([]);
  const [pipelineWsState, setPipelineWsState] = useState<'idle' | 'running' | 'error'>('idle');

  const logsEndRef = useRef<HTMLDivElement>(null);
  const stageOpsRef = useRef<Record<string, boolean>>({});
  const pipelineWsRef = useRef<WebSocket | null>(null);
  const selectedProjectIdRef = useRef('');

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) || null,
    [projects, selectedProjectId],
  );

  const selectedProjectName = useMemo(() => {
    if (!selectedProject) return '';
    if (selectedProject.type === 'github') {
      if (selectedProject.owner && selectedProject.repo) {
        return `${selectedProject.owner}/${selectedProject.repo}`;
      }
      return selectedProject.name || selectedProject.id;
    }
    return selectedProject.name || selectedProject.id;
  }, [selectedProject]);

  const { state: scanState, messages: scanMessages } = getScanState(selectedProjectId || '');
  const { state: remediationState, messages: remediationMessages } = getRemediationState(selectedProjectId || '');

  const monitorMessages = useMemo<ScanMessage[]>(() => {
    if (!selectedProjectId) return [];
    return [...scanMessages, ...remediationMessages, ...pipelineWsMessages];
  }, [pipelineWsMessages, remediationMessages, scanMessages, selectedProjectId]);

  const mergeGateRequired = useMemo(
    () => selectedProject?.type === 'github' && Boolean(remediationPrUrl),
    [selectedProject, remediationPrUrl],
  );

  const monitorState = useMemo(() => {
    if (remediationState !== 'idle') return remediationState;
    if (scanState !== 'idle') return scanState;
    return pipelineWsState;
  }, [pipelineWsState, remediationState, scanState]);

  const emitPipelineEvent = useCallback((text: string) => {
    const ws = pipelineWsRef.current;
    const projectId = selectedProjectIdRef.current;
    if (!projectId || !ws || ws.readyState !== WebSocket.OPEN) return;

    let type = 'info';
    if (text.includes('[ERROR]') || text.includes('[FATAL]')) type = 'error';
    else if (text.includes('[WARN]') || text.includes('VIOLATION')) type = 'warning';
    else if (text.includes('[SYSTEM]') || text.includes('>>>') || text.includes('<<<')) type = 'phase';
    else if (text.includes('[OUTPUT]')) type = 'success';

    try {
      ws.send(JSON.stringify({ action: 'emit', data: { type, content: text } }));
    } catch {
      // Ignore transient socket send failures in UI.
    }
  }, []);

  const addLog = useCallback((text: string) => {
    setLogs(prev => [...prev, { id: Math.random().toString(36).slice(2, 11), text }]);
    emitPipelineEvent(text);
  }, [emitPipelineEvent]);

  const markOpStarted = useCallback((key: string) => {
    stageOpsRef.current[key] = true;
  }, []);

  const opStarted = useCallback((key: string) => {
    return stageOpsRef.current[key] === true;
  }, []);

  const setStageStatus = useCallback((id: number, status: StageStatus, duration?: string) => {
    setStages(prev => prev.map(stage => {
      if (stage.id !== id) return stage;
      return { ...stage, status, duration: duration ?? stage.duration };
    }));
  }, []);

  const completeStage = useCallback((id: number, duration?: string) => {
    setStageStatus(id, 'success', duration ?? 'OK');
  }, [setStageStatus]);

  const failStage = useCallback((id: number, reason: string) => {
    setStageStatus(id, 'failed');
    setPipelineState('failed');
    setIsRunning(false);
    addLog(`[ERROR] ${reason}`);
  }, [addLog, setStageStatus]);

  const fetchPipelineWsToken = useCallback(async (projectId: string): Promise<string> => {
    try {
      const res = await fetch(`/api/scan/ws-token?project_id=${encodeURIComponent(projectId)}`);
      if (!res.ok) return '';
      const data = await res.json().catch(() => ({})) as { token?: string };
      return typeof data.token === 'string' ? data.token : '';
    } catch {
      return '';
    }
  }, []);

  const countMajorFindings = useCallback((data: ScanResultsData | undefined): number => {
    if (!data) return 0;
    const supply = Array.isArray(data.supply_chain) ? data.supply_chain : [];
    const code = Array.isArray(data.code_security) ? data.code_security : [];

    const supplyMajor = supply.filter(item => {
      const sev = String(item.severity || '').toLowerCase();
      return sev === 'critical' || sev === 'high';
    }).length;

    const codeMajor = code.reduce((sum, item) => {
      const sev = String(item.severity || '').toLowerCase();
      if (sev !== 'critical' && sev !== 'high') return sum;
      return sum + Number(item.count || 1);
    }, 0);

    return supplyMajor + codeMajor;
  }, []);

  const fetchMajorFindings = useCallback(async (projectId: string): Promise<number> => {
    const endpoint = `/api/scan/results?project_id=${encodeURIComponent(projectId)}`;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await fetch(endpoint);
      if (res.ok) {
        const payload = await res.json() as { data?: ScanResultsData };
        return countMajorFindings(payload?.data);
      }

      // Small grace retry window right after websocket completion.
      if ((res.status === 404 || res.status === 500) && attempt < 5) {
        await new Promise(resolve => setTimeout(resolve, 1200));
        continue;
      }

      const payload = await res.json().catch(() => ({}));
      throw new Error(String(payload?.error || 'Failed to fetch scan results'));
    }
    throw new Error('Scan results unavailable after retries');
  }, [countMajorFindings]);

  const validateAndStartScan = useCallback(async (project: ProjectItem, projectName: string) => {
    const validateRes = await fetch('/api/scan/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: project.id,
        project_name: projectName,
        project_type: project.type,
        installation_id: project.installationId,
        owner: project.owner,
        repo: project.repo,
        scan_type: 'all',
      }),
    });
    if (!validateRes.ok) {
      const data = await validateRes.json().catch(() => null);
      throw new Error(data?.error || 'Scan validation failed');
    }
    await startScan(project.id, projectName);
  }, [startScan]);

  const resolveRemediationPrUrl = useCallback(async (projectId: string): Promise<string | null> => {
    const res = await fetch('/api/pipeline/remediation-pr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const url = typeof data?.pr_url === 'string' ? data.pr_url.trim() : '';
    return url || null;
  }, []);

  const refreshGithubRepository = useCallback(async (project: ProjectItem) => {
    if (project.type !== 'github') return;
    if (!project.owner || !project.repo) {
      throw new Error('Missing owner/repo metadata for refresh');
    }
    const res = await fetch('/api/repositories/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: project.owner, repo: project.repo }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(String(data?.error || 'Repository refresh failed'));
    }
  }, []);

  const runCostStage = useCallback(async (project: ProjectItem, summary: string): Promise<number> => {
    const trimmedSummary = summary.trim();
    if (!trimmedSummary) {
      throw new Error('Q/A context is required before cost estimation.');
    }

    const prompt = [
      `Project: ${selectedProjectName || project.id}`,
      'Create a production-ready AWS architecture JSON for this project.',
      'Use the following operator context as the primary source of requirements.',
      trimmedSummary,
      majorFindingsRemaining !== null
        ? `Security gate context: critical/high findings remaining after remediation = ${majorFindingsRemaining}.`
        : '',
    ].filter(Boolean).join('\n\n');

    const architectureRes = await fetch('/api/architecture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        provider: 'aws',
        project_name: selectedProjectName || project.id,
        qa_summary: trimmedSummary,
        deployment_region: awsRegion.trim() || 'ap-south-1',
      }),
    });
    const architectureData = await architectureRes.json().catch(() => ({})) as {
      architecture_json?: Record<string, unknown>;
      error?: string;
    };
    if (!architectureRes.ok || !architectureData.architecture_json) {
      throw new Error(String(architectureData.error || 'Failed to generate architecture JSON.'));
    }

    const generatedArchitecture = architectureData.architecture_json;
    const nodeCount = Array.isArray((generatedArchitecture as { nodes?: unknown[] }).nodes)
      ? ((generatedArchitecture as { nodes?: unknown[] }).nodes || []).length
      : 0;
    setArchitectureJson(generatedArchitecture);
    addLog(`[SYSTEM] Architecture JSON generated (${nodeCount} service node(s)).`);

    const diagramRes = await fetch('/api/pipeline/diagram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: project.id,
        architecture_json: generatedArchitecture,
      }),
    });
    const diagramData = await diagramRes.json().catch(() => ({})) as {
      success?: boolean;
      diagram?: { content?: string; node_count?: number; edge_count?: number; nodes?: DiagramNodePreview[] };
      error?: string;
    };
    if (!diagramRes.ok || !diagramData.success || !diagramData.diagram?.content) {
      throw new Error(String(diagramData.error || 'Failed to generate architecture diagram.'));
    }
    setGeneratedDiagram(diagramData.diagram.content);
    setGeneratedDiagramNodes(Array.isArray(diagramData.diagram.nodes) ? diagramData.diagram.nodes : []);
    addLog(
      `[SYSTEM] Diagram generated (${Number(diagramData.diagram.node_count || 0)} nodes / ${Number(diagramData.diagram.edge_count || 0)} edges).`,
    );

    const costRes = await fetch('/api/cost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: project.id,
        provider: 'aws',
        architecture_json: generatedArchitecture,
      }),
    });
    const costData = await costRes.json().catch(() => ({})) as {
      success?: boolean;
      total_monthly_usd?: number;
      error?: string;
    };
    if (!costRes.ok || !costData.success) {
      throw new Error(String(costData.error || 'Failed to estimate cost.'));
    }

    const totalMonthly = Number(costData.total_monthly_usd);
    if (!Number.isFinite(totalMonthly)) {
      throw new Error('Cost estimation returned an invalid amount.');
    }
    setCostEstimate(Number(totalMonthly.toFixed(2)));
    return Number(totalMonthly.toFixed(2));
  }, [addLog, awsRegion, majorFindingsRemaining, selectedProjectName]);

  const runIacStage = useCallback(async (
    project: ProjectItem,
    summary: string,
    architecture: Record<string, unknown>,
  ): Promise<number> => {
    const iacRes = await fetch('/api/pipeline/iac', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: project.id,
        provider: 'aws',
        qa_summary: summary,
        architecture_context: summary,
        architecture_json: architecture,
      }),
    });
    const iacData = await iacRes.json().catch(() => ({})) as {
      files?: GeneratedFile[];
      error?: string;
    };
    if (!iacRes.ok) {
      throw new Error(String(iacData.error || 'Failed to generate Terraform bundle.'));
    }
    const files = Array.isArray(iacData.files) ? iacData.files : [];
    if (files.length === 0) {
      throw new Error('IaC generation returned no files.');
    }
    setGeneratedIacFiles(files);
    return files.length;
  }, []);

  const currentStage = useMemo(
    () => stages.find(stage => stage.status === 'running' || stage.status === 'pending') || null,
    [stages],
  );

  const prUrlFromStream = useMemo(() => {
    for (let i = remediationMessages.length - 1; i >= 0; i -= 1) {
      const content = remediationMessages[i]?.content || '';
      if (!content.toLowerCase().includes('remediation pr created')) continue;
      const url = content.match(/https?:\/\/\S+/)?.[0] || null;
      if (url) return url;
    }
    return null;
  }, [remediationMessages]);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [logs, monitorMessages]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
    if (!selectedProjectId) return;
    try {
      localStorage.setItem(PIPELINE_SELECTED_PROJECT_KEY, selectedProjectId);
    } catch {
      // Ignore storage write failures (quota/private mode).
    }
  }, [selectedProjectId]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrapDashboard() {
      setLoadingProjects(true);
      try {
        const sessionRes = await fetch('/api/auth/session');
        const session = await sessionRes.json();
        if (!session?.isLoggedIn) {
          router.push('/');
          return;
        }
        if (!cancelled && session.user) {
          setUser({
            login: session.user.login,
            name: session.user.name,
            avatarUrl: session.user.avatarUrl,
          });
        }

        const projectsRes = await fetch('/api/projects');
        const payload = await projectsRes.json();
        if (!projectsRes.ok) {
          throw new Error(payload?.error || 'Failed to load projects');
        }

        const nextProjects = Array.isArray(payload?.projects) ? payload.projects as ProjectItem[] : [];
        if (!cancelled) {
          setProjects(nextProjects);
          let storedProjectId = '';
          try {
            storedProjectId = localStorage.getItem(PIPELINE_SELECTED_PROJECT_KEY) || '';
          } catch {
            storedProjectId = '';
          }
          const preferred =
            nextProjects.find((project) => project.id === storedProjectId) ??
            nextProjects.find((project) => project.type === 'github') ??
            nextProjects[0];
          if (preferred) setSelectedProjectId(preferred.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Dashboard bootstrap failed';
        if (!cancelled) addLog(`[ERROR] ${message}`);
      } finally {
        if (!cancelled) setLoadingProjects(false);
      }
    }

    bootstrapDashboard();
    return () => { cancelled = true; };
  }, [addLog, router]);

  useEffect(() => {
    if (!prUrlFromStream) return;
    setRemediationPrUrl(prev => prev || prUrlFromStream);
  }, [prUrlFromStream]);

  useEffect(() => {
    setPipelineWsMessages([]);
    setPipelineWsState('idle');

    const existing = pipelineWsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      existing.close();
    }
    pipelineWsRef.current = null;

    if (!selectedProjectId) return;

    let disposed = false;
    let ws: WebSocket | null = null;

    const connect = async () => {
      const wsToken = await fetchPipelineWsToken(selectedProjectId);
      if (disposed) return;
      if (!wsToken) {
        setPipelineWsState('error');
        return;
      }

      const base = `${WS_BASE_URL}/ws/pipeline/${encodeURIComponent(selectedProjectId)}`;
      const wsUrl = wsToken ? `${base}?token=${encodeURIComponent(wsToken)}` : base;
      ws = new WebSocket(wsUrl);
      pipelineWsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        setPipelineWsState('running');
        try {
          ws?.send(JSON.stringify({ action: 'start' }));
        } catch {
          setPipelineWsState('error');
        }
      };

      ws.onmessage = (event) => {
        if (disposed) return;
        try {
          const data = JSON.parse(event.data) as {
            type?: string;
            status?: string;
            data?: ScanMessage;
          };
          if (data.type === 'message' && data.data) {
            setPipelineWsMessages(prev => [...prev, data.data as ScanMessage]);
            return;
          }
          if (data.type === 'status') {
            if (data.status === 'error') {
              setPipelineWsState('error');
              return;
            }
            if (data.status === 'running' || data.status === 'completed') {
              setPipelineWsState('running');
            }
          }
        } catch {
          // Ignore malformed websocket payloads.
        }
      };

      ws.onerror = () => {
        if (disposed) return;
        setPipelineWsState('error');
      };

      ws.onclose = () => {
        if (disposed) return;
        setPipelineWsState('idle');
        if (pipelineWsRef.current === ws) {
          pipelineWsRef.current = null;
        }
      };
    };

    void connect();

    return () => {
      disposed = true;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
      if (pipelineWsRef.current === ws) {
        pipelineWsRef.current = null;
      }
    };
  }, [fetchPipelineWsToken, selectedProjectId]);

  useEffect(() => {
    if (!isRunning || pipelineState !== 'running' || !currentStage || !selectedProject) return;

    if (currentStage.status === 'pending') {
      // Stages 7+ are orchestrated by the downstream effect to avoid duplicate
      // "STARTED STAGE" transitions/logs.
      if (currentStage.id >= 7) {
        return;
      }
      if (currentStage.id === 4.5 && !mergeGateRequired) {
        setStageStatus(4.5, 'skipped', 'N/A');
        addLog('[SYSTEM] Merge gate skipped: no remediation PR is required for this run.');
        return;
      }
      setStageStatus(currentStage.id, 'running');
      setActiveStageId(currentStage.id);
      addLog(`>>> STARTED STAGE: ${currentStage.label}`);
      return;
    }

    const scopeKey = `${pipelineRunId}:${cycle}:${currentStage.id}`;

    if (currentStage.id === 0 && !opStarted(scopeKey)) {
      markOpStarted(scopeKey);
      (async () => {
        try {
          const res = await fetch('/api/pipeline/health');
          if (!res.ok) {
            throw new Error('Pipeline health check failed');
          }
          const payload = await res.json() as HealthPayload;
          const downChecks = (payload.checks || []).filter(check => check.state === 'down');
          if (downChecks.length > 0) {
            throw new Error(`Preflight blocked: ${downChecks.map(c => c.name).join(', ')}`);
          }
          completeStage(0, 'Passed');
          addLog('[SYSTEM] Preflight checks passed.');
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Preflight failed';
          failStage(0, message);
        }
      })();
      return;
    }

    if (currentStage.id === 1) {
      const startKey = `${scopeKey}:start`;
      if (!opStarted(startKey)) {
        markOpStarted(startKey);
        (async () => {
          try {
            await validateAndStartScan(selectedProject, selectedProjectName);
            markOpStarted(`${scopeKey}:start_confirmed`);
            addLog(`[SYSTEM] Scan started for ${selectedProjectName}.`);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to start scan';
            failStage(1, message);
          }
        })();
      }

      if (scanState === 'running' && !opStarted(`${scopeKey}:running_seen`)) {
        markOpStarted(`${scopeKey}:running_seen`);
      }

      if (
        scanState === 'completed' &&
        opStarted(`${scopeKey}:running_seen`) &&
        !opStarted(`${scopeKey}:complete`)
      ) {
        markOpStarted(`${scopeKey}:complete`);
        (async () => {
          try {
            const remaining = await fetchMajorFindings(selectedProject.id);
            setMajorFindingsRemaining(remaining);
            completeStage(1, 'Completed');
            addLog(`[SYSTEM] Scan completed. Critical/high findings: ${remaining}.`);
            if (remaining <= 0) {
              setStages(prev => prev.map(stage => {
                if (stage.id >= 2 && stage.id <= 4.6) {
                  return { ...stage, status: 'skipped', duration: 'N/A' };
                }
                return stage;
              }));
              addLog('[SYSTEM] No major findings found. Skipping remediation loop and moving to Q/A.');
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to read scan results';
            failStage(1, message);
          }
        })();
      }

      if (
        scanState === 'error' &&
        (
          opStarted(`${scopeKey}:running_seen`) ||
          opStarted(`${scopeKey}:start_confirmed`)
        )
      ) {
        failStage(1, 'Scan failed');
      }
      return;
    }

    if (currentStage.id === 2 && !opStarted(scopeKey)) {
      markOpStarted(scopeKey);
      addLog('[SYSTEM] KG context collection is enabled and will stream during remediation.');
      completeStage(2, 'Streaming');
      return;
    }

    if (currentStage.id === 3) {
      const startKey = `${scopeKey}:start`;
      if (!opStarted(startKey)) {
        if (selectedProject.type === 'github' && !runtimeGithubToken.trim()) {
          setIsManuallyPaused(true);
          setPipelineState('paused');
          addLog('[ERROR] Runtime GitHub token is required before remediation can create a PR.');
          return;
        }

        markOpStarted(startKey);
        (async () => {
          try {
            await startRemediation(
              selectedProject.id,
              undefined,
              selectedProject.type === 'github' ? runtimeGithubToken.trim() : undefined,
            );
            addLog('[SYSTEM] Remediation started.');
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to start remediation';
            failStage(3, message);
          }
        })();
      }

      if (remediationState === 'waiting_approval') {
        const approvalPrompts = remediationMessages.filter((msg) =>
          String(msg.content || '').toLowerCase().includes('review remediation changes and approve'),
        ).length;
        const approvalRound = Math.max(1, approvalPrompts);
        const approvalKey = `${scopeKey}:approval:${approvalRound}`;
        if (!opStarted(approvalKey)) {
          markOpStarted(approvalKey);
          approveRemediationRescan(selectedProject.id);
          addLog(`[SYSTEM] Remediation approval auto-sent for cycle ${approvalRound}.`);
        }
        return;
      }

      if (remediationState === 'completed' && !opStarted(`${scopeKey}:completed`)) {
        markOpStarted(`${scopeKey}:completed`);
        completeStage(3, 'Completed');
      }

      if (remediationState === 'error') {
        failStage(3, 'Remediation failed');
      }
      return;
    }

    if (currentStage.id === 4) {
      if (
        remediationPrUrl &&
        remediationState === 'completed' &&
        !opStarted(`${scopeKey}:ready`)
      ) {
        markOpStarted(`${scopeKey}:ready`);
        completeStage(4, 'PR ready');
        addLog(`[SYSTEM] Remediation PR ready: ${remediationPrUrl}`);
        return;
      }

      if (remediationPrUrl && remediationState !== 'completed') {
        return;
      }

      if (selectedProject.type !== 'github') {
        setStageStatus(4, 'skipped', 'Local');
        addLog('[SYSTEM] PR stage skipped for local project.');
        return;
      }

      if (remediationState === 'completed' && !opStarted(`${scopeKey}:resolve_pr`)) {
        markOpStarted(`${scopeKey}:resolve_pr`);
        (async () => {
          const resolved = await resolveRemediationPrUrl(selectedProject.id);
          if (resolved) {
            setRemediationPrUrl(resolved);
            completeStage(4, 'PR resolved');
            addLog(`[SYSTEM] Resolved remediation PR: ${resolved}`);
            return;
          }

          const noChangeSignals = [
            'no github changes detected',
            'no file changes to approve/persist',
            'no safe remediation changes were applied',
            'proposals generated but no safe file updates were applied',
            'stopping remediation loop due to repeated no-progress cycles',
          ];
          const noChanges = remediationMessages.some((message) => {
            const content = String(message.content || '').toLowerCase();
            return noChangeSignals.some((signal) => content.includes(signal));
          });
          if (noChanges) {
            setStageStatus(4, 'skipped', 'NO_CHANGES');
            addLog('[SYSTEM] Remediation produced no safe persisted changes; PR stage skipped.');
            return;
          }

          failStage(4, 'PR was not created after remediation');
        })();
      }

      if (remediationState === 'error') {
        failStage(4, 'Remediation ended before PR creation');
      }
      return;
    }

    if (currentStage.id === 4.5) {
      setStageStatus(4.5, 'paused');
      setPipelineState('paused');
      addLog('[SYSTEM] Pipeline paused. Merge the remediation PR, then confirm merge.');
      return;
    }

    if (currentStage.id === 4.6) {
      const prStage = stages.find((stage) => stage.id === 4);
      const noChangesRun =
        prStage?.status === 'skipped' && String(prStage.duration || '').toUpperCase() === 'NO_CHANGES';
      if (noChangesRun) {
        setStageStatus(4.6, 'skipped', 'NO_CHANGES');
        addLog('[SYSTEM] Post-merge actions skipped: remediation produced no persisted changes.');
        return;
      }

      const startKey = `${scopeKey}:start`;
      if (!opStarted(startKey)) {
        markOpStarted(startKey);
        (async () => {
          try {
            if (selectedProject.type === 'github') {
              await refreshGithubRepository(selectedProject);
              addLog('[SYSTEM] Repository refresh completed.');
            }
            await validateAndStartScan(selectedProject, selectedProjectName);
            addLog('[SYSTEM] Post-merge security re-scan started.');
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed post-merge actions';
            failStage(4.6, message);
          }
        })();
      }

      if (scanState === 'running' && !opStarted(`${scopeKey}:running_seen`)) {
        markOpStarted(`${scopeKey}:running_seen`);
      }

      if (
        scanState === 'completed' &&
        opStarted(`${scopeKey}:running_seen`) &&
        !opStarted(`${scopeKey}:complete`)
      ) {
        markOpStarted(`${scopeKey}:complete`);
        (async () => {
          try {
            const remaining = await fetchMajorFindings(selectedProject.id);
            setMajorFindingsRemaining(remaining);
            if (remaining > 0) {
              if (cycle < MAX_CYCLES) {
                addLog(`[WARN] ${remaining} major finding(s) remain. Starting remediation cycle ${cycle + 1}/${MAX_CYCLES}.`);
                setCycle(prev => prev + 1);
                setRemediationPrUrl(null);
                setStages(prev => prev.map(stage => {
                  if (stage.id >= 1 && stage.id <= 4.6) {
                    return { ...stage, status: 'pending', duration: undefined };
                  }
                  return stage;
                }));
                return;
              }
              addLog(`[WARN] ${remaining} major finding(s) still remain after ${MAX_CYCLES} cycles. Advancing to Q/A by policy.`);
            } else {
              addLog('[SYSTEM] Post-merge re-scan passed with no major findings.');
            }

            completeStage(4.6, `Cycle ${cycle}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to evaluate post-merge scan';
            failStage(4.6, message);
          }
        })();
      }

      if (scanState === 'error') {
        failStage(4.6, 'Post-merge re-scan failed');
      }
      return;
    }

    if (currentStage.id === 6) {
      setStageStatus(6, 'paused');
      setPipelineState('paused');
      addLog('[SYSTEM] Pipeline paused for operator Q/A context.');
      return;
    }
  }, [
    addLog,
    approveRemediationRescan,
    completeStage,
    costEstimate,
    currentStage,
    cycle,
    failStage,
    fetchMajorFindings,
    isRunning,
    markOpStarted,
    mergeGateRequired,
    opStarted,
    pipelineRunId,
    pipelineState,
    refreshGithubRepository,
    remediationMessages,
    remediationPrUrl,
    remediationState,
    resolveRemediationPrUrl,
    runtimeGithubToken,
    scanState,
    selectedProject,
    selectedProjectName,
    setStageStatus,
    stages,
    startRemediation,
    validateAndStartScan,
  ]);

  useEffect(() => {
    if (!isRunning || pipelineState !== 'running' || !selectedProject) return;
    const qaStage = stages.find(stage => stage.id === 6);
    // Hard gate: never advance into stages 7+ until operator Q/A is completed.
    if (!qaStage || (qaStage.status !== 'success' && qaStage.status !== 'skipped')) return;

    const downstreamStage = stages.find(stage =>
      stage.id >= 7 && (stage.status === 'pending' || stage.status === 'running'),
    );
    if (!downstreamStage) {
      const allDone = stages.every(stage => ['success', 'skipped'].includes(stage.status));
      if (allDone) {
        setPipelineState('completed');
        setIsRunning(false);
        addLog('[SYSTEM] Pipeline completed successfully.');
      }
      return;
    }

    if (downstreamStage.status === 'pending') {
      setStageStatus(downstreamStage.id, 'running');
      setActiveStageId(downstreamStage.id);
      addLog(`>>> STARTED STAGE: ${downstreamStage.label}`);
      return;
    }

    const scopeKey = `${pipelineRunId}:${cycle}:${downstreamStage.id}:downstream`;

    if (downstreamStage.id === 7) {
      if (opStarted(scopeKey)) return;
      markOpStarted(scopeKey);
      (async () => {
        try {
          const estimated = await runCostStage(selectedProject, qaSummary);
          completeStage(7, `$${estimated.toFixed(2)}/mo`);
          addLog(`[SYSTEM] Stage 7 complete: estimated monthly cost is $${estimated.toFixed(2)}.`);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Cost estimation failed';
          failStage(7, message);
        }
      })();
      return;
    }

    if (downstreamStage.id === 7.5) {
      setStageStatus(7.5, 'paused');
      setPipelineState('paused');
      addLog('[SYSTEM] Manual gate: review diagram and cost estimate, then approve to continue.');
      return;
    }

    if (downstreamStage.id === 8) {
      if (opStarted(scopeKey)) return;
      markOpStarted(scopeKey);
      (async () => {
        try {
          if (!architectureJson) {
            throw new Error('Missing architecture JSON. Complete stage 7 first.');
          }
          const fileCount = await runIacStage(selectedProject, qaSummary, architectureJson);
          completeStage(8, `${fileCount} files`);
          addLog(`[SYSTEM] Stage 8 complete: generated ${fileCount} IaC file(s).`);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Terraform generation failed';
          failStage(8, message);
        }
      })();
      return;
    }

    if (downstreamStage.id === 9 && costEstimate > BUDGET_CAP) {
      setStageStatus(9, 'paused');
      setPipelineState('paused');
      addLog(`[POLICY VIOLATION] Cost estimate ($${costEstimate}) exceeds budget cap ($${BUDGET_CAP}). Awaiting override.`);
      return;
    }

    if (downstreamStage.id === 9) {
      if (opStarted(scopeKey)) return;
      markOpStarted(scopeKey);
      completeStage(9, 'Within policy');
      addLog(`[SYSTEM] Budget gate passed at $${costEstimate.toFixed(2)}/mo.`);
      return;
    }

    if (downstreamStage.id === 10) {
      if (opStarted(scopeKey)) return;
      markOpStarted(scopeKey);

      // Keep deployment explicit: avoid a false "success" when no deploy credentials were provided.
      if (generatedIacFiles.length === 0) {
        failStage(10, 'Deployment blocked: no generated IaC files available.');
        return;
      }

      setStageStatus(10, 'paused');
      setPipelineState('paused');
      addLog('[SYSTEM] Deployment gate: click "Deploy to AWS" to apply generated Terraform and create EC2 + S3 + CloudFront.');
      return;
    }
  }, [
    addLog,
    architectureJson,
    completeStage,
    costEstimate,
    cycle,
    failStage,
    generatedIacFiles.length,
    isRunning,
    markOpStarted,
    opStarted,
    pipelineRunId,
    pipelineState,
    qaSummary,
    runCostStage,
    runIacStage,
    selectedProject,
    setStageStatus,
    stages,
  ]);

  const startPipeline = () => {
    if (!selectedProject) {
      addLog('[ERROR] Select a repository before starting the pipeline.');
      return;
    }
    if (selectedProject.type === 'github' && (!selectedProject.owner || !selectedProject.repo)) {
      addLog('[ERROR] Selected GitHub repository has incomplete metadata. Open Projects and sync it first.');
      return;
    }

    resetAll();
    stageOpsRef.current = {};
    setStages(INITIAL_STAGES.map(stage => ({ ...stage, status: 'pending', duration: undefined })));
    setCycle(1);
    setMajorFindingsRemaining(null);
    setCostEstimate(0);
    setQaSummary('');
    setArchitectureJson(null);
    setGeneratedIacFiles([]);
    setGeneratedDiagram(null);
    setGeneratedDiagramNodes([]);
    setDeploymentSummary(null);
    setDeploying(false);
    setBudgetOverridden(false);
    setPipelineWsMessages([]);
    setQaStep(0);
    setQaMessages([{ role: 'agent', text: QA_QUESTIONS[0] }]);
    setRemediationPrUrl(null);
    setLogs([]);
    setPipelineRunId(prev => prev + 1);
    setIsManuallyPaused(false);
    setIsRunning(true);
    setPipelineState('running');
    setActiveStageId(null);
    addLog(`[SYSTEM] Bound pipeline run to project ${selectedProjectName}.`);
    addLog(`[SYSTEM] Pipeline execution initiated for ${selectedProjectName}.`);
  };

  const pausePipeline = () => {
    if (!isRunning || pipelineState !== 'running') return;
    setIsManuallyPaused(true);
    setPipelineState('paused');
    addLog('[USER] Pipeline paused by operator.');
  };

  const resumePipeline = () => {
    if (!isManuallyPaused) return;
    setIsManuallyPaused(false);
    setPipelineState('running');
    addLog('[USER] Pipeline resumed by operator.');
  };

  const resetPipeline = () => {
    resetAll();
    stageOpsRef.current = {};
    setStages(INITIAL_STAGES.map(stage => ({ ...stage, status: 'pending', duration: undefined })));
    setCycle(1);
    setLogs([]);
    setMajorFindingsRemaining(null);
    setCostEstimate(0);
    setQaSummary('');
    setArchitectureJson(null);
    setGeneratedIacFiles([]);
    setGeneratedDiagram(null);
    setGeneratedDiagramNodes([]);
    setDeploymentSummary(null);
    setDeploying(false);
    setBudgetOverridden(false);
    setPipelineWsMessages([]);
    setQaStep(0);
    setIsRunning(false);
    setIsManuallyPaused(false);
    setPipelineState('idle');
    setActiveStageId(null);
    setRemediationPrUrl(null);
    setQaMessages([{ role: 'agent', text: QA_QUESTIONS[0] }]);
  };

  const handleApproveMerge = () => {
    if (!mergeGateRequired) {
      addLog('[WARN] Merge confirmation skipped because no remediation PR is associated with this run.');
      setStageStatus(4.5, 'skipped', 'N/A');
      setPipelineState('running');
      return;
    }
    addLog('[USER] Merge approved by operator.');
    if (remediationPrUrl) {
      addLog(`[SYSTEM] Merge confirmed for PR: ${remediationPrUrl}`);
    }
    setStageStatus(4.5, 'success', 'Manual');
    setIsManuallyPaused(false);
    setPipelineState('running');
  };

  const handleContinueAfterPr = () => {
    addLog('[USER] Continue process requested at PR gate.');
    setStageStatus(4.5, 'success', 'Bypass');
    setIsManuallyPaused(false);
    setPipelineState('running');
  };

  const handleOverrideBudget = () => {
    addLog(`[USER] Budget policy overridden. Acknowledged $${costEstimate}/mo.`);
    setBudgetOverridden(true);
    setStageStatus(9, 'success', 'Override');
    setIsManuallyPaused(false);
    setPipelineState('running');
  };

  const handleApproveArchitectureCost = () => {
    addLog(`[USER] Architecture and cost approved at $${costEstimate.toFixed(2)}/mo.`);
    setStageStatus(7.5, 'success', 'Manual');
    setIsManuallyPaused(false);
    setPipelineState('running');
  };

  const jumpToQaGate = useCallback((mode: 'skip_remediation' | 'skip_pr') => {
    setStages((prev) =>
      prev.map((stage) => {
        if (mode === 'skip_remediation' && stage.id === 3) {
          return { ...stage, status: 'skipped', duration: 'Manual' };
        }
        if (stage.id === 4 || stage.id === 4.5 || stage.id === 4.6) {
          return { ...stage, status: 'skipped', duration: mode === 'skip_pr' ? 'BYPASS' : 'Manual' };
        }
        if (stage.id === 6 && stage.status === 'pending') {
          return { ...stage, status: 'paused', duration: 'Manual' };
        }
        return stage;
      }),
    );
    setActiveStageId(6);
    setIsManuallyPaused(false);
    setPipelineState('paused');
    if (mode === 'skip_remediation') {
      addLog('[USER] Remediation manually skipped. Jumping directly to Q/A.');
    } else {
      addLog('[USER] PR/Merge gates manually bypassed. Jumping directly to Q/A.');
    }
  }, [addLog]);

  const handleSkipRemediationToQa = useCallback(() => {
    jumpToQaGate('skip_remediation');
  }, [jumpToQaGate]);

  const handleProceedToQaWithoutPr = useCallback(() => {
    jumpToQaGate('skip_pr');
  }, [jumpToQaGate]);

  const handleDeployAws = useCallback(async () => {
    if (deploying) {
      return;
    }
    if (!selectedProject) {
      addLog('[ERROR] No project selected for deployment.');
      return;
    }
    if (generatedIacFiles.length === 0) {
      addLog('[ERROR] Deploy blocked: IaC files are missing.');
      return;
    }
    if (!awsAccessKeyId.trim() || !awsSecretAccessKey.trim()) {
      addLog('[ERROR] Deployment blocked: provide AWS access key and secret key in the dashboard first.');
      return;
    }

    setDeploying(true);
    addLog('[SYSTEM] Starting AWS deployment from generated Terraform bundle...');
    const heartbeat = window.setInterval(() => {
      addLog('[SYSTEM] AWS deployment still running (terraform apply in progress)...');
    }, 20000);
    try {
      const res = await fetch('/api/pipeline/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: selectedProject.id,
          provider: 'aws',
          runtime_apply: true,
          files: generatedIacFiles,
          aws_access_key_id: awsAccessKeyId.trim(),
          aws_secret_access_key: awsSecretAccessKey.trim(),
          aws_region: awsRegion.trim() || 'ap-south-1',
          estimated_monthly_usd: costEstimate,
          budget_limit_usd: BUDGET_CAP,
          budget_override: budgetOverridden,
        }),
      });
      const data = await res.json().catch(() => ({})) as {
        success?: boolean;
        outputs?: Record<string, unknown>;
        cloudfront_url?: string;
        details?: Record<string, unknown>;
        error?: string;
      };
      if (!res.ok || !data.success) {
        const details = data.details || {};
        const detailTail =
          String(details.stderr_tail || details.stdout_tail || details.apply_log_tail || details.init_log_tail || '').trim();
        const selectedType = String(details.selected_instance_type || '').trim();
        const attemptedTypes = Array.isArray(details.attempted_instance_types)
          ? details.attempted_instance_types.map((v) => String(v)).filter(Boolean)
          : [];
        const quotaInfo = (details.quota_info && typeof details.quota_info === 'object')
          ? details.quota_info as Record<string, unknown>
          : null;
        if (selectedType) {
          addLog(`[SYSTEM] EC2 selected instance type: ${selectedType}`);
        }
        if (attemptedTypes.length) {
          addLog(`[SYSTEM] EC2 attempted instance types: ${attemptedTypes.join(', ')}`);
        }
        if (quotaInfo) {
          const headroom = Number(quotaInfo.headroom_vcpus);
          const used = Number(quotaInfo.used_vcpus);
          const limit = Number(quotaInfo.quota_limit_vcpus);
          if (Number.isFinite(headroom) && Number.isFinite(used) && Number.isFinite(limit)) {
            addLog(`[SYSTEM] EC2 quota snapshot (standard families): used ${used} / limit ${limit} vCPU, headroom ${Math.max(0, headroom).toFixed(1)}.`);
          }
        }
        if (detailTail) {
          addLog(`[ERROR] Deploy detail: ${detailTail.slice(-380)}`);
        }
        throw new Error(String(data.error || 'Deployment request failed.'));
      }

      const outputs = data.outputs || {};
      const cloudfrontUrl =
        String(data.cloudfront_url || outputs.cloudfront_url || '').trim() ||
        String(outputs.cloudfront_domain_name ? `https://${String(outputs.cloudfront_domain_name)}` : '').trim() ||
        null;
      const instanceUrl = String(outputs.instance_url || '').trim() || null;
      const instancePublicIp = String(outputs.instance_public_ip || '').trim() || null;
      const securityLogsBucket = String(outputs.security_logs_bucket || '').trim() || null;
      const websiteBucket = String(outputs.website_bucket || '').trim() || null;
      const s3WebsiteEndpoint = String(outputs.s3_website_endpoint || '').trim() || null;
      const websiteObjectCount = Number(outputs.website_object_count);
      const websiteHasPolicy = outputs.website_has_policy;
      const websiteBpaState = String(outputs.website_block_public_access || '').trim() || null;
      const ec2InstanceId = String(outputs.ec2_instance_id || '').trim() || null;
      const ec2InstanceType = String(outputs.ec2_instance_type || '').trim() || null;
      const ec2AmiId = String(outputs.ec2_ami_id || '').trim() || null;
      const ec2PublicDns = String(outputs.ec2_public_dns || '').trim() || null;
      const ec2Az = String(outputs.ec2_availability_zone || '').trim() || null;
      const ec2SubnetId = String(outputs.ec2_subnet_id || '').trim() || null;
      const ec2KeyName = String(outputs.ec2_key_name || '').trim() || null;
      const vpcId = String(outputs.vpc_id || '').trim() || null;
      const ec2SgIds = Array.isArray(outputs.ec2_vpc_security_group_ids)
        ? outputs.ec2_vpc_security_group_ids.map((v) => String(v)).filter(Boolean)
        : [];
      const subnetIds = Array.isArray(outputs.subnet_ids)
        ? outputs.subnet_ids.map((v) => String(v)).filter(Boolean)
        : [];
      const webSecurityGroupId = String(outputs.web_security_group_id || '').trim() || null;

      setDeploymentSummary({
        cloudfrontUrl,
        instanceUrl,
        instancePublicIp,
        securityLogsBucket,
        websiteBucket,
      });

      setStageStatus(10, 'success', 'Applied');
      setPipelineState('running');
      setIsManuallyPaused(false);
      addLog('[SYSTEM] AWS deployment succeeded.');
      addLog('[SYSTEM] Runtime terraform apply completed successfully.');
      if (cloudfrontUrl) addLog(`[OUTPUT] CloudFront URL: ${cloudfrontUrl}`);
      if (cloudfrontUrl) addLog('[SYSTEM] CloudFront may take a few minutes to fully propagate globally.');
      if (instanceUrl) addLog(`[OUTPUT] EC2 URL: ${instanceUrl}`);
      if (ec2InstanceId) addLog(`[OUTPUT] EC2 instance id: ${ec2InstanceId}`);
      if (ec2InstanceType) addLog(`[OUTPUT] EC2 instance type: ${ec2InstanceType}`);
      if (ec2AmiId) addLog(`[OUTPUT] EC2 AMI id: ${ec2AmiId}`);
      if (securityLogsBucket) addLog(`[OUTPUT] Security logs bucket: ${securityLogsBucket}`);
      if (websiteBucket) addLog(`[OUTPUT] Website bucket: ${websiteBucket}`);
      if (s3WebsiteEndpoint) addLog(`[OUTPUT] S3 website endpoint: ${s3WebsiteEndpoint}`);
      if (instancePublicIp) addLog(`[OUTPUT] EC2 public IP: ${instancePublicIp}`);
      if (ec2PublicDns) addLog(`[OUTPUT] EC2 public DNS: ${ec2PublicDns}`);
      if (ec2Az) addLog(`[OUTPUT] EC2 availability zone: ${ec2Az}`);
      if (vpcId) addLog(`[OUTPUT] VPC id: ${vpcId}`);
      if (ec2SubnetId) addLog(`[OUTPUT] EC2 subnet id: ${ec2SubnetId}`);
      if (subnetIds.length > 0) addLog(`[OUTPUT] Candidate subnet ids: ${subnetIds.join(', ')}`);
      if (webSecurityGroupId) addLog(`[OUTPUT] Web security group id: ${webSecurityGroupId}`);
      if (ec2SgIds.length > 0) addLog(`[OUTPUT] EC2 security group ids: ${ec2SgIds.join(', ')}`);
      if (ec2KeyName) {
        addLog(`[OUTPUT] EC2 key pair name: ${ec2KeyName}`);
      } else {
        addLog('[OUTPUT] EC2 key pair name: not configured (SSM/alternate access expected).');
      }
      if (Number.isFinite(websiteObjectCount)) addLog(`[OUTPUT] Website objects uploaded: ${websiteObjectCount}`);
      if (typeof websiteHasPolicy === 'boolean') addLog(`[OUTPUT] Website bucket policy attached: ${websiteHasPolicy ? 'yes' : 'no'}`);
      if (websiteBpaState) addLog(`[OUTPUT] Website bucket block public access: ${websiteBpaState}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Deployment failed';
      failStage(10, message);
    } finally {
      window.clearInterval(heartbeat);
      setDeploying(false);
    }
  }, [
    addLog,
    awsAccessKeyId,
    awsRegion,
    awsSecretAccessKey,
    budgetOverridden,
    costEstimate,
    failStage,
    generatedIacFiles,
    selectedProject,
    setStageStatus,
  ]);

  const handleSkipStage = () => {
    if (activeStageId === null) return;
    addLog(`[USER] Manual override: Stage [${activeStageId}] skipped by operator.`);
    setStages(prev => prev.map(s => s.id === activeStageId ? { ...s, status: 'skipped', duration: 'Skipped' } : s));

    if (pipelineState === 'paused') {
      setIsManuallyPaused(false);
      setPipelineState('running');
    }
  };

  const handleQASubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const submitted = qaInput.trim();
    if (!submitted) return;

    const question = QA_QUESTIONS[qaStep] || `Question ${qaStep + 1}`;
    setQaMessages(prev => [...prev, { role: 'user', text: submitted }]);
    setQaSummary(prev => [prev, `Q: ${question}\nA: ${submitted}`].filter(Boolean).join('\n\n'));
    setQaInput('');
    setIsAgentTyping(true);
    addLog(`[USER] Provided Q/A context.`);

    setTimeout(() => {
      setIsAgentTyping(false);
      const nextIndex = qaStep + 1;
      if (nextIndex < QA_QUESTIONS.length) {
        setQaStep(nextIndex);
        setQaMessages(prev => [...prev, { role: 'agent', text: QA_QUESTIONS[nextIndex] }]);
        addLog(`[SYSTEM] Captured Q/A answer ${nextIndex}/${QA_QUESTIONS.length}.`);
        return;
      }

      setQaMessages(prev => [
        ...prev,
        { role: 'agent', text: 'Understood. Context captured. Proceeding to diagram generation, cost estimation, and Terraform generation.' },
      ]);
      addLog('[SYSTEM] Q/A context gathering completed. Resuming pipeline.');

      setTimeout(() => {
        setStageStatus(6, 'success', `${QA_QUESTIONS.length} answers`);
        setIsManuallyPaused(false);
        setPipelineState('running');
      }, 1200);
    }, 1200);
  };

  const handleUseMinimumDefaults = () => {
    const summary = buildDefaultQaSummary();
    setQaSummary(summary);
    setQaStep(QA_QUESTIONS.length - 1);
    setQaInput('');
    setIsAgentTyping(false);
    setQaMessages([
      { role: 'agent', text: QA_QUESTIONS[0] },
      { role: 'user', text: 'Use minimum-cost defaults.' },
      {
        role: 'agent',
        text: 'Minimum-cost defaults applied. Proceeding with low-cost architecture, cost estimation, and Terraform generation.',
      },
    ]);
    addLog('[USER] Applied minimum-cost default Q/A profile.');
    setStageStatus(6, 'success', 'Defaults');
    setIsManuallyPaused(false);
    setPipelineState('running');
  };

  const activeStage = useMemo(
    () => stages.find(s => s.id === activeStageId) || currentStage,
    [activeStageId, currentStage, stages],
  );

  const renderStageIcon = (status: StageStatus, isGate?: boolean) => {
    switch (status) {
      case 'success': return <CheckCircle className="w-4 h-4 text-emerald-500" />;
      case 'running': return <Loader className="w-4 h-4 text-cyan-400 animate-spin" />;
      case 'paused': return <AlertTriangle className="w-4 h-4 text-amber-500" />;
      case 'failed': return <XCircle className="w-4 h-4 text-rose-500" />;
      case 'skipped': return <FastForward className="w-4 h-4 text-zinc-600" />;
      case 'pending':
      default: return isGate ? <Lock className="w-4 h-4 text-zinc-600" /> : <CircleDashed className="w-4 h-4 text-zinc-600" />;
    }
  };

  return (
    <div className="h-screen bg-zinc-950 text-zinc-300 font-sans flex flex-col overflow-hidden selection:bg-cyan-500/30">
      <header className="h-14 border-b border-white/5 bg-zinc-950/80 backdrop-blur-md px-5 flex items-center justify-between shrink-0 relative z-20">
        <div className="flex items-center space-x-5">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-cyan-300">
            <DeplaiMark />
          </div>
          <span className="font-bold text-zinc-100 tracking-wide text-lg">DeplAI</span>
          <div className="h-5 w-px bg-white/10 mx-1" />
          <div className="hidden md:flex space-x-2">
            <span className="text-[11px] font-mono bg-zinc-900 px-2.5 py-1 rounded-md text-zinc-400 border border-white/5 shadow-sm">prd-eu-central</span>
            <span className="text-[11px] font-mono bg-zinc-900 px-2.5 py-1 rounded-md text-zinc-400 border border-white/5 shadow-sm">
              {selectedProjectName || 'no-project-selected'}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Link
              href="/dashboard/pipeline"
              className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-cyan-500/15 border border-cyan-400/30 text-cyan-200"
            >
              Pipeline
            </Link>
            <Link
              href="/dashboard/projects"
              className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-zinc-900 border border-white/10 text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              Projects
            </Link>
          </div>
        </div>
        <div className="flex items-center space-x-4">
          <a
            href="https://github.com/apps/deplai-gitapp-aj/installations/new"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-zinc-100 bg-cyan-500/15 hover:bg-cyan-500/25 px-3 py-1.5 rounded-md border border-cyan-400/30 text-xs font-semibold tracking-wide transition-colors shadow-sm"
            title="Install the DeplAI GitHub App and connect repositories"
          >
            Install GitHub App
          </a>
          <a
            href="https://github.com/apps/deplai-gitapp-aj"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-zinc-300 bg-zinc-900/50 hover:bg-zinc-800 px-3 py-1.5 rounded-md border border-white/10 text-xs font-semibold tracking-wide transition-colors shadow-sm"
            title="Manage installed repositories and connector settings"
          >
            Manage Repos
          </a>
          {user && (
            <a
              href={`https://github.com/${user.login}`}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${user.login} on GitHub`}
              className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-full pl-1 pr-3 py-1 hover:bg-white/10 hover:border-white/20 transition-colors"
            >
              {user.avatarUrl ? (
                <Image
                  src={user.avatarUrl}
                  alt={user.name || user.login}
                  width={24}
                  height={24}
                  className="w-6 h-6 rounded-full ring-1 ring-white/20"
                />
              ) : (
                <div className="w-6 h-6 rounded-full bg-cyan-500/25 flex items-center justify-center text-xs font-bold text-cyan-200">
                  {(user.name || user.login || '?')[0]?.toUpperCase()}
                </div>
              )}
              <span className="text-xs font-medium text-zinc-200">{user.name || user.login}</span>
            </a>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden min-h-0 h-full relative z-10">
        <aside className="w-[320px] border-r border-white/5 bg-zinc-950 flex flex-col shrink-0 overflow-y-auto custom-scrollbar">
          <div className="p-5 border-b border-white/5 sticky top-0 bg-zinc-950/95 backdrop-blur z-20 space-y-3">
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-[11px] font-bold text-zinc-400 uppercase tracking-[0.15em]">Pipeline Topology</h2>
                <div className="text-[10px] text-zinc-500 mt-1 font-mono flex items-center">
                  <Layers className="w-3 h-3 mr-1" /> Run: x7f9-2a1b
                </div>
              </div>
              {pipelineState === 'idle' ? (
                <button
                  onClick={startPipeline}
                  disabled={!selectedProject || loadingProjects}
                  className="bg-cyan-500 hover:bg-cyan-400 text-zinc-950 p-2 rounded-md transition-all shadow-[0_0_15px_rgba(6,182,212,0.3)] hover:shadow-[0_0_20px_rgba(6,182,212,0.5)] disabled:opacity-40 disabled:cursor-not-allowed"
                  title={!selectedProject ? 'Select a project first' : 'Start Pipeline'}
                >
                  <Play className="w-4 h-4 fill-current" />
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  {isRunning && pipelineState === 'running' && (
                    <button
                      onClick={pausePipeline}
                      className="bg-amber-500/15 hover:bg-amber-500/25 border border-amber-400/30 text-amber-300 px-3 py-1.5 rounded-md transition-colors shadow-sm text-[11px] font-semibold"
                      title="Pause Pipeline"
                    >
                      Pause
                    </button>
                  )}
                  {isManuallyPaused && (
                    <button
                      onClick={resumePipeline}
                      className="bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/30 text-cyan-300 px-3 py-1.5 rounded-md transition-colors shadow-sm text-[11px] font-semibold"
                      title="Resume Pipeline"
                    >
                      Resume
                    </button>
                  )}
                  <button onClick={resetPipeline} className="bg-zinc-800 hover:bg-zinc-700 border border-white/5 text-zinc-300 p-2 rounded-md transition-colors shadow-sm" title="Reset">
                    <RotateCcw className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <label htmlFor="pipeline-project" className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Target Repository</label>
              <select
                id="pipeline-project"
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                className="w-full bg-zinc-900/80 border border-white/10 rounded-md px-2.5 py-2 text-xs text-zinc-200 focus:outline-none focus:border-cyan-400/40"
              >
                {loadingProjects && <option value="">Loading repositories...</option>}
                {!loadingProjects && projects.length === 0 && <option value="">No repositories available</option>}
                {!loadingProjects && projects.map((project) => {
                  const label = project.type === 'github'
                    ? `${project.owner}/${project.repo}`
                    : `${project.name || project.id} (local)`;
                  return (
                    <option key={project.id} value={project.id}>{label}</option>
                  );
                })}
              </select>
              <p className="text-[10px] text-zinc-500">
                {selectedProject ? `Pipeline target: ${selectedProjectName}` : 'Choose a repository before starting.'}
              </p>
              {selectedProject?.type === 'github' && (
                <div className="space-y-1.5 rounded-md border border-white/10 bg-zinc-900/40 p-2.5">
                  <label htmlFor="runtime-github-token" className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                    Runtime GitHub Token
                  </label>
                  <input
                    id="runtime-github-token"
                    type="password"
                    autoComplete="off"
                    value={runtimeGithubToken}
                    onChange={(e) => setRuntimeGithubToken(e.target.value)}
                    placeholder="Required for remediation PR creation"
                    className="w-full bg-zinc-950 border border-white/10 rounded-md px-2.5 py-2 text-xs text-zinc-200 focus:outline-none focus:border-cyan-400/40"
                  />
                  <p className="text-[10px] text-zinc-500">
                    Not persisted. Used only for this runtime remediation flow.
                  </p>
                </div>
              )}
              <div className="space-y-1.5 rounded-md border border-white/10 bg-zinc-900/40 p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                  Runtime AWS Credentials
                </div>
                <input
                  type="text"
                  autoComplete="off"
                  value={awsAccessKeyId}
                  onChange={(e) => setAwsAccessKeyId(e.target.value)}
                  placeholder="AWS access key id"
                  className="w-full bg-zinc-950 border border-white/10 rounded-md px-2.5 py-2 text-xs text-zinc-200 focus:outline-none focus:border-cyan-400/40"
                />
                <input
                  type="password"
                  autoComplete="off"
                  value={awsSecretAccessKey}
                  onChange={(e) => setAwsSecretAccessKey(e.target.value)}
                  placeholder="AWS secret access key"
                  className="w-full bg-zinc-950 border border-white/10 rounded-md px-2.5 py-2 text-xs text-zinc-200 focus:outline-none focus:border-cyan-400/40"
                />
                <input
                  type="text"
                  autoComplete="off"
                  value={awsRegion}
                  onChange={(e) => setAwsRegion(e.target.value)}
                  placeholder="AWS region (e.g. ap-south-1)"
                  className="w-full bg-zinc-950 border border-white/10 rounded-md px-2.5 py-2 text-xs text-zinc-200 focus:outline-none focus:border-cyan-400/40"
                />
                <p className="text-[10px] text-zinc-500">
                  Required only when you click Deploy at stage 10.
                </p>
              </div>
              {selectedProject && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => router.push(`/dashboard/security-analysis/${encodeURIComponent(selectedProject.id)}`)}
                    className="text-[10px] px-2 py-1 rounded border border-cyan-400/30 text-cyan-200 bg-cyan-500/10 hover:bg-cyan-500/20 transition-colors"
                  >
                    Open Results
                  </button>
                  {remediationPrUrl && (
                    <a
                      href={remediationPrUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] px-2 py-1 rounded border border-emerald-400/30 text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/20 transition-colors inline-flex items-center gap-1"
                    >
                      View PR <ArrowUpRight className="w-3 h-3" />
                    </a>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="p-5 relative">
            <div className="absolute left-[39px] top-10 bottom-10 w-[2px] bg-zinc-800/50 rounded-full" />

            {stages.map((stage) => {
              const isCycleNode = stage.id >= 1 && stage.id <= 4.6;
              const showCycleHeader = stage.id === 1;
              const showCycleFooter = stage.id === 4.6;
              const isActive = activeStageId === stage.id;

              const isCompleted = stage.status === 'success';
              const isFailed = stage.status === 'failed';
              const isSkipped = stage.status === 'skipped';

              return (
                <React.Fragment key={stage.id}>
                  {showCycleHeader && (
                    <div className="ml-12 mb-3 mt-4 px-3 py-2 bg-zinc-900/80 border border-white/5 rounded-md flex items-center justify-between text-[11px] font-semibold relative z-10 shadow-sm">
                      <span className="text-zinc-400 uppercase tracking-wider flex items-center"><RotateCcw className="w-3 h-3 mr-1.5" /> Remediation Loop</span>
                      <span className={`px-2 py-0.5 rounded-sm font-mono text-[10px] ${cycle === MAX_CYCLES ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'}`}>
                        Attempt {cycle}/{MAX_CYCLES}
                      </span>
                    </div>
                  )}

                  <div
                    className={`relative z-10 flex items-center p-2 rounded-lg cursor-pointer transition-all mb-1.5 ${isActive ? 'bg-zinc-900 border border-white/10 shadow-sm' : 'hover:bg-zinc-900/50 border border-transparent'} ${isCycleNode ? 'ml-6' : ''}`}
                    onClick={() => setActiveStageId(stage.id)}
                  >
                    <div className={`flex items-center justify-center w-8 h-8 rounded-full bg-zinc-950 ring-4 ring-zinc-950 z-20 relative ${isActive ? 'shadow-[0_0_15px_rgba(34,211,238,0.2)]' : ''}`}>
                      {renderStageIcon(stage.status, stage.isGate)}
                      {isActive && <div className="absolute inset-0 border-2 border-cyan-500/30 rounded-full animate-ping" />}
                    </div>

                    <div className="ml-3.5 flex-1 min-w-0">
                      <div className={`text-xs font-semibold truncate ${isActive ? 'text-zinc-100' : isCompleted ? 'text-zinc-300' : isFailed ? 'text-rose-400' : isSkipped ? 'text-zinc-600 line-through' : 'text-zinc-500'}`}>
                        <span className="opacity-40 font-mono mr-1.5 font-medium">{stage.id}</span>
                        {stage.label}
                      </div>
                      {stage.status === 'failed' && (
                        <div className="text-[10px] text-rose-400 mt-0.5 font-medium flex items-center"><XCircle className="w-3 h-3 mr-1" /> Execution halted</div>
                      )}
                      {stage.status === 'paused' && (
                        <div className="text-[10px] text-amber-400 mt-0.5 font-medium flex items-center"><AlertTriangle className="w-3 h-3 mr-1" /> Awaiting intervention</div>
                      )}
                    </div>

                    {stage.duration && (
                      <div className="text-[10px] text-zinc-600 font-mono bg-zinc-900/50 px-1.5 py-0.5 rounded">{stage.duration}</div>
                    )}
                  </div>

                  {showCycleFooter && (
                    <div className="ml-12 mb-5 mt-3 h-px bg-gradient-to-r from-zinc-800 to-transparent relative z-10 flex items-center">
                      <span className="bg-zinc-950 pr-2 text-[9px] text-zinc-600 uppercase tracking-widest font-semibold">End Loop</span>
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </aside>

        <main className="flex-1 flex flex-col relative bg-zinc-950 min-w-0 h-full border-r border-white/5">
          <div className="h-[72px] border-b border-white/5 flex items-center px-6 justify-between bg-zinc-950/80 backdrop-blur-md z-20 shrink-0">
            <div>
              <h1 className="text-sm font-bold text-zinc-100 flex items-center gap-2.5">
                {activeStage ? (
                  <><span className="text-cyan-500 font-mono bg-cyan-500/10 px-2 py-0.5 rounded text-xs border border-cyan-500/20">{activeStage.id}</span> {activeStage.label}</>
                ) : 'Pipeline Overview'}
                {activeStage?.status === 'running' && <span className="flex w-2 h-2 rounded-full bg-cyan-400 animate-pulse ml-1 shadow-[0_0_8px_rgba(34,211,238,0.8)]" />}
              </h1>
              <p className="text-[11px] text-zinc-500 mt-1 uppercase tracking-[0.05em] font-medium">
                {activeStage?.isGate ? 'Requires manual policy enforcement' : 'Automated execution segment'}
              </p>
            </div>

            <div className="flex gap-3">
              {activeStage && (activeStage.status === 'running' || activeStage.status === 'paused') && (
                <button onClick={handleSkipStage} className="px-4 py-2 bg-zinc-900/50 hover:bg-zinc-800 text-zinc-300 text-xs font-semibold rounded-md border border-white/5 transition-colors shadow-sm flex items-center mr-2">
                  <FastForward className="w-3.5 h-3.5 mr-2 text-zinc-500" />
                  Skip Step (S)
                </button>
              )}

              {activeStage?.id === 3 && (activeStage.status === 'running' || activeStage.status === 'paused') && (
                <button
                  onClick={handleSkipRemediationToQa}
                  className="px-4 py-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-semibold rounded-md flex items-center transition-colors shadow-sm"
                >
                  <FastForward className="w-3.5 h-3.5 mr-2" />
                  Skip Remediation → Q/A
                </button>
              )}

              {(activeStage?.id === 4 || activeStage?.id === 4.5) && (activeStage.status === 'running' || activeStage.status === 'paused') && (
                <button
                  onClick={handleProceedToQaWithoutPr}
                  className="px-4 py-2 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 text-xs font-semibold rounded-md flex items-center transition-colors shadow-sm"
                >
                  <FastForward className="w-3.5 h-3.5 mr-2" />
                  Proceed To Q/A
                </button>
              )}

              {activeStage?.id === 4.5 && activeStage.status === 'paused' && (
                <>
                  {remediationPrUrl && (
                    <a
                      href={remediationPrUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-semibold rounded-md border border-white/5 transition-colors shadow-sm inline-flex items-center"
                    >
                      Open PR <ArrowUpRight className="w-3.5 h-3.5 ml-1.5" />
                    </a>
                  )}
                  <button onClick={handleApproveMerge} className="px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-xs font-semibold rounded-md flex items-center transition-colors shadow-sm">
                    <GitMerge className="w-3.5 h-3.5 mr-2" />
                    I Merged The PR
                  </button>
                  <button
                    onClick={handleContinueAfterPr}
                    className="px-4 py-2 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-xs font-semibold rounded-md flex items-center transition-colors shadow-sm"
                  >
                    <FastForward className="w-3.5 h-3.5 mr-2" />
                    Continue Process
                  </button>
                </>
              )}
              {activeStage?.id === 7.5 && activeStage.status === 'paused' && (
                <button
                  onClick={handleApproveArchitectureCost}
                  className="px-4 py-2 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 text-xs font-semibold rounded-md flex items-center transition-colors shadow-sm"
                >
                  <CheckCircle className="w-3.5 h-3.5 mr-2" />
                  Approve Diagram + Cost
                </button>
              )}
              {activeStage?.id === 9 && activeStage.status === 'paused' && (
                <button onClick={handleOverrideBudget} className="px-4 py-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-400 text-xs font-semibold rounded-md flex items-center transition-colors shadow-sm">
                  <DollarSign className="w-3.5 h-3.5 mr-1" />
                  Override Policy (O)
                </button>
              )}
              {activeStage?.id === 10 && activeStage.status === 'paused' && (
                <button
                  onClick={handleDeployAws}
                  disabled={deploying}
                  className="px-4 py-2 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 text-xs font-semibold rounded-md flex items-center transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {deploying ? <Loader className="w-3.5 h-3.5 mr-2 animate-spin" /> : <Server className="w-3.5 h-3.5 mr-2" />}
                  {deploying ? 'Deploying...' : 'Deploy To AWS'}
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-hidden flex flex-col relative min-h-0 bg-[#09090b]">
            {((activeStage?.id === 6 || activeStage?.id === 4.5 || activeStage?.id === 7.5 || activeStage?.status === 'failed') && activeStage.status !== 'success' && activeStage.status !== 'skipped') && (
              <div className="absolute inset-0 z-30 bg-zinc-950/40 backdrop-blur-[2px] flex items-center justify-center p-8">
                {activeStage?.id === 6 && activeStage.status === 'paused' && (
                  <div className="w-full max-w-3xl h-full max-h-[600px] bg-[#0c0c0e] border border-white/10 rounded-xl shadow-2xl flex flex-col overflow-hidden">
                    <div className="bg-zinc-900/80 border-b border-white/5 px-6 py-4 flex items-center justify-between shrink-0">
                      <div className="flex items-center">
                        <div className="bg-indigo-500/10 p-2 rounded-lg mr-4 border border-indigo-500/20">
                          <MessageSquare className="w-5 h-5 text-indigo-400" />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold text-zinc-100">Operator Context Gathering</h3>
                          <p className="text-[11px] text-zinc-400 mt-0.5">DeplAI Agent requires input to finalize infrastructure.</p>
                        </div>
                      </div>
                      <button
                        onClick={handleUseMinimumDefaults}
                        className="px-3 py-2 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-400/30 text-amber-200 text-[11px] font-semibold rounded-md transition-colors"
                      >
                        Use Minimum Defaults
                      </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-[#0c0c0e] custom-scrollbar">
                      {qaMessages.map((msg, idx) => (
                        <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                          <div className={`max-w-[80%] p-4 rounded-xl text-[13px] leading-relaxed border shadow-sm ${
                            msg.role === 'user'
                              ? 'bg-indigo-500/10 border-indigo-500/20 text-indigo-100 rounded-br-sm'
                              : 'bg-zinc-900/50 border-white/5 text-zinc-300 rounded-bl-sm'
                          }`}>
                            {msg.role === 'agent' && <div className="text-[10px] text-indigo-400 font-bold mb-2 uppercase tracking-widest flex items-center"><Cpu className="w-3.5 h-3.5 mr-1.5" /> DeplAI Agent</div>}
                            {msg.role === 'user' && <div className="text-[10px] text-zinc-500 font-bold mb-2 uppercase tracking-widest text-right">Operator</div>}
                            {msg.text}
                          </div>
                        </div>
                      ))}
                    </div>
                    <form onSubmit={handleQASubmit} className="p-4 bg-zinc-900/50 border-t border-white/5 flex gap-3 shrink-0">
                      <input
                        type="text"
                        value={qaInput}
                        onChange={(e) => setQaInput(e.target.value)}
                        placeholder="Type your response..."
                        className="flex-1 bg-[#09090b] border border-white/10 rounded-lg px-4 py-2.5 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all placeholder:text-zinc-600 shadow-inner"
                        disabled={isAgentTyping}
                      />
                      <button
                        type="submit"
                        disabled={isAgentTyping || !qaInput.trim()}
                        className="bg-indigo-500 hover:bg-indigo-400 text-zinc-950 px-6 py-2.5 rounded-lg font-bold text-sm flex items-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Send <Send className="w-4 h-4 ml-2" />
                      </button>
                    </form>
                  </div>
                )}
                {activeStage?.id === 7.5 && activeStage.status === 'paused' && (
                  <div className="w-full max-w-5xl h-full max-h-[680px] bg-[#0c0c0e] border border-white/10 rounded-xl shadow-2xl flex flex-col overflow-hidden">
                    <div className="bg-zinc-900/80 border-b border-white/5 px-6 py-4 flex items-center justify-between shrink-0">
                      <div className="flex items-center">
                        <div className="bg-indigo-500/10 p-2 rounded-lg mr-4 border border-indigo-500/20">
                          <DollarSign className="w-5 h-5 text-indigo-300" />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold text-zinc-100">Approve Architecture + Cost</h3>
                          <p className="text-[11px] text-zinc-400 mt-0.5">
                            Review generated outputs before Terraform generation.
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={handleApproveArchitectureCost}
                        className="px-4 py-2 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-400/30 text-indigo-200 text-xs font-semibold rounded-md transition-colors"
                      >
                        Approve Diagram + Cost
                      </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-6 space-y-5 bg-[#0c0c0e] custom-scrollbar">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="rounded-lg border border-white/10 bg-zinc-900/40 p-4">
                          <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-2">
                            Estimated Monthly Cost
                          </div>
                          <div className="text-2xl font-bold text-emerald-300">${costEstimate.toFixed(2)}</div>
                          <div className="text-[11px] text-zinc-400 mt-2">
                            Budget cap: ${BUDGET_CAP.toFixed(2)} / month
                          </div>
                        </div>
                        <div className="rounded-lg border border-white/10 bg-zinc-900/40 p-4">
                          <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-2">
                            Architecture Status
                          </div>
                          <div className="text-[12px] text-zinc-300">
                            {generatedDiagram ? 'Diagram generated' : 'Diagram unavailable'}
                          </div>
                          <div className="text-[12px] text-zinc-300 mt-2">
                            {architectureJson ? 'Architecture JSON generated' : 'Architecture JSON unavailable'}
                          </div>
                        </div>
                      </div>

                      <div className="rounded-lg border border-white/10 bg-zinc-900/40 p-4 space-y-4">
                        <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">
                          Diagram Preview (AWS Icons)
                        </div>
                        {generatedDiagramNodes.length > 0 ? (
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {generatedDiagramNodes.map((node) => (
                              <div
                                key={node.id}
                                className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 flex items-center gap-3"
                              >
                                <Image
                                  src={node.icon_url}
                                  alt={`${node.label} icon`}
                                  width={28}
                                  height={28}
                                  className="rounded-sm border border-white/10 bg-zinc-950/60 shrink-0"
                                  unoptimized
                                />
                                <div className="min-w-0">
                                  <div className="text-[12px] text-zinc-200 font-medium truncate">{node.label}</div>
                                  <div className="text-[10px] text-zinc-500 truncate">
                                    {node.type || 'generic'} | {node.icon_name}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-[11px] text-zinc-400">No diagram nodes available.</div>
                        )}
                        <div>
                          <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-2">
                            Mermaid Source
                          </div>
                          <pre className="text-[11px] leading-relaxed text-zinc-300 whitespace-pre-wrap break-words max-h-56 overflow-y-auto custom-scrollbar">
                            {generatedDiagram || 'No diagram content available.'}
                          </pre>
                        </div>
                      </div>

                      <div className="rounded-lg border border-white/10 bg-zinc-900/40 p-4">
                        <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-2">
                          Architecture JSON Preview
                        </div>
                        <pre className="text-[11px] leading-relaxed text-zinc-300 whitespace-pre-wrap break-words max-h-56 overflow-y-auto custom-scrollbar">
                          {architectureJson ? JSON.stringify(architectureJson, null, 2) : 'No architecture JSON available.'}
                        </pre>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex-1 relative bg-[#0c0c0e] min-h-0 shadow-inner">
              <div className="absolute inset-0 overflow-y-auto p-5 font-mono text-[11px] leading-[1.8] selection:bg-cyan-500/30 custom-scrollbar">
                {logs.length === 0 && monitorMessages.length === 0 ? (
                  <div className="text-zinc-600 flex items-center justify-center h-full">
                    <div className="text-center">
                      <Terminal className="w-10 h-10 mx-auto mb-4 opacity-20" />
                      <div className="uppercase tracking-[0.2em] text-[10px] font-bold opacity-50">Awaiting websocket monitor stream...</div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4 pb-4">
                    {logs.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-[10px] uppercase tracking-widest text-zinc-600 font-semibold">Pipeline Events</div>
                        {logs.map((log) => {
                          const isError = log.text.includes('[ERROR]') || log.text.includes('[FATAL]');
                          const isWarn = log.text.includes('[WARN]') || log.text.includes('VIOLATION');
                          const isSystem = log.text.includes('>>>') || log.text.includes('<<<') || log.text.includes('[SYSTEM]');
                          const isInfo = log.text.includes('[INFO]');
                          const isUser = log.text.includes('[USER]');

                          let colorClass = 'text-zinc-400';
                          let bgClass = 'hover:bg-zinc-900/50';

                          if (isError) {
                            colorClass = 'text-rose-400 font-medium';
                            bgClass = 'bg-rose-500/5 border-l-2 border-rose-500';
                          } else if (isWarn) {
                            colorClass = 'text-amber-400';
                            bgClass = 'bg-amber-500/5 border-l-2 border-amber-500';
                          } else if (isSystem) {
                            colorClass = 'text-purple-400 font-semibold';
                          } else if (isInfo) {
                            colorClass = 'text-cyan-400';
                          } else if (isUser) {
                            colorClass = 'text-indigo-300 font-medium bg-indigo-500/5 border-l-2 border-indigo-400 pl-2';
                            bgClass = '';
                          }

                          return (
                            <div key={log.id} className={`flex px-2 py-0.5 rounded-sm transition-colors ${bgClass}`}>
                              <span className={colorClass}>{log.text}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {monitorMessages.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-[10px] uppercase tracking-widest text-zinc-600 font-semibold">WebSocket Monitor ({monitorState})</div>
                        {monitorMessages.map((msg, i) => {
                          if (msg.type === 'kg_result') {
                            return (
                              <div key={`${msg.timestamp}-${i}`} className="flex gap-2 px-2 py-0.5 rounded-sm">
                                <span className="text-violet-300">[KG] Knowledge context captured, enriching remediation prompt.</span>
                              </div>
                            );
                          }
                          if (msg.type === 'changed_files') {
                            let count = 0;
                            try { count = JSON.parse(msg.content).length; } catch { /* ignore */ }
                            return (
                              <div key={`${msg.timestamp}-${i}`} className="flex gap-2 px-2 py-0.5 rounded-sm">
                                <span className="text-indigo-300">[+] {count} file{count !== 1 ? 's' : ''} queued for remediation.</span>
                              </div>
                            );
                          }
                          const style = MESSAGE_STYLES[msg.type] || MESSAGE_STYLES.info;
                          return (
                            <div key={`${msg.timestamp}-${i}`} className="flex gap-2 px-2 py-0.5 rounded-sm">
                              <span className={style.color}>
                                {style.prefix ? `${style.prefix} ${msg.content}` : msg.content}
                              </span>
                            </div>
                          );
                        })}
                        {monitorState === 'running' && (
                          <div className="px-2 py-0.5">
                            <span className="text-green-400 animate-pulse">$$ / &#x2588;</span>
                          </div>
                        )}
                      </div>
                    )}
                    <div ref={logsEndRef} className="h-2" />
                  </div>
                )}
              </div>
            </div>

            <div className="h-8 bg-[#09090b] border-t border-white/5 flex items-center px-4 justify-between text-[10px] text-zinc-500 uppercase tracking-widest shrink-0">
              <div className="flex items-center gap-5">
                <span className="flex items-center gap-1.5"><Server className="w-3.5 h-3.5 text-zinc-600" /> eu-central-w1</span>
                <span className="flex items-center gap-1.5">
                  <Wifi className="w-3.5 h-3.5 text-emerald-500" />
                  <span className="font-semibold text-zinc-400">Connected</span>
                  {isRunning && <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse ml-0.5 shadow-[0_0_5px_rgba(16,185,129,0.8)]" />}
                </span>
                <span className="font-mono bg-zinc-900 px-1.5 py-0.5 rounded border border-white/5">12ms</span>
              </div>
              <div className="flex items-center gap-2 font-medium">
                <span className="w-2 h-2 rounded-full bg-cyan-500/50 shadow-sm" />
                {selectedProject ? selectedProjectName : 'No target selected'}
                {majorFindingsRemaining !== null && (
                  <span className={`px-1.5 py-0.5 rounded border text-[9px] font-semibold ${majorFindingsRemaining > 0 ? 'border-amber-500/40 text-amber-300 bg-amber-500/10' : 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'}`}>
                    major: {majorFindingsRemaining}
                  </span>
                )}
                {generatedDiagram && (
                  <span className="px-1.5 py-0.5 rounded border border-indigo-400/40 text-indigo-200 bg-indigo-500/10 text-[9px] font-semibold">
                    diagram ready
                  </span>
                )}
                {deploymentSummary?.cloudfrontUrl && (
                  <a
                    href={deploymentSummary.cloudfrontUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-1.5 py-0.5 rounded border border-cyan-400/40 text-cyan-200 bg-cyan-500/10 text-[9px] font-semibold inline-flex items-center gap-1"
                  >
                    cloudfront <ArrowUpRight className="w-2.5 h-2.5" />
                  </a>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #27272a;
          border-radius: 3px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #3f3f46;
        }
      ` }} />
    </div>
  );
}

