'use client';

import { AlertTriangle, Eye, Loader2 } from 'lucide-react';
import type { PreviewMetaResponse } from './types';

const PREVIEW_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups';

export function PreviewPanel({
  meta,
  metaLoading,
  frameSrc,
  compact = false,
}: {
  meta: PreviewMetaResponse | null;
  metaLoading: boolean;
  frameSrc: string;
  compact?: boolean;
}) {
  const starting = meta?.preview_kind === 'live_server' && (meta.preview_status === 'starting' || meta.preview_status === 'stopped');
  const failed = meta?.preview_kind === 'live_server' && meta.preview_status === 'failed';
  const held = starting || failed || (metaLoading && !meta);
  const previewLabel = meta?.preview_kind === 'live_server' ? 'live dev server' : 'static sandbox';
  const localhostLabel = meta?.preview_status === 'ready'
    ? `127.0.0.1 · ${previewLabel} · iframe`
    : '127.0.0.1 · preparing sandbox preview';

  return (
    <section aria-label="Application preview" className="flex min-h-0 flex-1 flex-col">
      {!compact ? (
      <div className="mb-5 flex shrink-0 items-center gap-2 text-[13px] text-neutral-600">
        <Eye className="h-4 w-4" />
        <span>Live preview</span>
        <span className="rounded-none border-[3px] border-black px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-neutral-600">
          sandboxed iframe
        </span>
      </div>
      ) : null}

      <div className={`app-paper flex ${compact ? 'min-h-[320px]' : 'min-h-[420px]'} flex-1 flex-col overflow-hidden`}>
        <div className="flex h-11 shrink-0 items-center gap-3 border-b-[3px] border-black bg-white px-4">
          <div className="flex gap-2">
            <span className="h-3 w-3 rounded-full bg-rose-500" />
            <span className="h-3 w-3 rounded-full bg-amber-400" />
            <span className="h-3 w-3 rounded-full bg-lime-500" />
          </div>
          <span className="font-mono text-[10px] text-neutral-500">{localhostLabel}</span>
        </div>

        <div className="relative min-h-0 flex-1 bg-neutral-100">
          {held ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center" role="status">
              {failed ? (
                <>
                  <AlertTriangle className="h-7 w-7 text-rose-400" />
                  <h2 className="mt-3 text-sm font-semibold text-zinc-100">Preview failed</h2>
                  <p className="mt-1 max-w-md text-xs leading-5 text-zinc-500">
                    {meta?.preview_detail || meta?.preview_error || 'The preview process did not become ready.'}
                  </p>
                </>
              ) : (
                <>
                  <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
                  <h2 className="mt-3 text-sm font-semibold text-zinc-100">
                    {starting ? 'Starting localhost preview' : 'Loading sandbox preview'}
                  </h2>
                  <p className="mt-1 text-xs text-zinc-500">
                    {meta?.preview_detail || 'Proxying the workspace through a same-origin sandbox iframe.'}
                  </p>
                </>
              )}
            </div>
          ) : frameSrc ? (
            <iframe
              key={frameSrc}
              src={frameSrc}
              title="Customized application preview"
              sandbox={PREVIEW_SANDBOX}
              referrerPolicy="no-referrer"
              loading="lazy"
              className="absolute inset-0 h-full min-h-[420px] w-full border-0 bg-white"
            />
          ) : (
            <div className="customization-preview-fallback absolute inset-0 overflow-hidden bg-[#0d0d10] p-8 sm:p-12">
              <div className="grid-bg-fine absolute inset-0 opacity-40" />
              <div className="relative flex h-full flex-col items-start justify-center">
                <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-violet-400">Your app</span>
                <h2 className="mt-4 max-w-md font-display text-4xl font-bold leading-tight tracking-tight text-white sm:text-5xl">
                  Your product, reimagined
                </h2>
                <p className="mt-5 max-w-sm text-[15px] leading-6 text-zinc-400">
                  Enter a workspace ID to load a localhost sandbox preview of your project.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
