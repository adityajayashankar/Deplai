'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useScan, type VulnStatus, type ScanMessage } from '@/lib/scan-context';
import LoadingSpinner from '@/components/loading-spinner';
import Lottie from 'lottie-react';
import waitAnimation from '@/components/animation/wait.json';
import waitDarkAnimation from '@/components/animation/wait-dark.json';
import runAnimation from '@/components/animation/run.json';
import aiThinkAnimation from '@/components/animation/ai-think.json';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';

interface Occurrence {
  filename: string;
  line_number: number;
  code_extract: string;
  documentation_url: string;
}

interface CWEGroup {
  cwe_id: string;
  title: string;
  severity: string;
  count: number;
  occurrences: Occurrence[];
}

interface SupplyChainVuln {
  name: string;
  type: string;
  version: string;
  severity: string;
  epss_score: number | null;
  fix_version: string | null;
  cve_id: string;
}

interface ScanResults {
  supply_chain: SupplyChainVuln[];
  code_security: CWEGroup[];
}

interface ScanStats {
  total: number;
  critical: number;
  high: number;
  autoFixable: number;
}

interface FindingsProps {
  projectId?: string;
  remediating?: boolean;
  remediationAwaitingApproval?: boolean;
  remediationDone?: boolean;
  onApproveRescan?: () => void;
  onFindingsReady?: (ready: boolean) => void;
  onStatsReady?: (stats: ScanStats) => void;
  onRerunScan?: () => void;
}

/* ------------------------------------------------------------------ */
/* Severity helpers                                                  */
/* ------------------------------------------------------------------ */

const SEVERITY_CONFIG: Record<string, { text: string; bg: string; border: string; label: string }> = {
  critical: { text: 'text-red-400', bg: 'bg-red-400/10', border: 'border-red-400/20', label: 'Critical' },
  high: { text: 'text-orange-400', bg: 'bg-orange-400/10', border: 'border-orange-400/20', label: 'High' },
  medium: { text: 'text-yellow-400', bg: 'bg-yellow-400/10', border: 'border-yellow-400/20', label: 'Medium' },
  low: { text: 'text-blue-400', bg: 'bg-blue-400/10', border: 'border-blue-400/20', label: 'Low' },
};

