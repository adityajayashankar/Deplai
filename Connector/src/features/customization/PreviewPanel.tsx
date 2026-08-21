'use client';

import { AlertTriangle, ExternalLink, Loader2, Lock, Monitor, RefreshCw, Smartphone, Tablet } from 'lucide-react';
import { PREVIEW_DEVICE_OPTIONS } from './config';
import type { PreviewDevice, PreviewMetaResponse } from './types';

const DEVICE_ICONS = { desktop: Monitor, tablet: Tablet, mobile: Smartphone };
const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0b]';

export function PreviewPanel({
  device,
  meta,
  metaLoading,
  frameSrc,
  previewUrl,
  onDeviceChange,
  onRefresh,
}: {
  device: PreviewDevice;
  meta: PreviewMetaResponse | null;
  metaLoading: boolean;
  frameSrc: string;
  previewUrl: string;
  onDeviceChange: (device: PreviewDevice) => void;
  onRefresh: () => void;
}) {
  const activeDevice = PREVIEW_DEVICE_OPTIONS.find((option) => option.value === device) ?? PREVIEW_DEVICE_OPTIONS[0];
  const starting = meta?.preview_kind === 'live_server' && meta.preview_status === 'starting';
  const failed = meta?.preview_kind === 'live_server' && meta.preview_status === 'failed';
  const held = starting || failed || (metaLoading && !meta);
  return (
    <section aria-label="Application preview" className="flex h-full min-h-0 flex-col bg-[#0a0a0b]">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/8 px-3 py-1.5">
        <div className="flex items-center gap-2 text-[10px] text-zinc-600">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              meta?.preview_status === 'ready' ? 'bg-emerald-400' : failed ? 'bg-rose-400' : 'bg-amber-400'
            }`}
          />
          <span>{metaLoading ? 'Checking runtime…' : meta?.preview_status || 'Unavailable'}</span>
          {meta?.preview_kind && (
            <span className="rounded border border-white/8 px-1.5 py-0.5 font-mono">
              {meta.preview_kind === 'live_server' ? 'Live' : 'Static fallback'}
            </span>
          )}
          {meta?.source && <span className="hidden sm:inline">Source: {meta.source === 'subspace' ? 'workspace copy' : 'base repository'}</span>}
        </div>
        <div className="flex items-center gap-1">
          <div className="flex rounded-md border border-white/10 bg-white/3 p-0.5" aria-label="Preview device">
            {PREVIEW_DEVICE_OPTIONS.map((option) => {
              const Icon = DEVICE_ICONS[option.value];
              return (
                <button
                  type="button"
                  key={option.value}
                  onClick={() => onDeviceChange(option.value)}
                  aria-label={`${option.label} preview`}
                  aria-pressed={device === option.value}
                  className={`rounded p-1.5 ${
                    device === option.value ? 'bg-white/10 text-zinc-200' : 'text-zinc-600 hover:text-zinc-300'
                  } ${focusRing}`}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className={`rounded p-2 text-zinc-500 hover:bg-white/5 hover:text-zinc-200 ${focusRing}`}
            aria-label="Reload preview"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <a
            href={previewUrl || undefined}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!previewUrl}
            className={`rounded p-2 text-zinc-500 hover:bg-white/5 hover:text-zinc-200 aria-disabled:pointer-events-none aria-disabled:opacity-30 ${focusRing}`}
            aria-label="Open preview in new tab"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-[#080809] p-3 sm:p-5">
        <div
          className="flex min-h-[420px] max-w-full flex-1 flex-col overflow-hidden rounded-lg border border-white/10 bg-[#111113] shadow-2xl transition-[max-width] duration-200 motion-reduce:transition-none"
          style={{ maxWidth: activeDevice.width }}
        >
          <div className="flex h-9 shrink-0 items-center gap-3 border-b border-white/8 bg-[#151517] px-3">
            <div className="flex gap-1">
              <span className="h-2 w-2 rounded-full bg-zinc-700" />
              <span className="h-2 w-2 rounded-full bg-zinc-700" />
              <span className="h-2 w-2 rounded-full bg-zinc-700" />
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-white/7 bg-black/20 px-2 py-1 font-mono text-[9px] text-zinc-600">
              <Lock className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{meta?.preview_url || previewUrl || 'Preview unavailable'}</span>
            </div>
          </div>
          <div className="relative flex min-h-0 flex-1 items-center justify-center bg-white">
            {held ? (
              <div className="flex max-w-md flex-col items-center p-8 text-center text-zinc-900" role="status">
                {failed ? (
                  <>
                    <AlertTriangle className="h-7 w-7 text-rose-600" />
                    <h2 className="mt-3 text-sm font-semibold">Preview failed</h2>
                    <p className="mt-1 text-xs text-zinc-600">{meta?.preview_detail || 'The preview process did not become ready.'}</p>
                    <button
                      type="button"
                      onClick={onRefresh}
                      className="mt-4 rounded-md bg-zinc-900 px-3 py-2 text-xs font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500"
                    >
                      Retry preview
                    </button>
                  </>
                ) : (
                  <>
                    <Loader2 className="h-7 w-7 animate-spin text-zinc-500" />
                    <h2 className="mt-3 text-sm font-semibold">{starting ? 'Starting preview runtime' : 'Loading preview'}</h2>
                    <p className="mt-1 text-xs text-zinc-600">{meta?.preview_detail || 'Resolving the workspace preview.'}</p>
                  </>
                )}
              </div>
            ) : frameSrc ? (
              <iframe
                key={frameSrc}
                src={frameSrc}
                title="Customized application preview"
                className="h-full min-h-[420px] w-full border-0 bg-white"
              />
            ) : (
              <div className="p-8 text-center text-zinc-900">
                <Monitor className="mx-auto h-7 w-7 text-zinc-400" />
                <h2 className="mt-3 text-sm font-semibold">No preview available</h2>
                <p className="mt-1 text-xs text-zinc-500">Apply a confirmed manifest to create a preview.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
