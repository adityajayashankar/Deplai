'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Copy, TerminalSquare } from 'lucide-react';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import {
  SECURITY_STAGE_INDEX,
  SecurityStageRail,
  type SecurityPipelineStageId,
} from '@/features/workspace/SecurityStageRail';
import { LogConsole, type LogLine } from '@/features/deployment/deployment-ui';
import { appBtnPaper } from '@/features/workspace/theme';
import {
  serviceLabel,
  statusLabel,
  type SessionStatus,
  type WorkspaceSession,
  type WorkspaceSessionLog,
} from '@/lib/sessions/types';

const DEPLOY_STAGES = [
  { id: 'queued', label: 'Queued' },
  { id: 'terraform_generation', label: 'Generate' },
  { id: 'apply', label: 'Apply' },
  { id: 'completed', label: 'Done' },
] as const;

const UIUX_STAGES = [
  { id: 'queued', label: 'Queued' },
  { id: 'running', label: 'Running' },
  { id: 'review', label: 'Review' },
  { id: 'completed', label: 'Done' },
] as const;

const GENERIC_STAGES = [
  { id: 'queued', label: 'Queued' },
  { id: 'running', label: 'Running' },
  { id: 'completed', label: 'Done' },
] as const;

function toneForLevel(level: string): LogLine['tone'] {
  if (level === 'error') return 'danger';
  if (level === 'warn') return 'warn';
  return 'info';
}

function isLiveStatus(status: SessionStatus): boolean {
  return status === 'running' || status === 'queued';
}

function truncateSessionId(id: string): string {
  if (id.length <= 22) return id;
  return `${id.slice(0, 14)}…${id.slice(-6)}`;
}

export default function SessionDetailApp() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const sessionId = decodeURIComponent(String(params?.id || ''));
  const [session, setSession] = useState<WorkspaceSession | null>(null);
  const [logs, setLogs] = useState<WorkspaceSessionLog[]>([]);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId) return;
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: 'no-store' }).catch(() => null);
    if (!response?.ok) {
      setNotice(response?.status === 404 ? 'Session not found.' : 'Could not load session.');
      setSession(null);
      setLogs([]);
      return;
    }
    const payload = await response.json() as {
      session?: WorkspaceSession;
      logs?: WorkspaceSessionLog[];
    };
    setSession(payload.session || null);
    setLogs(Array.isArray(payload.logs) ? payload.logs : []);
    setNotice('');
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const live = Boolean(session && isLiveStatus(session.status));

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      void load();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  const logLines = useMemo<LogLine[]>(
    () => logs.map((line) => ({ text: line.message, tone: toneForLevel(line.level) })),
    [logs],
  );

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setNotice('Could not copy session ID.');
    }
  };

  const securityStage = (session?.current_stage && session.current_stage in SECURITY_STAGE_INDEX
    ? session.current_stage
    : 'scan') as SecurityPipelineStageId;

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent font-sans">
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <WorkspaceCommandHeader section="Sessions" onExit={() => router.push('/')} />
        {session?.service === 'security_agent' ? (
          <SecurityStageRail
            activeStage={securityStage}
            maxUnlockedIndex={SECURITY_STAGE_INDEX[securityStage]}
            onSelectStage={() => undefined}
          />
        ) : null}
        <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
          <div className="mx-auto max-w-5xl">
            <button
              type="button"
              onClick={() => router.push('/dashboard/sessions')}
              className="inline-flex items-center gap-2 text-[13px] font-bold text-black"
            >
              <ArrowLeft className="h-4 w-4" />
              All sessions
            </button>

            {loading ? (
              <div className="mt-6 app-paper h-40 animate-pulse" />
            ) : !session ? (
              <div className="mt-6 app-paper px-6 py-12">
                <p className="font-display text-lg text-black">{notice || 'Session not found.'}</p>
              </div>
            ) : (
              <>
                <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">
                      {serviceLabel(session.service)}
                    </p>
                    <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-black">{session.title}</h2>
                    <p className="mt-2 text-[13px] text-neutral-600">{session.repo || 'No repository'}</p>
                  </div>
                  <span className="border-[2px] border-black bg-white px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-black">
                    {statusLabel(session.status)}
                  </span>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-[12px] text-black">
                  <span>{truncateSessionId(session.id)}</span>
                  <button type="button" onClick={() => void copyId()} className="inline-flex items-center gap-1 border-[2px] border-black bg-white px-2 py-0.5 text-[11px] font-bold">
                    <Copy className="h-3 w-3" />
                    {copied ? 'Copied' : 'Copy ID'}
                  </button>
                  {session.changed_files_count > 0 ? (
                    <span className="text-neutral-600">{session.changed_files_count} changed files</span>
                  ) : null}
                </div>

                {session.service !== 'security_agent' ? (
                  <ReadOnlyStepper
                    stages={session.service === 'deploy' ? DEPLOY_STAGES : session.service === 'uiux_customizer' ? UIUX_STAGES : GENERIC_STAGES}
                    current={session.current_stage || (session.status === 'completed' ? 'completed' : 'running')}
                  />
                ) : null}

                {notice ? (
                  <p className="mt-6 border-[3px] border-black bg-white px-4 py-3 text-[13px] text-black">{notice}</p>
                ) : null}

                <div className="deployment-workspace mt-8">
                  <div className="app-paper overflow-hidden">
                    <div className="flex items-center justify-between border-b-[3px] border-black px-5 py-4">
                      <div className="flex items-center gap-2">
                        <TerminalSquare className="h-4 w-4 text-black" />
                        <h3 className="text-sm font-semibold text-black">Agent execution log</h3>
                      </div>
                      {live ? (
                        <span className="relative flex h-2 w-2">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-black opacity-75" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-black" />
                        </span>
                      ) : null}
                    </div>
                    <LogConsole
                      lines={logLines}
                      streaming={live}
                      emptyLabel="No log lines persisted for this session."
                      maxHeight="28rem"
                    />
                  </div>
                </div>

                {session.project_id && session.service === 'security_agent' ? (
                  <button
                    type="button"
                    onClick={() => router.push(`/dashboard/security-analysis/${encodeURIComponent(session.project_id || '')}`)}
                    className={`${appBtnPaper} mt-6`}
                  >
                    Open Security Agent
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function ReadOnlyStepper({
  stages,
  current,
}: {
  stages: ReadonlyArray<{ id: string; label: string }>;
  current: string;
}) {
  const activeIndex = Math.max(0, stages.findIndex((stage) => stage.id === current));
  return (
    <ol className="mt-6 flex items-stretch border-[3px] border-black bg-white px-4 py-3">
      {stages.map((stage, index) => {
        const complete = index < activeIndex;
        const active = index === activeIndex;
        return (
          <li key={stage.id} className="flex min-w-0 flex-1 items-center">
            <div className={`flex min-w-0 items-center gap-2 border-b-[3px] py-1 pr-3 ${active ? 'border-black' : 'border-transparent'}`}>
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center border-[2px] border-black font-mono text-[10px] ${complete || active ? 'bg-black text-white' : 'bg-white text-neutral-500'}`}>
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className={`hidden truncate text-[12px] md:inline ${active ? 'font-bold text-black' : 'text-neutral-600'}`}>
                {stage.label}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
