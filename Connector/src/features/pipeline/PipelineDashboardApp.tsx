'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { STAGES } from './data';
import { ArchPage, DeployPage, GitOpsPage, IaCPage, QAPage } from './pages-delivery';
import { OverviewPage, PreflightPage, ScanPage } from './pages-overview-security';
import { MergeGatePage, PostMergePage, RemediationPage } from './pages-remediation';
import { GlobalStyles, ProjectSelector, RunOptionsModal, Sidebar } from './ui';
import type { PipelineRunOptions } from './ui';
import type { PipelineProject, RuntimeScanResults, Stage } from './types';
import { useScan } from '@/lib/scan-context';

interface ProjectsResponse {
  projects?: Array<{
    id: string;
    name: string;
    type: 'local' | 'github';
    source?: string;
    owner?: string;
    repo?: string;
    installationId?: string;
  }>;
}

interface HealthCheck {
  name: string;
  state: 'healthy' | 'degraded' | 'down';
  detail: string;
}

type RunnerState = 'idle' | 'running' | 'error';
const SELECTED_PROJECT_STORAGE_KEY = 'deplai.pipeline.selectedProjectId';
const RUN_OPTIONS_STORAGE_KEY = 'deplai.pipeline.runOptions';
const MERGE_CONFIRMED_STORAGE_PREFIX = 'deplai.pipeline.mergeConfirmed.';
const POST_MERGE_DONE_STORAGE_PREFIX = 'deplai.pipeline.postMergeDone.';
const CURRENT_STAGE_STORAGE_PREFIX = 'deplai.pipeline.currentStage.';
const DEPLOY_STATE_STORAGE_PREFIX = 'deplai.pipeline.deployState.';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSavedCostEstimate(): { totalMonthlyUsd: number | null; budgetCapUsd: number | null } {
  if (typeof window === 'undefined') {
    return { totalMonthlyUsd: null, budgetCapUsd: null };
  }
  try {
    const raw = sessionStorage.getItem('deplai.pipeline.costEstimate');
    if (!raw) return { totalMonthlyUsd: null, budgetCapUsd: null };
    const parsed = JSON.parse(raw) as { total_monthly_usd?: number; budget_cap_usd?: number };
    const total = Number(parsed.total_monthly_usd);
    const cap = Number(parsed.budget_cap_usd);
    return {
      totalMonthlyUsd: Number.isFinite(total) ? total : null,
      budgetCapUsd: Number.isFinite(cap) ? cap : null,
    };
  } catch {
    return { totalMonthlyUsd: null, budgetCapUsd: null };
  }
}

