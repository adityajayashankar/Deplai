'use client';

import type { ChangeEvent, RefObject } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  FileCode2,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  ShieldAlert,
  UploadCloud,
  Wrench,
  XCircle,
} from 'lucide-react';
import { ASSET_OPTIONS, DEFAULT_APP_TARGETS, PIPELINE_MODE_OPTIONS, WORKSPACE_TABS } from './config';
import type {
  AssetPreview,
  AssetType,
  DiffEntry,
  ImplementRunState,
  LoadingState,
  QualityReport,
  WorkspaceTab,
} from './types';
import { diffLineClassName } from './utils';

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0b]';

export function WorkspaceTabs({
  active,
  onChange,
  errorCount,
  pendingAssetCount,
}: {
  active: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
  errorCount: number;
  pendingAssetCount: number;
}) {
  return (
    <nav aria-label="Workspace views" className="customization-scrollbar flex h-11 shrink-0 overflow-x-auto border-b border-white/8 bg-[#0d0d0f] px-1">
      {WORKSPACE_TABS.map((tab) => {
        const Icon = tab.icon;
        const badge = tab.value === 'quality' ? errorCount : tab.value === 'assets' ? pendingAssetCount : 0;
        return (
          <button
            type="button"
            key={tab.value}
            onClick={() => onChange(tab.value)}
            aria-current={active === tab.value ? 'page' : undefined}
            className={`relative flex h-full shrink-0 items-center gap-1.5 px-3 text-[11px] transition ${
              active === tab.value ? 'text-zinc-100' : 'text-zinc-600 hover:text-zinc-300'
            } ${focusRing}`}
          >
            <Icon className="h-3.5 w-3.5" />
            {tab.label}
            {badge > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500/15 px-1 text-[9px] text-rose-300">
                {badge}
              </span>
            )}
            {active === tab.value && <span className="absolute inset-x-2 bottom-0 h-px bg-zinc-200" />}
          </button>
        );
      })}
    </nav>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center p-8 text-center">
      <FileCode2 className="h-7 w-7 text-zinc-700" />
      <h2 className="mt-3 text-sm font-medium text-zinc-300">{title}</h2>
      <p className="mt-1 max-w-sm text-xs leading-5 text-zinc-600">{detail}</p>
    </div>
  );
}

