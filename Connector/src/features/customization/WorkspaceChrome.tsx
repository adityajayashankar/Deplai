'use client';

import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Circle,
  Command,
  ExternalLink,
  GitPullRequest,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
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
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0b]';

export function CommandHeader({
  projectLabel,
  tenantId,
  onTenantChange,
  onBack,
  onConfirm,
  onApply,
  onOpenHandoff,
  isConfirmed,
  hasManifest,
  isBusy,
}: {
  projectLabel: string;
  tenantId: string;
  onTenantChange: (value: string) => void;
  onBack: () => void;
  onConfirm: () => void;
  onApply: () => void;
  onOpenHandoff: () => void;
  isConfirmed: boolean;
  hasManifest: boolean;
  isBusy: boolean;
}) {
  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-white/8 bg-[#0a0a0b] px-3 py-2 sm:px-4">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to dashboard"
        className={`rounded-md p-2 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200 ${focusRing}`}
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-zinc-100 text-zinc-950">
          <Command className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-zinc-100">Customization workspace</p>
          <p className="truncate text-[10px] text-zinc-600">{projectLabel || 'Unlinked project'}</p>
        </div>
      </div>
      <div className="order-3 flex w-full flex-1 sm:order-none sm:ml-3 sm:w-auto">
        <label className="sr-only" htmlFor="customization-workspace-id">
          Workspace ID
        </label>
        <input
          id="customization-workspace-id"
          value={tenantId}
          onChange={(event) => onTenantChange(event.target.value)}
          placeholder="Workspace ID"
          autoComplete="off"
          className={`h-8 w-full min-w-0 rounded-md border border-white/10 bg-[#111113] px-3 text-xs text-zinc-200 placeholder:text-zinc-600 sm:max-w-64 ${focusRing}`}
        />
      </div>
      <div className="ml-auto flex items-center gap-2">
        {!isConfirmed ? (
          <button
            type="button"
            onClick={onConfirm}
            disabled={!hasManifest || isBusy}
            className={`hidden h-8 items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 text-xs font-medium text-zinc-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 sm:inline-flex ${focusRing}`}
          >
            {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Confirm manifest
          </button>
        ) : (
          <button
            type="button"
            onClick={onApply}
            disabled={isBusy}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md bg-zinc-100 px-3 text-xs font-semibold text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
          >
            {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Apply changes
          </button>
        )}
        <button
          type="button"
          onClick={onOpenHandoff}
          className={`inline-flex h-8 items-center gap-1.5 rounded-md border border-white/10 px-3 text-xs text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200 ${focusRing}`}
        >
          <span className="hidden sm:inline">Review handoff</span>
          <span className="sm:hidden">Handoff</span>
          <ChevronRight className="h-3.5 w-3.5" />
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
      className={`${collapsed ? 'w-12' : 'w-44'} hidden shrink-0 border-r border-white/8 bg-[#0c0c0e] transition-[width] duration-200 md:flex md:flex-col`}
    >
      <div className={`flex h-11 items-center border-b border-white/8 ${collapsed ? 'justify-center' : 'justify-between px-3'}`}>
        {!collapsed && <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">Workflow</span>}
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand workflow rail' : 'Collapse workflow rail'}
          className={`rounded p-1.5 text-zinc-600 hover:bg-white/5 hover:text-zinc-300 ${focusRing}`}
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
                className={`flex w-full items-center rounded-md border text-left transition ${
                  collapsed ? 'justify-center p-2' : 'gap-2.5 px-2 py-2'
                } ${
                  active
                    ? 'border-white/10 bg-white/7 text-zinc-100'
                    : 'border-transparent text-zinc-600 hover:bg-white/4 hover:text-zinc-300'
                } ${focusRing}`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    complete
                      ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-400'
                      : active
                        ? 'border-zinc-300 text-zinc-200'
                        : 'border-zinc-700 text-zinc-700'
                  }`}
                >
                  {complete ? <Check className="h-2.5 w-2.5" /> : <Circle className="h-1.5 w-1.5 fill-current" />}
                </span>
                {!collapsed && (
                  <span className="min-w-0">
                    <span className="block text-[11px] font-medium">{step.label}</span>
                    <span className="block truncate text-[9px] text-zinc-600">{step.description}</span>
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
      className="flex min-h-8 shrink-0 items-center justify-between gap-3 border-t border-white/8 bg-[#0a0a0b] px-3 text-[10px] text-zinc-500"
    >
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onToggleAgent}
          className={`rounded p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200 ${focusRing}`}
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
          className={`rounded px-2 py-1 hover:bg-white/5 hover:text-zinc-300 ${focusRing}`}
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
        className="w-full max-w-lg rounded-xl border border-white/10 bg-[#111113] shadow-2xl"
      >
        <div className="border-b border-white/8 px-5 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-600">Preflight</p>
          <h2 id="handoff-title" className="mt-1 text-base font-semibold text-zinc-100">
            Finalize deployment snapshot
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Missing confirmation, implementation, quality, and preview steps run before an immutable snapshot is created.
          </p>
        </div>
        <div className="space-y-2 p-5">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between rounded-md border border-white/7 bg-black/20 px-3 py-2.5">
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
        <div className="flex flex-wrap justify-end gap-2 border-t border-white/8 px-5 py-4">
          <button type="button" onClick={onClose} className={`rounded-md px-3 py-2 text-xs text-zinc-400 hover:bg-white/5 ${focusRing}`}>
            Close
          </button>
          {snapshot ? (
            <button
              type="button"
              onClick={onCreateGitPr}
              disabled={creatingGitPr || gitPrResult?.success}
              className={`inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
            >
              {creatingGitPr ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitPullRequest className="h-3.5 w-3.5" />}
              {creatingGitPr ? 'Creating Git PR…' : gitPrResult?.success ? 'Git PR created' : 'Create Git PR'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onContinue}
            disabled={!canContinue || finalizing}
            className={`inline-flex items-center gap-2 rounded-md bg-zinc-100 px-3 py-2 text-xs font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
          >
            {finalizing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            {finalizing ? 'Creating immutable snapshot…' : 'Create snapshot and scan'}
          </button>
        </div>
      </section>
    </div>
  );
}
