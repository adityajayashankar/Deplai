'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Search } from 'lucide-react';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import { appBtnPaper, appInput } from '@/features/workspace/theme';
import {
  SESSION_SERVICES,
  SESSION_STATUSES,
  serviceLabel,
  statusLabel,
  type SessionService,
  type SessionStatus,
  type WorkspaceSession,
} from '@/lib/sessions/types';

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const delta = Math.max(0, Date.now() - then);
  const sec = Math.floor(delta / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function truncateSessionId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 12)}…${id.slice(-4)}`;
}

function statusClass(status: SessionStatus): string {
  if (status === 'running') return 'bg-black text-white';
  if (status === 'failed') return 'bg-white text-black';
  if (status === 'needs_review') return 'bg-neutral-100 text-black';
  return 'bg-white text-black';
}

export default function SessionsApp() {
  const router = useRouter();
  const [sessions, setSessions] = useState<WorkspaceSession[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [service, setService] = useState<SessionService | ''>('');
  const [status, setStatus] = useState<SessionStatus | ''>('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (service) params.set('service', service);
    if (status) params.set('status', status);
    params.set('limit', '20');
    params.set('offset', '0');
    return params.toString();
  }, [debouncedSearch, service, status]);

  const load = useCallback(async (offset = 0, append = false) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    setNotice('');
    try {
      const params = new URLSearchParams(queryString);
      params.set('offset', String(offset));
      const response = await fetch(`/api/sessions?${params.toString()}`, { cache: 'no-store' }).catch(() => null);
      if (!response?.ok) {
        setNotice('Could not load sessions.');
        if (!append) setSessions([]);
        return;
      }
      const payload = await response.json() as {
        sessions?: WorkspaceSession[];
        total?: number;
      };
      const rows = Array.isArray(payload.sessions) ? payload.sessions : [];
      setTotal(Number(payload.total || 0));
      setSessions((prev) => (append ? [...prev, ...rows] : rows));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [queryString]);

  useEffect(() => {
    void load(0, false);
  }, [load]);

  const copyId = async (event: React.MouseEvent, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500);
    } catch {
      setNotice('Could not copy session ID.');
    }
  };

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent font-sans">
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <WorkspaceCommandHeader section="Sessions" onExit={() => router.push('/')} />
        <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
          <div className="mx-auto max-w-5xl">
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Workspace</p>
            <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-black">Sessions</h2>
            <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-zinc-500">
              Every Security Agent, UI/UX, Deploy, and Code Reviewer run lands here — searchable after the live socket is gone.
            </p>

            {notice ? (
              <p className="mt-6 border-[3px] border-black bg-white px-4 py-3 text-[13px] text-black">{notice}</p>
            ) : null}

            <div className="mt-8 grid gap-3 md:grid-cols-[1fr_180px_160px]">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search title or session ID"
                  className={`${appInput} pl-9`}
                />
              </label>
              <select
                value={service}
                onChange={(event) => setService(event.target.value as SessionService | '')}
                className={appInput}
                aria-label="Filter by service"
              >
                <option value="">All services</option>
                {SESSION_SERVICES.map((item) => (
                  <option key={item} value={item}>{serviceLabel(item)}</option>
                ))}
              </select>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as SessionStatus | '')}
                className={appInput}
                aria-label="Filter by status"
              >
                <option value="">All statuses</option>
                {SESSION_STATUSES.map((item) => (
                  <option key={item} value={item}>{statusLabel(item)}</option>
                ))}
              </select>
            </div>

            <div className="mt-6 space-y-3">
              {loading ? (
                Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="app-paper h-24 animate-pulse bg-white" />
                ))
              ) : sessions.length === 0 ? (
                <div className="app-paper px-6 py-12 text-center">
                  <p className="font-display text-lg text-black">No sessions yet</p>
                  <p className="mt-2 text-[13px] text-neutral-500">
                    Runs from Security Agent, UI/UX customizer, Deploy, and Code Reviewer will appear here.
                  </p>
                </div>
              ) : (
                sessions.map((session) => (
                  <div
                    key={session.id}
                    onClick={() => router.push(`/dashboard/sessions/${encodeURIComponent(session.id)}`)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        router.push(`/dashboard/sessions/${encodeURIComponent(session.id)}`);
                      }
                    }}
                    role="link"
                    tabIndex={0}
                    className="app-paper flex w-full cursor-pointer flex-col gap-3 p-5 text-left transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-[4px_4px_0_0_#000]"
                  >
                    <div className="flex w-full flex-wrap items-start justify-between gap-3 text-left">
                      <div className="min-w-0">
                        <h3 className="truncate font-display text-lg text-black">{session.title}</h3>
                        <p className="mt-1 truncate text-[13px] text-neutral-600">
                          {session.repo || 'No repository'}
                        </p>
                      </div>
                      <span className={`border-[2px] border-black px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${statusClass(session.status)}`}>
                        {statusLabel(session.status)}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-[12px] text-neutral-600">
                      <span className="border-[2px] border-black bg-white px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-black">
                        {serviceLabel(session.service)}
                      </span>
                      <span>{formatRelativeTime(session.started_at)}</span>
                      <span className="inline-flex items-center gap-1 font-mono text-[11px] text-black">
                        {truncateSessionId(session.id)}
                        <button
                          type="button"
                          title="Copy session ID"
                          onClick={(event) => void copyId(event, session.id)}
                          className="inline-flex h-5 w-5 items-center justify-center border-[2px] border-black bg-white"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                        {copiedId === session.id ? <span className="text-neutral-500">copied</span> : null}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>

            {!loading && sessions.length < total ? (
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void load(sessions.length, true)}
                className={`${appBtnPaper} mt-6`}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}