export function ChangesPanel({ entries }: { entries: DiffEntry[] }) {
  if (!entries.length) {
    return <EmptyState title="No applied changes" detail="Confirmed customizations will appear here with their implementation source." />;
  }
  return (
    <section aria-label="Applied code changes" className="customization-scrollbar h-full overflow-auto p-3 sm:p-5">
      <div className="mx-auto max-w-5xl space-y-3">
        {entries.map((entry) => (
          <article key={entry.file} className="overflow-hidden rounded-lg border border-white/8 bg-[#0d0d0f]">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 px-3 py-2.5">
              <span className="min-w-0 truncate font-mono text-[10px] text-zinc-300">{entry.file}</span>
              <div className="flex items-center gap-1.5">
                {entry.source && (
                  <span className="rounded border border-sky-500/20 bg-sky-500/8 px-1.5 py-0.5 text-[9px] text-sky-300">
                    Source: {entry.source}
                  </span>
                )}
                {entry.operation && (
                  <span className="rounded border border-white/8 px-1.5 py-0.5 text-[9px] text-zinc-500">{entry.operation}</span>
                )}
                {entry.truncated && <span className="text-[9px] text-amber-400">Truncated</span>}
              </div>
            </header>
            <div className="customization-scrollbar overflow-x-auto p-2 font-mono text-[10px] leading-5">
              {entry.diff.split('\n').map((line, index) => (
                <div key={`${index}-${line}`} className={`min-w-max whitespace-pre px-2 ${diffLineClassName(line)}`}>
                  {line || ' '}
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function QualityPanel({
  errors,
  warnings,
  report,
  validatorIssues,
  repairing,
  onRepair,
}: {
  errors: string[];
  warnings: string[];
  report: QualityReport | null;
  validatorIssues: string[];
  repairing: boolean;
  onRepair: () => void;
}) {
  const checks = report?.checks || [];
  return (
    <section aria-label="Quality report" className="customization-scrollbar h-full overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">Validation</p>
            <h2 className="mt-1 text-base font-semibold text-zinc-100">Quality report</h2>
          </div>
          {validatorIssues.length > 0 && (
            <button
              type="button"
              onClick={onRepair}
              disabled={repairing}
              className={`inline-flex items-center gap-2 rounded-md bg-zinc-100 px-3 py-2 text-xs font-semibold text-zinc-950 disabled:opacity-40 ${focusRing}`}
            >
              {repairing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
              Repair {validatorIssues.length} issue{validatorIssues.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { label: 'Gate status', value: report?.status || 'not run' },
            { label: 'Errors', value: `${errors.length}` },
            { label: 'Warnings', value: `${warnings.length}` },
          ].map((item) => (
            <div key={item.label} className="rounded-lg border border-white/8 bg-[#0d0d0f] p-3">
              <p className="text-[9px] uppercase tracking-wider text-zinc-600">{item.label}</p>
              <p className="mt-1 font-mono text-sm text-zinc-200">{item.value}</p>
            </div>
          ))}
        </div>
        {checks.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-white/8">
            {checks.map((check, index) => {
              const passed = check.status === 'passed' || check.status === 'success';
              return (
                <div key={`${check.name}-${index}`} className="flex gap-3 border-b border-white/7 bg-[#0d0d0f] p-3 last:border-0">
                  {passed ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" /> : <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" />}
                  <div>
                    <p className="text-xs font-medium text-zinc-300">{check.name || `Check ${index + 1}`}</p>
                    {check.detail && <p className="mt-1 text-[11px] leading-5 text-zinc-600">{check.detail}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {errors.map((error, index) => (
          <div key={`${error}-${index}`} className="flex gap-3 rounded-lg border border-rose-500/20 bg-rose-500/5 p-3 text-xs text-rose-300">
            <XCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ))}
        {warnings.map((warning, index) => (
          <div key={`${warning}-${index}`} className="flex gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{warning}</span>
          </div>
        ))}
        {!report && !errors.length && !warnings.length && (
          <EmptyState title="Quality gates have not run" detail="Apply a confirmed manifest to run validation and generate a quality report." />
        )}
      </div>
    </section>
  );
}

export function ManifestPanel({
  manifest,
  confirmed,
  loading,
  onReload,
  onConfirm,
}: {
  manifest: Record<string, unknown> | null;
  confirmed: boolean;
  loading: boolean;
  onReload: () => void;
  onConfirm: () => void;
}) {
  return (
    <section aria-label="Manifest inspector" className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/8 px-4 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-medium text-zinc-200">manifest.json</h2>
          {manifest && (
            <span className={`rounded border px-1.5 py-0.5 text-[9px] ${confirmed ? 'border-emerald-500/20 text-emerald-300' : 'border-amber-500/20 text-amber-300'}`}>
              {confirmed ? 'Confirmed' : 'Review required'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onReload} disabled={loading} className={`rounded p-2 text-zinc-500 hover:bg-white/5 hover:text-zinc-200 ${focusRing}`} aria-label="Reload manifest">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {!confirmed && manifest && (
            <button type="button" onClick={onConfirm} disabled={loading} className={`inline-flex items-center gap-1.5 rounded-md bg-zinc-100 px-3 py-2 text-xs font-semibold text-zinc-950 ${focusRing}`}>
              <Check className="h-3.5 w-3.5" />
              Confirm manifest
            </button>
          )}
        </div>
      </header>
      {manifest ? (
        <pre className="customization-scrollbar min-h-0 flex-1 overflow-auto p-4 font-mono text-[11px] leading-5 text-zinc-400">
          {JSON.stringify(manifest, null, 2)}
        </pre>
      ) : (
        <EmptyState title="Manifest not loaded" detail="Enter a workspace ID, then reload or send an instruction to create a draft." />
      )}
    </section>
  );
}

export function AssetsPanel({
  assetType,
  assets,
  loading,
  fileInputRef,
  onAssetTypeChange,
  onUpload,
  onChooseFile,
  onApplyNow,
}: {
  assetType: AssetType;
  assets: AssetPreview[];
  loading: LoadingState;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onAssetTypeChange: (assetType: AssetType) => void;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onChooseFile: () => void;
  onApplyNow: () => void;
}) {
  const pending = assets.filter((asset) => asset.pending);
  return (
    <section aria-label="Asset manager" className="customization-scrollbar h-full overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">Brand system</p>
            <h2 className="mt-1 text-base font-semibold text-zinc-100">Assets</h2>
            <p className="mt-1 text-xs text-zinc-600">Uploads update the manifest and remain pending until applied.</p>
          </div>
          {pending.length > 0 && (
            <button
              type="button"
              onClick={onApplyNow}
              disabled={loading.confirm || loading.implement}
              className={`inline-flex items-center gap-2 rounded-md bg-zinc-100 px-3 py-2 text-xs font-semibold text-zinc-950 disabled:opacity-40 ${focusRing}`}
            >
              {loading.confirm || loading.implement ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Apply now
            </button>
          )}
        </div>
        <div className="grid gap-3 rounded-lg border border-white/8 bg-[#0d0d0f] p-4 sm:grid-cols-[220px_1fr]">
          <div>
            <label htmlFor="asset-type" className="mb-1.5 block text-[10px] font-medium text-zinc-500">
              Asset type
            </label>
            <select
              id="asset-type"
              value={assetType}
              onChange={(event) => onAssetTypeChange(event.target.value as AssetType)}
              className={`h-9 w-full rounded-md border border-white/10 bg-[#111113] px-2 text-xs text-zinc-200 ${focusRing}`}
            >
              {ASSET_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <span className="mb-1.5 block text-[10px] font-medium text-zinc-500">Image file</span>
            <input ref={fileInputRef} type="file" onChange={onUpload} accept="image/svg+xml,image/png,image/jpeg,image/webp" className="sr-only" />
            <button
              type="button"
              onClick={onChooseFile}
              disabled={loading.upload}
              className={`flex h-9 w-full items-center justify-center gap-2 rounded-md border border-dashed border-white/15 text-xs text-zinc-500 hover:border-zinc-500 hover:text-zinc-300 disabled:opacity-40 ${focusRing}`}
            >
              {loading.upload ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
              {loading.upload ? 'Uploading…' : 'Choose SVG, PNG, JPG, or WEBP (max 5 MB)'}
            </button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {assets.map((asset) => (
            <article key={asset.assetType} className="overflow-hidden rounded-lg border border-white/8 bg-[#0d0d0f]">
              <div className="flex h-32 items-center justify-center bg-black/25 p-4">
                {/* Backend assets are authenticated same-origin URLs and may be SVG. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={asset.previewUrl} alt={`${asset.assetType}: ${asset.fileName}`} className="max-h-full max-w-full object-contain" />
              </div>
              <div className="flex items-center justify-between border-t border-white/7 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-xs text-zinc-300">{asset.assetType}</p>
                  <p className="truncate text-[9px] text-zinc-700">{asset.fileName}</p>
                </div>
                {asset.pending && <span className="rounded border border-amber-500/20 bg-amber-500/8 px-1.5 py-0.5 text-[9px] text-amber-300">Pending</span>}
              </div>
            </article>
          ))}
        </div>
        {!assets.length && (
          <div className="rounded-lg border border-dashed border-white/10 py-12 text-center">
            <ImageIcon className="mx-auto h-6 w-6 text-zinc-700" />
            <p className="mt-2 text-xs text-zinc-600">No workspace assets uploaded.</p>
          </div>
        )}
      </div>
    </section>
  );
}

export function SettingsPanel({
  run,
  autoApply,
  resolvedRepoPath,
  onRunChange,
  onAutoApplyChange,
}: {
  run: ImplementRunState;
  autoApply: boolean;
  resolvedRepoPath: string;
  onRunChange: (next: ImplementRunState) => void;
  onAutoApplyChange: (next: boolean) => void;
}) {
  return (
    <section aria-label="Customization settings" className="customization-scrollbar h-full overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-7">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">Operator preferences</p>
          <h2 className="mt-1 text-base font-semibold text-zinc-100">Settings</h2>
        </div>
        <fieldset>
          <legend className="text-xs font-medium text-zinc-300">Implementation mode</legend>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {PIPELINE_MODE_OPTIONS.map((mode) => {
              const Icon = mode.icon;
              const selected = run.pipelineMode === mode.value;
              return (
                <label key={mode.value} className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${selected ? 'border-zinc-500 bg-white/5' : 'border-white/8 bg-[#0d0d0f]'}`}>
                  <input
                    type="radio"
                    name="pipeline-mode"
                    value={mode.value}
                    checked={selected}
                    onChange={() => onRunChange({ ...run, pipelineMode: mode.value })}
                    className="sr-only"
                  />
                  <Icon className={`mt-0.5 h-4 w-4 ${selected ? 'text-zinc-200' : 'text-zinc-600'}`} />
                  <span>
                    <span className="block text-xs text-zinc-300">{mode.label}</span>
                    <span className="mt-0.5 block text-[10px] text-zinc-600">{mode.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-xs font-medium text-zinc-300">Application targets</legend>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {DEFAULT_APP_TARGETS.map((target) => (
              <label key={target} className="flex cursor-pointer items-center gap-2 rounded-md border border-white/8 bg-[#0d0d0f] px-3 py-2.5 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={run.appTargets.includes(target)}
                  onChange={(event) =>
                    onRunChange({
                      ...run,
                      appTargets: event.target.checked ? [...run.appTargets, target] : run.appTargets.filter((item) => item !== target),
                    })
                  }
                  className="h-3.5 w-3.5 accent-zinc-100"
                />
                {target}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="rounded-lg border border-white/8 bg-[#0d0d0f] p-4">
          <label className="flex cursor-pointer items-start justify-between gap-4">
            <span>
              <span className="block text-xs font-medium text-zinc-300">Auto-apply approved changes</span>
              <span className="mt-1 block text-[10px] leading-4 text-zinc-600">
                After you explicitly confirm a manifest, start implementation automatically. Drafts are never silently confirmed.
              </span>
            </span>
            <input type="checkbox" checked={autoApply} onChange={(event) => onAutoApplyChange(event.target.checked)} className="mt-1 h-4 w-4 accent-zinc-100" />
          </label>
        </div>
        <div className="rounded-lg border border-white/8 bg-[#0d0d0f] p-4">
          <p className="text-[10px] uppercase tracking-wider text-zinc-600">Resolved repository</p>
          <p className="mt-2 break-all font-mono text-[10px] leading-5 text-zinc-400">{resolvedRepoPath || 'Repository path unavailable.'}</p>
        </div>
      </div>
    </section>
  );
}
