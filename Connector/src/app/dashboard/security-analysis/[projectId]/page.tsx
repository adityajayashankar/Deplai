'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import MonitorPopup from '@/components/monitor-popup';
import RemediationRequest from '@/components/remediationrequest';
import Findings from '../findings';
import { useScan } from '@/lib/scan-context';

interface ScanStats {
  total: number;
  critical: number;
  high: number;
  autoFixable: number;
}

interface UserInfo {
  name: string;
  login: string;
  avatarUrl: string;
}

interface ProjectScanMeta {
  type: 'local' | 'github';
  installationId?: string;
  owner?: string;
  repo?: string;
}

export default function SecurityAnalysisPage() {
  const router = useRouter();
  const params = useParams();
  const projectId = params.projectId as string;

  const { resetAll, getScanState, startScan, startRemediation, approveRemediationRescan, getRemediationState, resetRemediation, isAnyRemediating } = useScan();
  const { state: scanState } = getScanState(projectId);
  const { state: remediationState } = getRemediationState(projectId);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [remediationOpen, setRemediationOpen] = useState(false);
  const [findingsReady, setFindingsReady] = useState(false);
  const [projectType, setProjectType] = useState<'local' | 'github' | null>(null);
  const [projectName, setProjectName] = useState<string>('');
  const [scanStats, setScanStats] = useState<ScanStats | null>(null);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [scanCompletedAt, setScanCompletedAt] = useState<string>('');
  const [scanMeta, setScanMeta] = useState<ProjectScanMeta | null>(null);
  const [rerunInProgress, setRerunInProgress] = useState(false);

  const remediating = remediationState === 'running';
  const remediationAwaitingApproval = remediationState === 'waiting_approval';
  const remediationDone = remediationState === 'completed';

  useEffect(() => {
    if (scanState === 'running') {
      setFindingsReady(false);
      setScanStats(null);
    }
  }, [scanState]);

  useEffect(() => {
    let cancelled = false;
    async function fetchProject() {
      try {
        const res = await fetch(`/api/projects/${projectId}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const project = data?.project;
        if (!cancelled && project) {
          const type = project.type;
          if (type === 'local' || type === 'github') {
            setProjectType(type);
            setScanMeta({
              type,
              installationId: project.installationId,
              owner: project.owner,
              repo: project.repo,
            });
          }
          setProjectName(project.name || project.full_name || project.id || projectId);
        }
      } catch {
        setProjectName(projectId);
      }
    }
    async function fetchUser() {
      try {
        const res = await fetch('/api/auth/session');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled && data?.user) {
          setUser({ name: data.user.name || data.user.login, login: data.user.login, avatarUrl: data.user.avatarUrl });
        }
      } catch { /* ignore */ }
    }
    fetchProject();
    fetchUser();
    return () => { cancelled = true; };
  }, [projectId]);

  async function handleLogout() {
    resetAll();
    localStorage.removeItem('theme');
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/');
  }

  const handleFindingsReady = useCallback((ready: boolean) => {
    setFindingsReady(ready);
    if (ready) setScanCompletedAt(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
  }, []);

  const handleStatsReady = useCallback((stats: ScanStats) => {
    setScanStats(stats);
  }, []);

  async function handleStartRemediation(githubToken?: string, llmProvider?: string, llmApiKey?: string, llmModel?: string) {
    await startRemediation(projectId, undefined, githubToken, llmProvider, llmApiKey, llmModel);
  }

  async function handleRerunScan() {
    if (rerunInProgress || scanState === 'running' || !scanMeta) return;

    setRerunInProgress(true);
    try {
      const validateRes = await fetch('/api/scan/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          project_name: projectName || projectId,
          project_type: scanMeta.type,
          installation_id: scanMeta.installationId,
          owner: scanMeta.owner,
          repo: scanMeta.repo,
          scan_type: 'all',
        }),
      });

      if (!validateRes.ok) {
        throw new Error('Failed to validate re-scan');
      }

      await startScan(projectId, projectName || projectId);
      resetRemediation(projectId);
    } catch (err) {
      console.error('Re-run scan failed', err);
    } finally {
      setRerunInProgress(false);
    }
  }

  const showRemediateButton = findingsReady && scanState !== 'running' && !remediating && !remediationAwaitingApproval && !remediationDone && !isAnyRemediating;

  const kpis = [
    { label: 'Total Issues', value: scanStats ? scanStats.total : '—', color: 'text-white' },
    { label: 'Critical', value: scanStats ? scanStats.critical : '—', color: 'text-red-400' },
    { label: 'High Severity', value: scanStats ? scanStats.high : '—', color: 'text-orange-400' },
    { label: 'Auto-Fixable', value: scanStats ? scanStats.autoFixable : '—', color: 'text-emerald-400' },
  ];

  return (
    <div className="min-h-screen bg-[#09090B] text-white overflow-x-hidden">
      {/* Background glow blobs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] left-[20%] w-125 h-100 bg-indigo-600/10 rounded-full blur-3xl" />
        <div className="absolute bottom-[10%] right-[10%] w-100 h-75 bg-violet-600/8 rounded-full blur-3xl" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-white/8 bg-[#09090B]/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
          {/* Left: back + logo + breadcrumb */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/dashboard')}
              className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/8 transition"
              title="Back to dashboard"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>

            {/* DeplAI hexagon logo */}
            <div className="relative w-7 h-7 flex items-center justify-center">
              <svg viewBox="0 0 28 28" className="w-7 h-7" fill="none">
                <polygon points="14,2 25,8 25,20 14,26 3,20 3,8" fill="none" stroke="url(#hg)" strokeWidth="1.5" />
                <defs>
                  <linearGradient id="hg" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#818cf8" />
                    <stop offset="100%" stopColor="#a78bfa" />
                  </linearGradient>
                </defs>
                <circle cx="14" cy="14" r="3" fill="url(#hg)" className="animate-pulse" />
              </svg>
            </div>

            <span className="text-white/30 text-sm font-light">/</span>
            <span className="text-white/50 text-sm">DeplAI</span>
            <span className="text-white/30 text-sm font-light">/</span>
            <span className="text-white text-sm font-medium truncate max-w-48">{projectName || projectId}</span>
          </div>

          {/* Right: user pill + logout */}
          {user && (
            <div className="flex items-center gap-1.5">
              <a
                href="https://github.com/apps/deplai-gitapp-aj"
                target="_blank"
                rel="noopener noreferrer"
                title="Manage GitHub App — add/remove repos, configure or uninstall"
                className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-full pl-1 pr-3 py-1 hover:bg-white/10 hover:border-white/20 transition-colors"
              >
                {user.avatarUrl ? (
                  <img src={user.avatarUrl} alt={user.name} className="w-6 h-6 rounded-full ring-1 ring-white/20" />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-indigo-500/40 flex items-center justify-center text-xs font-bold text-indigo-300">
                    {(user.name || user.login)[0].toUpperCase()}
                  </div>
                )}
                <span className="text-white/70 text-xs font-medium">{user.name || user.login}</span>
                <svg className="w-3 h-3 text-white/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
              <button
                onClick={handleLogout}
                title="Logout"
                className="p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="relative max-w-7xl mx-auto px-6 py-10 space-y-8">
        {/* Report header */}
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-6">
          <div>
            {findingsReady && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-indigo-500/15 text-indigo-300 border border-indigo-500/25 rounded-full px-3 py-1 mb-3">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                Scan Complete
                {scanCompletedAt && <span className="ml-1 text-indigo-400/70">· {scanCompletedAt}</span>}
              </span>
            )}
            <h1 className="text-3xl font-bold text-white tracking-tight">Vulnerability Report</h1>
            <p className="text-white/40 text-sm mt-1.5 max-w-lg">
              Automated security analysis for <span className="text-white/60 font-medium">{projectName || projectId}</span>. Review findings below and apply AI-assisted remediation.
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {remediationDone && scanState !== 'running' && (
              <button
                onClick={handleRerunScan}
                disabled={rerunInProgress || !scanMeta}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-emerald-500/35 bg-emerald-500/10 text-emerald-300 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed hover:bg-emerald-500/15"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m14.836 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-14.837-2m14.837 2H15" />
                </svg>
                {rerunInProgress ? 'Re-running...' : 'Re-run Scan'}
              </button>
            )}

            {/* Terminal button */}
            <button
              onClick={() => setTerminalOpen(prev => !prev)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition ${
                terminalOpen
                  ? 'bg-white/10 border-white/20 text-white'
                  : 'bg-transparent border-white/15 text-white/60 hover:text-white hover:border-white/30 hover:bg-white/5'
              }`}
            >
              <svg className="w-4 h-4" viewBox="0 0 25 24" fill="none">
                <path d="M15.0582 4.16286C15.1481 3.75851 14.8931 3.35788 14.4888 3.26802C14.0844 3.17816 13.6838 3.43311 13.5939 3.83746L10.0384 19.8374C9.94851 20.2418 10.2035 20.6424 10.6078 20.7323C11.0122 20.8221 11.4128 20.5672 11.5026 20.1628L15.0582 4.16286Z" fill="currentColor"/>
                <path d="M7.82913 7.46956C8.12204 7.76244 8.12206 8.23732 7.82918 8.53022L4.35946 12.0003L7.82916 15.47C8.12205 15.7628 8.12205 16.2377 7.82916 16.5306C7.53627 16.8235 7.06139 16.8235 6.7685 16.5306L2.7685 12.5306C2.47561 12.2377 2.4756 11.7629 2.76847 11.47L6.76847 7.46961C7.06135 7.1767 7.53623 7.17668 7.82913 7.46956Z" fill="currentColor"/>
                <path d="M17.2685 7.46956C16.9756 7.76244 16.9756 8.23732 17.2685 8.53022L20.7382 12.0003L17.2685 15.47C16.9756 15.7628 16.9756 16.2377 17.2685 16.5306C17.5614 16.8235 18.0363 16.8235 18.3292 16.5306L22.3292 12.5306C22.622 12.2377 22.6221 11.7629 22.3292 11.47L18.3292 7.46961C18.0363 7.1767 17.5614 7.17668 17.2685 7.46956Z" fill="currentColor"/>
              </svg>
              Terminal
            </button>

            {/* Auto-Remediate button */}
            {showRemediateButton && (
              <button
                onClick={() => setRemediationOpen(true)}
                className="relative flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-sm font-medium text-white overflow-hidden group transition hover:bg-white/10 hover:border-white/20"
              >
                {/* shimmer */}
                <span className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 bg-linear-to-r from-transparent via-white/8 to-transparent" />
                <svg className="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                Auto-Remediate with AI
              </button>
            )}
          </div>
        </div>

        {/* KPI stats grid (only when findings are ready) */}
        {findingsReady && scanStats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {kpis.map((kpi) => (
              <div key={kpi.label} className="bg-white/3 border border-white/8 rounded-2xl p-5">
                <p className="text-white/40 text-xs font-medium uppercase tracking-wider mb-2">{kpi.label}</p>
                <p className={`text-3xl font-bold tabular-nums ${kpi.color}`}>{kpi.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Findings */}
        <Findings
          projectId={projectId}
          remediating={remediating}
          remediationAwaitingApproval={remediationAwaitingApproval}
          remediationDone={remediationDone}
          onApproveRescan={() => approveRemediationRescan(projectId)}
          onFindingsReady={handleFindingsReady}
          onStatsReady={handleStatsReady}
          onRerunScan={handleRerunScan}
        />
      </main>

      <RemediationRequest
        isOpen={remediationOpen}
        onClose={() => setRemediationOpen(false)}
        onContinue={handleStartRemediation}
        projectType={projectType}
      />
      <MonitorPopup projectId={projectId} isOpen={terminalOpen} onClose={() => setTerminalOpen(false)} />
    </div>
  );
}
