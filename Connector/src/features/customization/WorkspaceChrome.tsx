'use client';

import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Circle,
  ExternalLink,
  GitPullRequest,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import { WORKFLOW_STEPS } from './config';
import type {
  CustomizationPrResult,
  QualityReport,
  SnapshotMetadata,
  StatusState,
  WorkflowStage,
} from './types';

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/35 focus-visible:ring-offset-2 focus-visible:ring-offset-white';

export function CommandHeader({
  onBack,
}: {
  onBack: () => void;
}) {
  return (
    <header className="workspace-command-header flex h-12 shrink-0 items-center justify-between border-b border-white/10 bg-[var(--app-canvas,#05060a)] px-5 sm:px-6 md:pr-20">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="font-mono uppercase tracking-[0.16em] text-white/40">deplai</span>
        <ChevronRight className="h-3.5 w-3.5 text-white/30" />
        <span className="font-display font-semibold text-white">Customization</span>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <div className="hidden items-center gap-2 border-2 border-white/20 px-3 py-1.5 font-mono text-[11px] text-white/50 sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          all systems operational
        </div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 border-2 border-white/20 px-3 py-1.5 text-[12px] font-bold text-white/80 transition hover:border-white hover:bg-white hover:text-black"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>
      </div>
    </header>
  );
}