export default function PipelineDashboardApp() {
  const router = useRouter();
  const { startScan, startRemediation, continueRemediationRound, pushCurrentRemediationChanges, approveRemediationPush, getRemediationState, getScanState } = useScan();

  const validStageKeys = useMemo(() => new Set(['overview', ...STAGES.map((s) => s.key)]), []);
  const [current, setCurrent] = useState<string>('overview');
  const [showOptions, setShowOptions] = useState<boolean>(false);
  const [projects, setProjects] = useState<PipelineProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      return localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [scanStatus, setScanStatus] = useState<string>('not_initiated');
  const [scanResults, setScanResults] = useState<RuntimeScanResults | null>(null);
  const [healthOverall, setHealthOverall] = useState<string>('unknown');
  const [healthChecks, setHealthChecks] = useState<HealthCheck[]>([]);
  const [runnerState, setRunnerState] = useState<RunnerState>('idle');
  const [runnerError, setRunnerError] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [mergeConfirmed, setMergeConfirmed] = useState<boolean>(false);
  const [postMergeDone, setPostMergeDone] = useState<boolean>(false);
  const [rerunInProgress, setRerunInProgress] = useState<boolean>(false);
  const [deploySucceeded, setDeploySucceeded] = useState<boolean>(false);
  const [deployRuntimeState, setDeployRuntimeState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [kgPhase, setKgPhase] = useState<'idle' | 'running' | 'completed' | 'skipped'>('idle');
  const [runOptions, setRunOptions] = useState<PipelineRunOptions>(() => {
    if (typeof window === 'undefined') {
      return { autopilot: true, skipRemediation: false, skipScan: false };
    }
    try {
      const raw = localStorage.getItem(RUN_OPTIONS_STORAGE_KEY);
      if (!raw) return { autopilot: true, skipRemediation: false, skipScan: false };
      const parsed = JSON.parse(raw) as Partial<PipelineRunOptions>;
      return {
        autopilot: parsed.autopilot ?? true,
        skipRemediation: parsed.skipRemediation ?? false,
        skipScan: parsed.skipScan ?? false,
      };
    } catch {
      return { autopilot: true, skipRemediation: false, skipScan: false };
    }
  });
  const normalizedRunOptions = useMemo<PipelineRunOptions>(() => ({
    autopilot: Boolean(runOptions.autopilot),
    skipScan: Boolean(runOptions.skipScan),
    // Skip scan implies skip remediation (there is no scan output to remediate).
    skipRemediation: Boolean(runOptions.skipScan || runOptions.skipRemediation),
  }), [runOptions.autopilot, runOptions.skipRemediation, runOptions.skipScan]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) || null,
    [projects, selectedProjectId],
  );
  const githubAccounts = useMemo(
    () => Array.from(new Set(projects.filter((project) => project.type === 'github').map((project) => project.source).filter(Boolean))) as string[],
    [projects],
  );
  const neo4jConnected = useMemo(
    () => healthChecks.find((c) => c.name === 'neo4j')?.state === 'healthy',
    [healthChecks],
  );

  const remediation = selectedProjectId
    ? getRemediationState(selectedProjectId)
    : { state: 'idle' as const, messages: [] as Array<{ type: string; content: string; timestamp?: string }> };
  const scanState = selectedProjectId
    ? getScanState(selectedProjectId)
    : { state: 'idle' as const, messages: [] as Array<{ type: string; content: string; timestamp?: string }> };
  const scanRuntimeState = scanState.state;
  const [costEstimate, setCostEstimate] = useState<{ totalMonthlyUsd: number | null; budgetCapUsd: number | null }>({
    totalMonthlyUsd: null,
    budgetCapUsd: null,
  });
  const runtimeMessages = useMemo(() => {
    const normalize = (msg: { type?: string; content?: string; timestamp?: string }) => ({
      type: msg.type || 'info',
      content: msg.content || '',
      timestamp: msg.timestamp || new Date().toISOString(),
    });
    const scanMessages = scanState.messages.map(normalize);
    const remMessages = remediation.messages.map(normalize);
    return [...scanMessages, ...remMessages]
      .filter((m) => m.content.trim().length > 0)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .slice(-40);
  }, [remediation.messages, scanState.messages]);

  const changedFiles = useMemo(() => {
    const out = new Map<string, { path: string; reason?: string }>();
    for (const msg of remediation.messages) {
      if (msg.type === 'changed_files') {
        try {
          const payload = JSON.parse(msg.content) as Array<{ path?: string; reason?: string }>;
          payload.forEach((item) => {
            if (!item?.path) return;
            out.set(item.path, { path: item.path, reason: item.reason });
          });
        } catch {
          // ignore malformed payload
        }
      }
      if (msg.type === 'info' && msg.content.startsWith('Updated ')) {
        const path = msg.content.replace(/^Updated\s+/, '').trim();
        if (path) out.set(path, { path });
      }
    }
    return Array.from(out.values());
  }, [remediation.messages]);
  const noRemediationChanges = useMemo(() => {
    if (remediation.state !== 'completed') return false;
    if (prUrl) return false;
    if (changedFiles.length > 0) return false;
    return remediation.messages.some((msg) => {
      const text = msg.content.toLowerCase();
      return text.includes('no safe changes') || text.includes('no file changes');
    });
  }, [changedFiles.length, prUrl, remediation.messages, remediation.state]);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json() as ProjectsResponse;
      const mapped = (data.projects || []).map((project) => ({
        id: project.id,
        name: project.name,
        type: project.type,
        source: project.source,
        owner: project.owner,
        repo: project.repo,
        installationId: project.installationId,
      }));
      setProjects(mapped);
      setSelectedProjectId((prev) => {
        if (prev && mapped.some((project) => project.id === prev)) return prev;
        if (typeof window !== 'undefined') {
          try {
            const persisted = localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
            if (persisted && mapped.some((project) => project.id === persisted)) return persisted;
          } catch {
            // ignore storage failures
          }
        }
        return mapped[0]?.id || null;
      });
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (selectedProjectId) {
        localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, selectedProjectId);
      } else {
        localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
      }
    } catch {
      // ignore storage failures
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(RUN_OPTIONS_STORAGE_KEY, JSON.stringify(normalizedRunOptions));
    } catch {
      // ignore storage failures
    }
  }, [normalizedRunOptions]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!selectedProjectId) {
      setMergeConfirmed(false);
      setPostMergeDone(false);
      return;
    }
    try {
      setMergeConfirmed(localStorage.getItem(`${MERGE_CONFIRMED_STORAGE_PREFIX}${selectedProjectId}`) === '1');
      setPostMergeDone(localStorage.getItem(`${POST_MERGE_DONE_STORAGE_PREFIX}${selectedProjectId}`) === '1');
    } catch {
      setMergeConfirmed(false);
      setPostMergeDone(false);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!selectedProjectId) {
      setCurrent('overview');
      return;
    }
    try {
      const saved = localStorage.getItem(`${CURRENT_STAGE_STORAGE_PREFIX}${selectedProjectId}`);
      if (saved && validStageKeys.has(saved)) {
        setCurrent(saved);
      } else {
        setCurrent('overview');
      }
    } catch {
      setCurrent('overview');
    }
  }, [selectedProjectId, validStageKeys]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!selectedProjectId) {
      setDeploySucceeded(false);
      return;
    }
    try {
      const raw = localStorage.getItem(`${DEPLOY_STATE_STORAGE_PREFIX}${selectedProjectId}`);
      if (!raw) {
        setDeploySucceeded(false);
        return;
      }
      const saved = JSON.parse(raw) as { status?: string };
      setDeploySucceeded(saved.status === 'done');
    } catch {
      setDeploySucceeded(false);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (typeof window === 'undefined' || !selectedProjectId) return;
    if (!validStageKeys.has(current)) return;
    try {
      localStorage.setItem(`${CURRENT_STAGE_STORAGE_PREFIX}${selectedProjectId}`, current);
    } catch {
      // ignore storage failures
    }
  }, [current, selectedProjectId, validStageKeys]);

  useEffect(() => {
    if (typeof window === 'undefined' || !selectedProjectId) return;
    try {
      localStorage.setItem(`${MERGE_CONFIRMED_STORAGE_PREFIX}${selectedProjectId}`, mergeConfirmed ? '1' : '0');
    } catch {
      // ignore storage failures
    }
  }, [mergeConfirmed, selectedProjectId]);

  useEffect(() => {
    if (typeof window === 'undefined' || !selectedProjectId) return;
    try {
      localStorage.setItem(`${POST_MERGE_DONE_STORAGE_PREFIX}${selectedProjectId}`, postMergeDone ? '1' : '0');
    } catch {
      // ignore storage failures
    }
  }, [postMergeDone, selectedProjectId]);

  const refreshRuntime = useCallback(async () => {
    try {
      const healthRes = await fetch('/api/pipeline/health', { cache: 'no-store' });
      if (healthRes.ok) {
        const healthData = await healthRes.json() as { overall?: string; checks?: HealthCheck[] };
        setHealthOverall(healthData.overall || 'unknown');
        setHealthChecks(Array.isArray(healthData.checks) ? healthData.checks : []);
      }
    } catch {
      setHealthOverall('unknown');
      setHealthChecks([]);
    }

    if (!selectedProjectId) {
      setScanStatus('not_initiated');
      setScanResults(null);
      setPrUrl(null);
      return;
    }

    try {
      const statusRes = await fetch(`/api/scan/status?project_id=${encodeURIComponent(selectedProjectId)}`, { cache: 'no-store' });
      const statusData = statusRes.ok ? await statusRes.json() as { status?: string } : { status: 'not_initiated' };
      const status = statusData.status || 'not_initiated';
      setScanStatus(status);

      if (status === 'found') {
        const resultsRes = await fetch(`/api/scan/results?project_id=${encodeURIComponent(selectedProjectId)}`, { cache: 'no-store' });
        if (resultsRes.ok) {
          const resultsData = await resultsRes.json() as { data?: RuntimeScanResults };
          setScanResults(resultsData.data || null);
        } else {
          setScanResults(null);
        }
      } else {
        setScanResults(null);
      }

      const prRes = await fetch('/api/pipeline/remediation-pr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: selectedProjectId }),
      });
      if (prRes.ok) {
        const prData = await prRes.json() as { pr_url?: string | null };
        setPrUrl(prData.pr_url || null);
      }
    } catch {
      setScanStatus('not_initiated');
      setScanResults(null);
      setPrUrl(null);
    }
  }, [selectedProjectId]);

  const pollScanUntilFinished = useCallback(async (projectId: string): Promise<string> => {
    const start = Date.now();
    const timeoutMs = 15 * 60 * 1000;

    while (Date.now() - start < timeoutMs) {
      const res = await fetch(`/api/scan/status?project_id=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
      if (!res.ok) {
        await sleep(3000);
        continue;
      }
      const payload = await res.json() as { status?: string };
      const status = payload.status || 'not_initiated';
      if (status === 'found' || status === 'not_found' || status === 'error') return status;
      await sleep(3000);
    }

    throw new Error('Scan timed out before completion.');
  }, []);

  const runScanFlow = useCallback(async (navigateOnDone: boolean, skipRemediation: boolean) => {
    if (!selectedProject) return 'not_initiated';

    const validatePayload: Record<string, unknown> = {
      project_id: selectedProject.id,
      project_name: selectedProject.name,
      project_type: selectedProject.type,
      scan_type: 'all',
    };
    if (selectedProject.type === 'github') {
      validatePayload.owner = selectedProject.owner;
      validatePayload.repo = selectedProject.repo;
    }

    const validateRes = await fetch('/api/scan/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validatePayload),
    });
    if (!validateRes.ok) {
      const errBody = await validateRes.json().catch(() => ({})) as { error?: string };
      throw new Error(errBody.error || 'Scan validation failed.');
    }

    await startScan(selectedProject.id, selectedProject.name);
    const finalScan = await pollScanUntilFinished(selectedProject.id);
    await refreshRuntime();

    if (navigateOnDone) {
      if (finalScan === 'found') {
        if (skipRemediation) {
          setKgPhase('idle');
          setPostMergeDone(true);
          setCurrent('qa');
          return finalScan;
        }
        setCurrent('scan');
        if (neo4jConnected) {
          setKgPhase('running');
          setCurrent('kg');
          await sleep(1200);
          setKgPhase('completed');
        } else {
          setKgPhase('skipped');
        }
        setCurrent('remediate');
      }
      if (finalScan === 'not_found') {
        setKgPhase('idle');
        setPostMergeDone(true);
        setCurrent('qa');
      }
    }

    return finalScan;
  }, [neo4jConnected, pollScanUntilFinished, refreshRuntime, selectedProject, startScan]);

  const runInitialScan = useCallback(async () => {
    if (!selectedProject) return;

    try {
      setRunnerState('running');
      setRunnerError(null);
      setMergeConfirmed(false);
      setPostMergeDone(false);
      setPrUrl(null);
      setKgPhase('idle');

      const healthRes = await fetch('/api/pipeline/health', { cache: 'no-store' });
      if (!healthRes.ok) throw new Error('Preflight check failed.');

      if (normalizedRunOptions.skipScan) {
        setPostMergeDone(true);
        setKgPhase('skipped');
        setCurrent('qa');
        setRunnerState('idle');
        return;
      }

      await runScanFlow(true, normalizedRunOptions.skipRemediation);
      setRunnerState('idle');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Pipeline run failed.';
      setRunnerError(message);
      setRunnerState('error');
    }
  }, [normalizedRunOptions.skipRemediation, normalizedRunOptions.skipScan, runScanFlow, selectedProject]);

  const onDisconnectGitHub = useCallback(async () => {
    if (githubAccounts.length === 0) return;
    if (!window.confirm('Disconnect GitHub from DeplAI for this account?')) return;
    try {
      const res = await fetch('/api/installations', { method: 'DELETE' });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(data.error || 'Failed to disconnect GitHub');
      await loadProjects();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to disconnect GitHub';
      setRunnerError(msg);
    }
  }, [githubAccounts.length, loadProjects]);

  const onLogout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      router.push('/');
    }
  }, [router]);

  const onStartRemediation = useCallback(async () => {
    if (!selectedProjectId) return;
    try {
      setRunnerError(null);
      await startRemediation(selectedProjectId);
      setCurrent('remediate');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start remediation.';
      setRunnerError(message);
    }
  }, [selectedProjectId, startRemediation]);

  const onContinueRound = useCallback(async () => {
    if (!selectedProjectId) return;
    continueRemediationRound(selectedProjectId);
  }, [continueRemediationRound, selectedProjectId]);

  const onUseCurrentFixes = useCallback(async () => {
    if (!selectedProjectId) return;
    pushCurrentRemediationChanges(selectedProjectId);
  }, [pushCurrentRemediationChanges, selectedProjectId]);

  const onApprovePush = useCallback(async () => {
    if (!selectedProjectId) return;
    approveRemediationPush(selectedProjectId);
  }, [approveRemediationPush, selectedProjectId]);

  const onConfirmMerged = useCallback(() => {
    setMergeConfirmed(true);
    setCurrent('postmerge');
  }, []);

  const onSkipPostMerge = useCallback(() => {
    setPostMergeDone(true);
    setCurrent('qa');
  }, []);
  const onContinueWithoutPr = useCallback(() => {
    setPostMergeDone(true);
    setCurrent('qa');
  }, []);

  const onRerunPostMergeScan = useCallback(async () => {
    try {
      setRerunInProgress(true);
      setRunnerError(null);
      const finalStatus = await runScanFlow(false, false);
      if (finalStatus === 'found') {
        setCurrent('remediate');
      } else {
        setPostMergeDone(true);
        setCurrent('qa');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to re-run scan.';
      setRunnerError(message);
    } finally {
      setRerunInProgress(false);
    }
  }, [runScanFlow]);

  useEffect(() => {
    if (scanStatus !== 'not_found') return;
    if (['scan', 'kg', 'remediate', 'pr', 'merge', 'postmerge'].includes(current)) {
      setPostMergeDone(true);
      setCurrent('qa');
    }
  }, [current, scanStatus]);

  const stages = useMemo((): Stage[] => {
    const base: Stage[] = STAGES.map((s) => ({ ...s, status: 'pending', duration: undefined }));
    const deploymentStages = new Set(['qa', 'arch', 'approve', 'iac', 'gitops', 'deploy']);
    const deploymentFlowStarted = deploymentStages.has(current)
      || Boolean(costEstimate.totalMonthlyUsd)
      || deployRuntimeState !== 'idle'
      || deploySucceeded;

    const preflight = base.find((s) => s.key === 'preflight');
    const scanInitiated = scanStatus !== 'not_initiated'
      || scanRuntimeState !== 'idle'
      || runnerState === 'running';
    if (preflight) {
      const downCount = healthChecks.filter((c) => c.state === 'down').length;
      if (scanInitiated) {
        preflight.status = 'success';
        preflight.duration = downCount > 0 ? `operator override (${downCount} offline)` : 'all connected';
      } else {
        preflight.status = downCount > 0 ? 'active' : 'success';
        preflight.duration = downCount > 0 ? `${downCount} offline` : 'all connected';
      }
    }

    const scan = base.find((s) => s.key === 'scan');
    if (scan) {
      // Source-of-truth for terminal state is backend scan status.
      if (scanStatus === 'found') {
        scan.status = 'success';
        scan.duration = 'completed';
      } else if (scanStatus === 'not_found') {
        scan.status = 'success';
        scan.duration = 'no findings';
      } else if (scanStatus === 'error') {
        scan.status = 'active';
        scan.duration = 'failed';
      } else if (scanRuntimeState === 'running' || runnerState === 'running') {
        scan.status = 'running';
        scan.duration = 'running';
      } else if (scanRuntimeState === 'completed') {
        scan.status = 'success';
        scan.duration = 'completed';
      } else if (scanRuntimeState === 'error') {
        scan.status = 'active';
        scan.duration = 'failed';
      }
    }

    const kg = base.find((s) => s.key === 'kg');
    const hasKgEvent = remediation.messages.some((m) => m.type === 'kg_result');
    if (kg) {
      if (!scanInitiated) {
        kg.status = 'pending';
      } else if (kgPhase === 'running') {
        kg.status = 'running';
        kg.duration = 'analyzing';
      } else if (kgPhase === 'completed') {
        kg.status = 'success';
        kg.duration = 'enriched';
      } else if (kgPhase === 'skipped') {
        kg.status = 'success';
        kg.duration = 'skipped (neo4j offline)';
      } else if (hasKgEvent) {
        kg.status = 'success';
        kg.duration = 'enriched';
      } else if (!neo4jConnected && remediation.state !== 'idle') {
        kg.status = 'success';
        kg.duration = 'skipped (neo4j offline)';
      } else if (remediation.state === 'running') {
        kg.status = 'running';
        kg.duration = 'analyzing';
      }
    }

    const remediate = base.find((s) => s.key === 'remediate');
    if (remediate) {
      if (!scanInitiated) {
        remediate.status = 'pending';
      } else if (scanStatus === 'not_found') {
        remediate.status = 'success';
        remediate.duration = 'skipped (no findings)';
      } else {
        if (remediation.state === 'running') remediate.status = 'running';
        if (remediation.state === 'waiting_decision' || remediation.state === 'waiting_approval') remediate.status = 'active';
        if (remediation.state === 'completed') remediate.status = 'success';
        if (remediation.state === 'error') remediate.status = 'active';
      }
    }

    const pr = base.find((s) => s.key === 'pr');
    if (pr) {
      if (!scanInitiated) {
        pr.status = 'pending';
      } else if (scanStatus === 'not_found') {
        pr.status = 'success';
        pr.duration = 'skipped (no findings)';
      } else if (prUrl) pr.status = 'success';
      else if (noRemediationChanges) {
        pr.status = 'success';
        pr.duration = 'skipped (no changes)';
      } else if (remediation.state === 'waiting_decision' || remediation.state === 'waiting_approval') pr.status = 'active';
    }

    const merge = base.find((s) => s.key === 'merge');
    if (merge) {
      if (!scanInitiated) {
        merge.status = 'pending';
      } else if (scanStatus === 'not_found') {
        merge.status = 'success';
        merge.duration = 'skipped (no findings)';
      } else if (mergeConfirmed) merge.status = 'success';
      else if (noRemediationChanges) {
        merge.status = 'success';
        merge.duration = 'skipped (no PR)';
      } else if (prUrl) merge.status = 'active';
    }

    const postmerge = base.find((s) => s.key === 'postmerge');
    if (postmerge) {
      if (!scanInitiated) {
        postmerge.status = 'pending';
      } else if (scanStatus === 'not_found') {
        postmerge.status = 'success';
        postmerge.duration = 'skipped (no findings)';
      } else if (postMergeDone) postmerge.status = 'success';
      else if (mergeConfirmed || noRemediationChanges) postmerge.status = 'active';
    }

    const qa = base.find((s) => s.key === 'qa');
    if (qa && (postMergeDone || deploymentFlowStarted)) {
      if (current === 'qa') qa.status = 'active';
      else if (deploymentStages.has(current)) qa.status = 'success';
      else qa.status = 'pending';
    }

    const arch = base.find((s) => s.key === 'arch');
    if (arch) {
      if (current === 'arch') arch.status = 'active';
      else if (['approve', 'iac', 'gitops', 'deploy'].includes(current)) arch.status = 'success';
    }

    const approve = base.find((s) => s.key === 'approve');
    if (approve) {
      if (current === 'approve') approve.status = 'active';
      else if (['iac', 'gitops', 'deploy'].includes(current)) approve.status = 'success';
    }

    const iac = base.find((s) => s.key === 'iac');
    if (iac) {
      if (current === 'iac') iac.status = 'active';
      else if (['gitops', 'deploy'].includes(current)) iac.status = 'success';
    }

    const gitops = base.find((s) => s.key === 'gitops');
    if (gitops) {
      if (current === 'gitops') gitops.status = 'active';
      else if (current === 'deploy') gitops.status = 'success';
    }

    const deploy = base.find((s) => s.key === 'deploy');
    if (deploy) {
      if (deploySucceeded) {
        deploy.status = 'success';
        deploy.duration = 'completed';
      } else if (deployRuntimeState === 'running') {
        deploy.status = 'running';
        deploy.duration = 'running';
      } else if (current === 'deploy') {
        deploy.status = 'active';
      }
    }

    return base;
  }, [costEstimate.totalMonthlyUsd, current, deployRuntimeState, deploySucceeded, healthChecks, kgPhase, mergeConfirmed, neo4jConnected, noRemediationChanges, postMergeDone, prUrl, remediation.messages, remediation.state, scanRuntimeState, runnerState, scanStatus]);

  useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadProjects();
    }, 0);
    return () => window.clearTimeout(timerId);
  }, [loadProjects]);

  useEffect(() => {
    setCostEstimate(readSavedCostEstimate());
  }, []);

  useEffect(() => {
    const timerId = window.setTimeout(() => {
      void refreshRuntime();
    }, 0);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [refreshRuntime]);

  const renderPage = () => {
    switch (current) {
      case 'overview':
        return (
          <OverviewPage
            setCurrent={setCurrent}
            stages={stages}
            projectLabel={selectedProject?.name || 'No project selected'}
            monthlyCostUsd={costEstimate.totalMonthlyUsd}
            budgetCapUsd={costEstimate.budgetCapUsd}
            scanStatus={scanStatus}
            scanResults={scanResults}
            healthOverall={healthOverall}
            runtimeMessages={runtimeMessages}
            scanRuntimeState={scanState.state}
            remediationRuntimeState={remediation.state}
          />
        );
      case 'preflight':
        return <PreflightPage checks={healthChecks} />;
      case 'scan':
      case 'kg':
        return <ScanPage scanStatus={scanStatus} scanResults={scanResults} />;
      case 'remediate':
      case 'pr':
        return (
          <RemediationPage
            state={remediation.state}
            scanStatus={scanStatus}
            messages={remediation.messages}
            changedFiles={changedFiles}
            prUrl={prUrl}
            noChangesDetected={noRemediationChanges}
            onStart={onStartRemediation}
            onContinueRound={onContinueRound}
            onUseCurrentFixes={onUseCurrentFixes}
            onApprovePush={onApprovePush}
            onContinueWithoutPr={onContinueWithoutPr}
            onNavigate={setCurrent}
          />
        );
      case 'merge':
        return <MergeGatePage prUrl={prUrl} merged={mergeConfirmed} onConfirmMerged={onConfirmMerged} onNavigate={setCurrent} />;
      case 'postmerge':
        return <PostMergePage onSkip={onSkipPostMerge} onRerunScan={onRerunPostMergeScan} rerunInProgress={rerunInProgress} />;
      case 'qa':
        return <QAPage onNavigate={setCurrent} autopilot={normalizedRunOptions.autopilot} projectId={selectedProjectId} projectName={selectedProject?.name} />;
      case 'arch':
      case 'approve':
        return <ArchPage onNavigate={setCurrent} projectId={selectedProjectId} projectName={selectedProject?.name} />;
      case 'iac':
        return <IaCPage onNavigate={setCurrent} projectId={selectedProjectId} projectName={selectedProject?.name} />;
      case 'gitops':
        return <GitOpsPage onNavigate={setCurrent} projectId={selectedProjectId} scanStatus={scanStatus} />;
      case 'deploy':
        return null;
      default:
        return (
          <OverviewPage
            setCurrent={setCurrent}
            stages={stages}
            projectLabel={selectedProject?.name || 'No project selected'}
            monthlyCostUsd={costEstimate.totalMonthlyUsd}
            budgetCapUsd={costEstimate.budgetCapUsd}
            scanStatus={scanStatus}
            scanResults={scanResults}
            healthOverall={healthOverall}
            runtimeMessages={runtimeMessages}
            scanRuntimeState={scanState.state}
            remediationRuntimeState={remediation.state}
          />
        );
    }
  };

  const runLabel = runnerState === 'running' ? 'Running Scan...' : 'Run Scan';
  const deployPage = (
    <DeployPage
      projectId={selectedProjectId}
      onDeploymentStateChange={(state) => {
        setDeployRuntimeState(state);
        setDeploySucceeded(state === 'done');
      }}
    />
  );

  return (
    <div className="flex h-screen bg-[#09090b] text-zinc-300 overflow-hidden relative font-sans">
      <GlobalStyles />
      {showOptions && (
        <RunOptionsModal
          onClose={() => setShowOptions(false)}
          options={normalizedRunOptions}
          onChange={(next) => {
            const safeNext: PipelineRunOptions = {
              autopilot: Boolean(next.autopilot),
              skipScan: Boolean(next.skipScan),
              skipRemediation: Boolean(next.skipScan || next.skipRemediation),
            };
            setRunOptions(safeNext);
          }}
        />
      )}
      <Sidebar
        current={current}
        setCurrent={setCurrent}
        stages={stages}
        githubAccounts={githubAccounts}
        onDisconnectGitHub={onDisconnectGitHub}
        onBackToDashboard={() => router.push('/dashboard')}
      />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0 bg-[#09090b]">
        <div className="h-11 bg-[#09090b]/80 border-b border-white/5 flex items-center px-5 gap-3 shrink-0 backdrop-blur">
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-600">
            <span className="text-zinc-500 hover:text-zinc-300 cursor-pointer" onClick={() => router.push('/dashboard')}>Dashboard</span>
            <span>/</span>
            <span className="text-zinc-300 capitalize">{current === 'overview' ? 'Pipeline' : stages.find((s) => s.key === current)?.label || current}</span>
            {runnerError && <span className="text-[11px] text-red-400 ml-3">{runnerError}</span>}
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <button
              onClick={() => router.push('/dashboard')}
              className="flex items-center gap-1.5 px-3 py-1 bg-zinc-900 hover:bg-zinc-800 border border-white/10 rounded-md text-[11px] font-medium text-zinc-300 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              Dashboard
            </button>
            <ProjectSelector projects={projects} selectedProjectId={selectedProjectId} onSelect={setSelectedProjectId} />
            <button onClick={() => setShowOptions(true)} className="flex items-center gap-1.5 px-3 py-1 bg-zinc-900 hover:bg-zinc-800 border border-white/10 rounded-md text-[11px] font-medium text-zinc-300 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
              Options
            </button>
            <button
              onClick={() => { void runInitialScan(); }}
              disabled={runnerState === 'running' || !selectedProject}
              className="flex items-center gap-1.5 px-3 py-1 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-950 font-semibold rounded-md text-[11px] transition-colors shadow-sm shadow-emerald-500/20"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              {runLabel}
            </button>
            <button
              onClick={onLogout}
              className="flex items-center gap-1.5 px-3 py-1 bg-zinc-900 hover:bg-zinc-800 border border-white/10 rounded-md text-[11px] font-medium text-zinc-300 transition-colors"
            >
              Logout
            </button>
          </div>
        </div>
        <div className="flex-1 flex flex-col overflow-hidden">
          {current === 'deploy' ? deployPage : renderPage()}
          {current !== 'deploy' && deployRuntimeState === 'running' && (
            <div className="hidden" aria-hidden>
              {deployPage}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