function SeverityBadge({ severity }: { severity: string }) {
  const config = SEVERITY_CONFIG[severity.toLowerCase()] || SEVERITY_CONFIG.low;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${config.text} ${config.bg} ${config.border}`}>
      {config.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Supply Chain Table                                                */
/* ------------------------------------------------------------------ */

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function SortIcon({ direction }: { direction: 'asc' | 'desc' | false }) {
  if (!direction) {
    return (
      <svg className="w-3.5 h-3.5 ml-1 inline text-muted/40" viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
      </svg>
    );
  }
  return (
    <svg className="w-3.5 h-3.5 ml-1 inline text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={direction === 'asc' ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7'} />
    </svg>
  );
}

const supplyChainColumns: ColumnDef<SupplyChainVuln>[] = [
  {
    accessorKey: 'name',
    header: 'Package',
    cell: (info) => <span className="font-medium text-white">{info.getValue<string>()}</span>,
  },
  {
    accessorKey: 'cve_id',
    header: 'CVE',
    cell: (info) => <span className="font-mono text-xs text-white/50">{info.getValue<string>()}</span>,
  },
  {
    accessorKey: 'type',
    header: 'Type',
    cell: (info) => <span className="text-white/40 text-xs">{info.getValue<string>()}</span>,
  },
  {
    accessorKey: 'version',
    header: 'Version',
    cell: (info) => <span className="font-mono text-xs text-white/60">{info.getValue<string>()}</span>,
  },
  {
    accessorKey: 'severity',
    header: 'Severity',
    cell: (info) => <SeverityBadge severity={info.getValue<string>()} />,
    sortingFn: (rowA, rowB) => {
      const a = SEVERITY_ORDER[rowA.original.severity.toLowerCase()] ?? 4;
      const b = SEVERITY_ORDER[rowB.original.severity.toLowerCase()] ?? 4;
      return a - b;
    },
  },
  {
    accessorKey: 'epss_score',
    header: 'EPSS',
    cell: (info) => {
      const val = info.getValue<number | null>();
      return <span className="text-white/40 text-xs">{val !== null ? `${(val * 100).toFixed(1)}%` : '—'}</span>;
    },
  },
  {
    accessorKey: 'fix_version',
    header: 'Fix Available',
    meta: { align: 'right' as const },
    cell: (info) => {
      const val = info.getValue<string | null>();
      return val ? (
        <span className="inline-flex items-center gap-1.5 font-mono text-xs font-medium text-emerald-400">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {val}
        </span>
      ) : (
        <span className="text-white/20 text-xs italic">None</span>
      );
    },
  },
];

function SupplyChainTable({ vulnerabilities }: { vulnerabilities: SupplyChainVuln[] }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const columns = useMemo(() => supplyChainColumns, []);

  const table = useReactTable({
    data: vulnerabilities,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="bg-[#101012]/90 border border-white/10 rounded-2xl overflow-hidden">
      <div className="px-6 py-4 border-b border-white/8">
        <h2 className="text-sm font-semibold text-white/80">Supply Chain Vulnerabilities</h2>
        <p className="text-xs text-white/40 mt-0.5">{vulnerabilities.length} issue{vulnerabilities.length !== 1 ? 's' : ''} detected</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left whitespace-nowrap">
          <thead>
            <tr className="border-b border-white/8">
              {table.getHeaderGroups().map((headerGroup) =>
                headerGroup.headers.map((header) => {
                  const align = (header.column.columnDef.meta as { align?: string })?.align;
                  return (
                    <th
                      key={header.id}
                      className={`py-3 px-5 text-xs font-medium text-white/40 uppercase tracking-wider select-none ${
                        header.column.getCanSort() ? 'cursor-pointer hover:text-white/70 transition-colors' : ''
                      } ${align === 'right' ? 'text-right' : ''}`}
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getCanSort() && (
                        <SortIcon direction={header.column.getIsSorted()} />
                      )}
                    </th>
                  );
                })
              )}
              {/* extra th for hover action column */}
              <th className="py-3 px-5 w-0" />
            </tr>
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="group border-b border-white/5 last:border-b-0 hover:bg-white/3 transition-colors">
                {row.getVisibleCells().map((cell) => {
                  const align = (cell.column.columnDef.meta as { align?: string })?.align;
                  return (
                    <td
                      key={cell.id}
                      className={`py-3.5 px-5 ${align === 'right' ? 'text-right' : ''}`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
                {/* "Fix Issue" action — appears on row hover */}
                <td className="py-3.5 px-5 text-right">
                  <span className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1.5 text-xs font-medium text-indigo-300 bg-indigo-500/15 border border-indigo-500/25 rounded-full px-2.5 py-1 cursor-pointer hover:bg-indigo-500/25 whitespace-nowrap">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    Fix Issue
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Code Security Accordion                                           */
/* ------------------------------------------------------------------ */

function CWEAccordion({ group }: { group: CWEGroup }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`rounded-xl border border-border bg-surface overflow-hidden transition-all duration-200 ${expanded ? 'shadow-md' : 'shadow-sm'}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-5 py-3.5 text-left focus:outline-none focus:ring-2 focus:ring-border inset-0"
      >
        <div className="flex items-center gap-3 min-w-0">
          <svg
            className={`w-4 h-4 text-muted shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <SeverityBadge severity={group.severity} />
          <span className="font-semibold text-foreground text-sm truncate ml-1">
            <span className="text-muted font-normal mr-2">CWE-{group.cwe_id}</span>
            {group.title}
          </span>
        </div>
        <span className={`shrink-0 ml-3 inline-flex items-center justify-center min-w-7 px-2.5 rounded-full text-xs font-bold bg-surface-hover text-muted`}>
          {group.count}
        </span>
      </button>

      <div className={`grid transition-all duration-200 ease-in-out ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
        <div className="overflow-hidden">
          <div className="border-t border-border/50 bg-surface/50">
            {group.occurrences.map((occ, i) => (
              <div key={i} className="px-5 py-4 border-b border-border/30 last:border-b-0">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2 text-sm min-w-0 bg-surface-hover px-3 py-1.5 rounded-md border border-border/50">
                    <svg className="w-4 h-4 text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <span className="text-foreground font-mono text-xs truncate">{occ.filename}</span>
                    <span className="text-muted/70 text-xs shrink-0 font-mono">:{occ.line_number}</span>
                  </div>
                  {occ.documentation_url && (
                    <a
                      href={occ.documentation_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors shrink-0 ml-2 bg-blue-500/10 px-2 py-1 rounded"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                      Docs
                    </a>
                  )}
                </div>

                <div className="rounded-lg bg-[#0d1117] border border-gray-800 overflow-hidden flex">
                  <div className="bg-[#161b22] text-gray-500 px-3 py-3 text-xs font-mono text-right select-none border-r border-gray-800 min-w-10">
                    {occ.line_number}
                  </div>
                  <div className="p-3 overflow-x-auto w-full">
                    <pre className="text-xs font-mono text-gray-300 whitespace-pre">
                      {occ.code_extract}
                    </pre>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main Findings Component                                           */
/* ------------------------------------------------------------------ */

function computeStats(data: ScanResults): ScanStats {
  const sc = data.supply_chain;
  const cs = data.code_security;
  return {
    total: sc.length + cs.reduce((s, g) => s + g.count, 0),
    critical: sc.filter(v => v.severity.toLowerCase() === 'critical').length +
              cs.filter(g => g.severity.toLowerCase() === 'critical').reduce((s, g) => s + g.count, 0),
    high: sc.filter(v => v.severity.toLowerCase() === 'high').length +
          cs.filter(g => g.severity.toLowerCase() === 'high').reduce((s, g) => s + g.count, 0),
    autoFixable: sc.filter(v => v.fix_version !== null).length,
  };
}

export default function Findings({
  projectId,
  remediating,
  remediationAwaitingApproval,
  remediationDone,
  onApproveRescan,
  onFindingsReady,
  onStatsReady,
  onRerunScan,
}: FindingsProps) {
  const { getScanState, getCachedResults, setCachedResults, getRemediationState } = useScan();
  const { state, messages: scanMessages } = getScanState(projectId || '');
  const { state: remState, messages: remMessages } = getRemediationState(projectId || '');
  const terminalRef = useRef<HTMLDivElement>(null);
  // Tracks the in-flight cancellation token so newer fetches can cancel older ones.
  const cancelFetchRef = useRef<{ current: boolean } | null>(null);

  // Auto-scroll terminal as scan messages arrive
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [scanMessages.length]);

  const [vulnStatus, setVulnStatus] = useState<VulnStatus>('not_initiated');
  // True when the backend reports a scan is actively running but no WS connection
  // exists (e.g. after a page refresh mid-scan). Drives polling until results arrive.
  const [scanActive, setScanActive] = useState(false);
  const [results, setResults] = useState<ScanResults | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingResults, setLoadingResults] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Fetch scan status, then full results if vulnerabilities were found. */
  function fetchStatusAndResults(
    cancelled: { current: boolean },
    opts?: { onDone?: () => void; trackError?: boolean },
  ) {
    fetch(`/api/scan/status?project_id=${projectId}`, { signal: AbortSignal.timeout(15_000) })
      .then(res => res.json())
      .then(data => {
        if (cancelled.current) return;
        // Backend reports scan is actively running (e.g. page refreshed mid-scan)
        if (data.status === 'running') {
          setScanActive(true);
          setLoading(false);
          opts?.onDone?.();
          return;
        }
        setScanActive(false);
        const status: VulnStatus = data.status || 'not_initiated';
        setVulnStatus(status);

        if (status === 'not_found') {
          if (projectId) setCachedResults(projectId, { status, data: null });
          setResults(null);
          setLoadingResults(false);
          onFindingsReady?.(false);
          setLoading(false);
          opts?.onDone?.();
        } else if (status === 'found') {
          setLoadingResults(true);
          setLoading(false);
          opts?.onDone?.();
          fetch(`/api/scan/results?project_id=${projectId}`, { signal: AbortSignal.timeout(30_000) })
            .then(res => {
              if (!res.ok) return res.json().then(d => Promise.reject(d.error || 'Failed to fetch results'));
              return res.json();
            })
            .then(d => {
              if (!cancelled.current && d.data) {
                setResults(d.data);
                if (projectId) setCachedResults(projectId, { status: 'found', data: d.data });
                onFindingsReady?.(true);
                onStatsReady?.(computeStats(d.data));
              }
            })
            .catch(err => {
              if (!cancelled.current && opts?.trackError) {
                setError(typeof err === 'string' ? err : 'Failed to load scan results');
              }
            })
            .finally(() => { if (!cancelled.current) setLoadingResults(false); });
        } else {
          setLoading(false);
          opts?.onDone?.();
        }
      })
      .catch(() => {
        if (!cancelled.current) {
          setLoading(false);
          opts?.onDone?.();
        }
      });
  }

  // Phase 1: On mount, check context cache first; only fetch if not cached
  useEffect(() => {
    if (!projectId) {
      setLoading(false);
      return;
    }

    const cached = getCachedResults(projectId);
    if (cached) {
      setVulnStatus(cached.status);
      if (cached.status === 'not_found') {
        setResults(null);
        onFindingsReady?.(false);
      } else if (cached.status === 'found' && cached.data) {
        setResults(cached.data as ScanResults);
        onFindingsReady?.(true);
        onStatsReady?.(computeStats(cached.data as ScanResults));
      }
      setLoading(false);
      return;
    }

    const cancelled = { current: false };
    cancelFetchRef.current = cancelled;
    setLoading(true);
    fetchStatusAndResults(cancelled);
    return () => {
      cancelled.current = true;
      if (cancelFetchRef.current === cancelled) cancelFetchRef.current = null;
    };
  }, [projectId]);

  // When a new scan starts, immediately wipe local results so stale data can't
  // bleed through the render (the running-animation check is below loading/loadingResults).
  useEffect(() => {
    if (state !== 'running') return;
    if (cancelFetchRef.current) { cancelFetchRef.current.current = true; cancelFetchRef.current = null; }
    setResults(null);
    setVulnStatus('not_initiated');
    setError(null);
    setLoadingResults(false);
    setLoading(false);
    setScanActive(false); // WS is connected — no need for API polling
  }, [state]);

  // When the backend reports a scan running but we have no WS connection (e.g.
  // the page was refreshed mid-scan), poll the status API until results arrive.
  useEffect(() => {
    if (!scanActive || !projectId || state === 'running') return;
    const id = setInterval(() => {
      const cancelled = { current: false };
      fetchStatusAndResults(cancelled);
    }, 4000);
    return () => clearInterval(id);
  }, [scanActive, projectId, state]); // eslint-disable-line react-hooks/exhaustive-deps

  // When a live scan completes, always fetch fresh results (cache was invalidated by startScan)
  useEffect(() => {
    if (!projectId || state !== 'completed') return;

    // If results are already cached the state was already 'completed' when the
    // component mounted (user navigated here after a prior scan finished). The
    // mount effect already served the cached data, so don't re-fetch and reset.
    // We only need to re-fetch when the state just transitioned running→completed
    // because startScan() clears the cache before the scan starts.
    const cached = getCachedResults(projectId);
    if (cached) return;

    if (cancelFetchRef.current) { cancelFetchRef.current.current = true; cancelFetchRef.current = null; }
    const cancelled = { current: false };
    cancelFetchRef.current = cancelled;
    setError(null);
    setLoading(true);
    onFindingsReady?.(false);
    fetchStatusAndResults(cancelled, { trackError: true });
    return () => {
      cancelled.current = true;
      if (cancelFetchRef.current === cancelled) cancelFetchRef.current = null;
    };
  }, [projectId, state]); // eslint-disable-line react-hooks/exhaustive-deps

  // Remediation completed and backend re-scan finished — refresh findings view.
  // IMPORTANT: do NOT cancel this fetch when remediationDone flips back to false
  // (e.g. user clicks "Run New Scan"). We must always store the post-remediation
  // results so the findings table shows the updated state.
  useEffect(() => {
    if (!projectId || !remediationDone) return;

    if (cancelFetchRef.current) { cancelFetchRef.current.current = true; cancelFetchRef.current = null; }
    const cancelled = { current: false };
    cancelFetchRef.current = cancelled;
    // Immediately wipe stale pre-remediation results so the old table never
    // flashes while the post-remediation fetch is in flight.
    setResults(null);
    setVulnStatus('not_initiated');
    onFindingsReady?.(false);
    setLoading(true);
    fetchStatusAndResults(cancelled, { trackError: true });
    // No cleanup cancel — let the fetch finish regardless.
  }, [projectId, remediationDone]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Remediation awaiting explicit human approval to rerun scanners
  if (remediationAwaitingApproval) {
    // Parse the structured changed_files message sent by the backend
    const changedFilesMsg = remMessages.find(m => m.type === 'changed_files');
    const changedFiles: { path: string; reason: string }[] = (() => {
      try { return changedFilesMsg ? JSON.parse(changedFilesMsg.content) : []; }
      catch { return []; }
    })();

    return (
      <div className="h-full flex flex-col items-center justify-start overflow-y-auto px-6 py-10 min-h-100 gap-6">

        {/* Header */}
        <div className="flex flex-col items-center text-center">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h3 className="text-xl font-bold text-white tracking-tight">Review AI Changes</h3>
        </div>
        <p className="text-zinc-400 text-sm text-center mb-8 max-w-md">
          The remediation agent has applied fixes. Review the changed files below, then approve to push a PR and re-run the security scan.
        </p>
        </div>

        {/* Changed Files */}
        <div className="w-full max-w-2xl mb-8">
          {changedFiles.length > 0 ? (
            <div className="rounded-2xl border border-white/10 bg-black/30 backdrop-blur-md overflow-hidden">
              <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2">
                <svg className="w-4 h-4 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span className="text-xs font-semibold text-zinc-300 uppercase tracking-widest">
                  {changedFiles.length} file{changedFiles.length !== 1 ? 's' : ''} modified
                </span>
              </div>
              <ul className="divide-y divide-white/5 max-h-72 overflow-y-auto">
                {changedFiles.map((f, i) => (
                  <li key={i} className="px-5 py-3.5 flex items-start gap-3 hover:bg-white/5 transition">
                    <div className="mt-0.5 w-5 h-5 rounded-md bg-indigo-500/20 border border-indigo-500/20 flex items-center justify-center shrink-0">
                      <span className="text-indigo-400 font-bold text-[10px]">M</span>
                    </div>
                    <div className="min-w-0">
                      <span className="font-mono text-sm text-white block truncate">{f.path}</span>
                      {f.reason && (
                        <span className="text-zinc-400 text-xs block mt-0.5 leading-relaxed">{f.reason}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="rounded-2xl border border-white/10 bg-black/30 p-6 text-center">
              <p className="text-zinc-400 text-sm">No file change details available. Check the monitor log for the full output.</p>
            </div>
          )}
        </div>

        {/* Approve Button */}
        <button
          onClick={onApproveRescan}
          className="inline-flex items-center gap-2.5 px-7 py-3 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-semibold rounded-xl transition-all shadow-[0_0_20px_-4px_rgba(99,102,241,0.5)] hover:shadow-[0_0_30px_-4px_rgba(99,102,241,0.7)] text-sm"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Approve &amp; Push PR + Re-Scan
        </button>
        <p className="text-zinc-500 text-xs mt-3">This will create a GitHub PR with the AI fixes and trigger a new security scan.</p>
      </div>
    );
  }

  // Remediation is in progress.
  if (remediating) {
    return (
      <div className="p-8 h-full flex flex-col items-center justify-start min-h-100 overflow-y-auto gap-7 pb-16">
        <div className="flex flex-col items-center text-center pt-4">
          <Lottie animationData={aiThinkAnimation} loop className="w-36 h-36" />
          <h3 className="text-xl font-semibold text-foreground mb-1">Remediating</h3>
          <p className="text-muted text-sm max-w-sm text-center">
            AI agent is applying security fixes to your codebase.
          </p>
        </div>
      </div>
    );
  }

  // Remediation failed — surface the error so the user knows what went wrong
  if (remState === 'error') {
    const lastError = [...remMessages].reverse().find(m => m.type === 'error');
    return (
      <div className="bg-red-500/5 rounded-2xl border border-red-500/20 p-12 h-full flex flex-col items-center justify-center min-h-100">
        <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mb-4 border border-red-500/20">
          <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h3 className="text-xl font-semibold text-foreground mb-2">Remediation Failed</h3>
        {lastError && (
          <p className="text-red-400 text-sm bg-red-500/10 px-4 py-2 rounded-md mb-3 max-w-md text-center">
            {lastError.content}
          </p>
        )}
        <p className="text-muted text-xs text-center">Open the monitor (terminal icon) for the full log.</p>
      </div>
    );
  }

  // Re-scan done and no remaining findings payload to render
  // Guard: must not show this while a new scan is actively running.
  if (remediationDone && !loading && !loadingResults && !results && state !== 'running') {
    return (
      <div className="p-12 h-full flex flex-col items-center justify-center min-h-100">
        <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mb-4 border border-emerald-500/20">
          <svg className="w-8 h-8 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h3 className="text-xl font-semibold text-foreground mb-2">Remediation Complete</h3>
        <p className="text-muted text-sm max-w-sm text-center mb-6">
          PR created and post-approval re-scan completed.
        </p>
        <button
          onClick={onRerunScan}
          className="py-2.5 px-5 bg-foreground hover:opacity-80 text-background font-semibold rounded-lg transition shadow-sm text-sm"
        >
          Run New Scan
        </button>
      </div>
    );
  }

  // Loading results (status was "found", fetching full data from cache)
  if (loadingResults) {
    return (
      <div className="bg-background p-12 h-full flex items-center justify-center min-h-100">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  // Initial status check or general loading
  if (loading) {
    return (
      <div className="p-12 h-full flex items-center justify-center min-h-100">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  // Live scan running — animation + live terminal log.
  // Also covers the case where the backend reports a scan running after a page
  // refresh (scanActive=true) — shows the animation while polling for results.
  if (state === 'running' || scanActive) {
    return (
      <div className="h-full flex flex-col min-h-100">
        {/* Top: animation + title */}
        <div className="flex flex-col items-center justify-center py-10 shrink-0">
          <Lottie animationData={runAnimation} loop className="w-32 h-32 dark:invert" />
          <h3 className="text-xl font-semibold text-foreground mt-2 mb-1">Scanning Project</h3>
          <p className="text-muted text-sm">Live output below</p>
        </div>

        {/* Bottom: inline terminal */}
        <div className="flex-1 min-h-0 mx-4 mb-4 rounded-xl overflow-hidden border border-border flex flex-col">
          {/* Terminal title bar */}
          <div className="flex items-center gap-2 px-4 py-2 bg-surface border-b border-border shrink-0">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-xs font-medium text-foreground">Running</span>
          </div>

          {/* Log body */}
          <div
            ref={terminalRef}
            className="flex-1 overflow-y-auto bg-[#0d1117] p-4 font-mono text-sm leading-relaxed"
            style={{ scrollbarWidth: 'thin', scrollbarColor: '#3b3b4f transparent' }}
          >
            {scanMessages.length === 0 ? (
              <span className="text-green-400 animate-pulse">&#x2588;</span>
            ) : (
              scanMessages.map((msg: ScanMessage, i: number) => {
                const styles: Record<string, string> = {
                  success: 'text-green-400',
                  warning: 'text-yellow-400',
                  phase: 'text-blue-400 font-bold',
                  error: 'text-red-500',
                  info: 'text-gray-300',
                };
                const prefixes: Record<string, string> = {
                  success: '[+]',
                  warning: '[!]',
                  error: '[ERR]',
                  info: '[*]',
                };
                const cls = styles[msg.type] ?? styles.info;
                const prefix = prefixes[msg.type] ?? '';
                return (
                  <div key={i} className="flex gap-2">
                    <span className={cls}>{prefix ? `${prefix} ${msg.content}` : msg.content}</span>
                  </div>
                );
              })
            )}
            {/* Blinking cursor at end */}
            {scanMessages.length > 0 && (
              <span className="text-green-400 animate-pulse">&#x2588;</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  // WS scan failed — show error panel instead of blank page.
  // (local `error` state is only set by fetch errors, not WebSocket errors, so
  // we need a separate gate for the WS-error + no-results case.)
  if (state === 'error' && !results && !error) {
    return (
      <div className="bg-red-500/5 rounded-2xl border border-red-500/20 p-12 h-full flex flex-col items-center justify-center min-h-100">
        <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mb-4 border border-red-500/20">
          <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h3 className="text-xl font-semibold text-foreground mb-2">Scan Failed</h3>
        <p className="text-muted text-sm text-center max-w-sm mb-4">The scan was interrupted. Please try initiating a new scan from the dashboard.</p>
      </div>
    );
  }

  // Not initiated — no scan has been run yet (or completed but no results written yet)
  if (vulnStatus === 'not_initiated' && !results) {
    return (
      <div className="p-12 h-full flex flex-col items-center justify-center min-h-100">
        <Lottie
          animationData={waitAnimation}
          loop
          className="w-48 h-48 mb-4 dark:hidden"
        />
        <Lottie
          animationData={waitDarkAnimation}
          loop
          className="w-48 h-48 mb-4 hidden dark:block dark:invert"
        />
        <h3 className="text-xl font-semibold text-foreground mb-2">Awaiting Scan</h3>
        <p className="text-muted text-sm max-w-sm text-center">
          Initiate a security scan from the dashboard.
        </p>
      </div>
    );
  }

  // Error
  if (error) {
    return (
      <div className="bg-red-500/5 rounded-2xl border border-red-500/20 p-12 h-full flex flex-col items-center justify-center min-h-100">
        <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mb-4 border border-red-500/20">
          <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h3 className="text-xl font-semibold text-foreground mb-2">Scan Failed</h3>
        <p className="text-red-400 text-sm bg-red-500/10 px-4 py-2 rounded-md mb-4">{error}</p>
        <button
          onClick={() => {
            setError(null);
            setLoading(true);
            const cancelled = { current: false };
            fetchStatusAndResults(cancelled, { trackError: true });
          }}
          className="py-2 px-4 bg-red-600 hover:bg-red-700 active:bg-red-800 text-white font-semibold rounded-lg transition shadow-sm text-sm"
        >
          Retry
        </button>
      </div>
    );
  }

  // Clean scan (no findings persisted by backend)
  if (vulnStatus === 'not_found' && !results) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-12 h-full flex flex-col items-center justify-center min-h-100">
        <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mb-4 border border-emerald-500/20">
          <svg className="w-8 h-8 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h3 className="text-xl font-semibold text-foreground mb-2">No vulnerabilities detected</h3>
        <p className="text-muted text-sm max-w-md text-center">
          This project passed the current scan. You can proceed to deployment.
        </p>
      </div>
    );
  }

  // No results data
  if (!results) return null;

  const { supply_chain, code_security } = results;
  const hasVulnerabilities = supply_chain.length > 0 || code_security.length > 0;

  // ── Completely Clean State (No vulnerabilities at all) ──
  if (!hasVulnerabilities) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-12 h-full flex flex-col items-center justify-center min-h-100">
        <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mb-4 border border-emerald-500/20">
          <svg className="w-8 h-8 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h3 className="text-xl font-semibold text-foreground mb-2">No vulnerabilities detected</h3>
        <p className="text-muted text-sm max-w-md text-center">
          This project passed the current scan. You can proceed to deployment.
        </p>
      </div>
    );
  }

  // ── Vulnerabilities Found (Renders only sections with issues) ──
  return (
    <div className="space-y-8">
      {supply_chain.length > 0 && (
        <SupplyChainTable vulnerabilities={supply_chain} />
      )}
      {code_security.length > 0 && (
        <div className="space-y-3">
          {code_security.map((group, i) => (
            <CWEAccordion key={`${group.cwe_id}-${group.severity}-${i}`} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}