export function WorkflowRail({
  currentStage,
  collapsed,
  onToggle,
  onSelectStage,
}: {
  currentStage: WorkflowStage;
  collapsed: boolean;
  onToggle: () => void;
  onSelectStage: (stage: WorkflowStage) => void;
}) {
  const currentIndex = WORKFLOW_STEPS.findIndex((step) => step.value === currentStage);
  return (
    <aside
      aria-label="Customization workflow"
      className={`${collapsed ? 'w-12' : 'w-44'} hidden shrink-0 border-r-[3px] border-black bg-white transition-[width] duration-200 md:flex md:flex-col`}
    >
      <div className={`flex h-11 items-center border-b-[3px] border-black ${collapsed ? 'justify-center' : 'justify-between px-3'}`}>
        {!collapsed && <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">Workflow</span>}
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand workflow rail' : 'Collapse workflow rail'}
          className={`rounded p-1.5 text-neutral-500 hover:bg-black hover:text-white ${focusRing}`}
        >
          {collapsed ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
        </button>
      </div>
      <ol className="flex-1 space-y-1 p-2">
        {WORKFLOW_STEPS.map((step, index) => {
          const complete = index < currentIndex;
          const active = index === currentIndex;
          return (
            <li key={step.value}>
              <button
                type="button"
                onClick={() => onSelectStage(step.value)}
                title={collapsed ? `${step.label}: ${step.description}` : undefined}
                aria-current={active ? 'step' : undefined}
                className={`flex w-full items-center rounded-none border-[3px] text-left transition ${
                  collapsed ? 'justify-center p-2' : 'gap-2.5 px-2 py-2'
                } ${
                  active
                    ? 'border-black bg-black text-white'
                    : 'border-transparent text-neutral-600 hover:border-black hover:text-black'
                } ${focusRing}`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-none border-2 ${
                    complete
                      ? 'border-black bg-black text-white'
                      : active
                        ? 'border-white text-white'
                        : 'border-neutral-400 text-neutral-400'
                  }`}
                >
                  {complete ? <Check className="h-2.5 w-2.5" /> : <Circle className="h-1.5 w-1.5 fill-current" />}
                </span>
                {!collapsed && (
                  <span className="min-w-0">
                    <span className="block text-[11px] font-medium">{step.label}</span>
                    <span className="block truncate text-[9px] text-neutral-500">{step.description}</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

export function StatusBar({
  status,
  busy,
  onToggleAgent,
  onResetSession,
  onResetRepo,
}: {
  status: StatusState;
  busy: boolean;
  onToggleAgent: () => void;
  onResetSession: () => void;
  onResetRepo: () => void;
}) {
  const tone =
    status.level === 'error'
      ? 'bg-rose-400'
      : status.level === 'success'
        ? 'bg-emerald-400'
        : status.level === 'warning'
          ? 'bg-amber-400'
          : 'bg-sky-400';
  return (
    <footer
      aria-live="polite"
      className="flex min-h-8 shrink-0 items-center justify-between gap-3 border-t-[3px] border-black bg-white px-3 text-[10px] text-neutral-500"
    >
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onToggleAgent}
          className={`rounded p-1 text-neutral-500 hover:bg-black hover:text-white ${focusRing}`}
          aria-label="Toggle agent panel"
        >
          <PanelLeftClose className="h-3.5 w-3.5" />
        </button>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />
        <span className="truncate">{status.text}</span>
        <span className="hidden items-center gap-1 font-mono sm:flex">
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          {busy ? 'Working' : 'Idle'}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onResetSession}
          className={`rounded px-2 py-1 hover:bg-black hover:text-white ${focusRing}`}
        >
          Reset session
        </button>
        <button
          type="button"
          onClick={onResetRepo}
          className={`inline-flex items-center gap-1 rounded px-2 py-1 text-rose-400/80 hover:bg-rose-500/10 hover:text-rose-300 ${focusRing}`}
        >
          <RotateCcw className="h-3 w-3" />
          Reset repository
        </button>
      </div>
    </footer>
  );
}

export function HandoffDialog({
  open,
  onClose,
  onContinue,
  onCreateGitPr,
  tenantId,
  manifestConfirmed,
  changedFiles,
  quality,
  previewReady,
  canContinue,
  finalizing,
  creatingGitPr,
  snapshot,
  gitPrResult,
  deployedUrl,
}: {
  open: boolean;
  onClose: () => void;
  onContinue: () => void;
  onCreateGitPr: () => void;
  tenantId: string;
  manifestConfirmed: boolean;
  changedFiles: number;
  quality: QualityReport | null;
  previewReady: boolean;
  canContinue: boolean;
  finalizing: boolean;
  creatingGitPr: boolean;
  snapshot: SnapshotMetadata | null;
  gitPrResult: CustomizationPrResult | null;
  deployedUrl: string;
}) {
  if (!open) return null;
  const rows = [
    { label: 'Manifest', value: manifestConfirmed ? 'Confirmed' : 'Requires confirmation', ok: manifestConfirmed },
    { label: 'Changed files', value: `${changedFiles}`, ok: changedFiles > 0 },
    { label: 'Quality gates', value: quality?.status || 'Not run', ok: quality?.status === 'passed' || quality?.status === 'warning' },
    { label: 'Preview', value: previewReady ? 'Ready' : 'Not ready', ok: previewReady },
    { label: 'Snapshot destination', value: `SubSpace-${tenantId || 'workspace'} → security handoff`, ok: Boolean(tenantId) },
    ...(snapshot
      ? [{ label: 'Snapshot ID', value: snapshot.snapshot_id, ok: snapshot.status === 'immutable' }]
      : []),
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" role="presentation" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="handoff-title"
        onMouseDown={(event) => event.stopPropagation()}
        className="app-paper w-full max-w-lg"
      >
        <div className="border-b-[3px] border-black px-5 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500">Preflight</p>
          <h2 id="handoff-title" className="mt-1 text-base font-semibold text-black">
            Finalize deployment snapshot
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Missing confirmation, implementation, quality, and preview steps run before an immutable snapshot is created.
          </p>
        </div>
        <div className="space-y-2 p-5">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between rounded-none border-[3px] border-black bg-white px-3 py-2.5">
              <span className="text-xs text-zinc-500">{row.label}</span>
              <span className={`flex items-center gap-1.5 text-xs ${row.ok ? 'text-zinc-200' : 'text-amber-300'}`}>
                {row.ok ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                {row.value}
              </span>
            </div>
          ))}
          {snapshot?.snapshot_path ? (
            <p className="break-all rounded-md border border-white/7 bg-black/20 px-3 py-2 font-mono text-[10px] text-zinc-500">
              Source: {snapshot.snapshot_path}
            </p>
          ) : null}
          {gitPrResult ? (
            gitPrResult.pr_url ? (
              <a
                href={gitPrResult.pr_url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between gap-2 rounded-md border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-xs text-sky-300 hover:underline"
              >
                <span className="truncate">Customization pull request</span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              </a>
            ) : (
              <p className={`rounded-md border px-3 py-2 text-xs ${
                gitPrResult.reason === 'local_project'
                  ? 'border-white/7 bg-black/20 text-zinc-500'
                  : 'border-amber-500/20 bg-amber-500/5 text-amber-300'
              }`}>
                {gitPrResult.reason === 'local_project'
                  ? 'Local project: Git pull request creation is not applicable.'
                  : gitPrResult.error || `Git PR was not created (${gitPrResult.reason || 'unknown reason'}).`}
              </p>
            )
          ) : null}
          {deployedUrl ? (
            <a
              href={deployedUrl}
              target="_blank"
              rel="noreferrer"
              className="block truncate rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300 hover:underline"
            >
              Deployed application: {deployedUrl}
            </a>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t-[3px] border-black px-5 py-4">
          <button type="button" onClick={onClose} className={`rounded-md px-3 py-2 text-xs text-zinc-400 hover:bg-white/5 ${focusRing}`}>
            Close
          </button>
          {snapshot ? (
            <button
              type="button"
              onClick={onCreateGitPr}
              disabled={creatingGitPr || gitPrResult?.success}
              className={`inline-flex items-center gap-2 border-[3px] border-black bg-white px-3 py-2 text-xs font-bold text-black shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
            >
              {creatingGitPr ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitPullRequest className="h-3.5 w-3.5" />}
              {creatingGitPr ? 'Creating Git PR…' : gitPrResult?.success ? 'Git PR created' : 'Create Git PR'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onContinue}
            disabled={!canContinue || finalizing}
            className={`inline-flex items-center gap-2 border-[3px] border-black bg-black px-3 py-2 text-xs font-bold text-white shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
          >
            {finalizing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            {finalizing ? 'Creating immutable snapshot…' : 'Create snapshot and scan'}
          </button>
        </div>
      </section>
    </div>
  );
}
