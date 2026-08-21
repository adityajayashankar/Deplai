'use client';

import { CheckCircle2, Key, X } from 'lucide-react';
import { PROVIDER_MODEL_MAP } from './config';
import type { ByokConfig, ByokProvider } from './types';

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#111113]';

type Draft = { provider: ByokProvider | ''; modelId: string; apiKey: string };

export function ByokDialog({
  open,
  config,
  draft,
  onDraftChange,
  onSave,
  onClear,
  onClose,
}: {
  open: boolean;
  config: ByokConfig | null;
  draft: Draft;
  onDraftChange: (draft: Draft) => void;
  onSave: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" role="presentation" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="byok-title"
        onMouseDown={(event) => event.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-xl border border-white/10 bg-[#111113] shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-white/8 px-5 py-4">
          <div className="flex items-center gap-2">
            <Key className="h-4 w-4 text-zinc-400" />
            <h2 id="byok-title" className="text-sm font-semibold text-zinc-100">
              Session model credentials
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close credentials dialog" className={`rounded p-1 text-zinc-600 hover:text-zinc-200 ${focusRing}`}>
            <X className="h-4 w-4" />
          </button>
        </header>
        {config ? (
          <div className="space-y-4 p-5">
            <div className="flex items-center gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
              <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              <div>
                <p className="text-xs font-medium text-zinc-200">Credentials active</p>
                <p className="mt-0.5 text-[10px] text-zinc-500">
                  {config.provider} · {PROVIDER_MODEL_MAP[config.provider].find((model) => model.id === config.modelId)?.name || config.modelId}
                </p>
              </div>
            </div>
            <p className="text-[10px] leading-5 text-zinc-600">The key exists in browser memory for this session and is sent only with agent requests.</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClear} className={`rounded-md border border-white/10 px-3 py-2 text-xs text-zinc-400 hover:bg-white/5 ${focusRing}`}>
                Remove key
              </button>
              <button type="button" onClick={onClose} className={`rounded-md bg-zinc-100 px-3 py-2 text-xs font-semibold text-zinc-950 ${focusRing}`}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 p-5">
            <div>
              <label htmlFor="byok-provider" className="mb-1.5 block text-[10px] font-medium text-zinc-500">
                Provider
              </label>
              <select
                id="byok-provider"
                value={draft.provider}
                onChange={(event) => onDraftChange({ provider: event.target.value as ByokProvider, modelId: '', apiKey: draft.apiKey })}
                className={`h-9 w-full rounded-md border border-white/10 bg-[#0a0a0b] px-2 text-xs text-zinc-200 ${focusRing}`}
              >
                <option value="">Select provider</option>
                {(Object.keys(PROVIDER_MODEL_MAP) as ByokProvider[]).map((provider) => (
                  <option key={provider} value={provider}>
                    {provider}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="byok-model" className="mb-1.5 block text-[10px] font-medium text-zinc-500">
                Model
              </label>
              <select
                id="byok-model"
                disabled={!draft.provider}
                value={draft.modelId}
                onChange={(event) => onDraftChange({ ...draft, modelId: event.target.value })}
                className={`h-9 w-full rounded-md border border-white/10 bg-[#0a0a0b] px-2 text-xs text-zinc-200 disabled:opacity-40 ${focusRing}`}
              >
                <option value="">Select model</option>
                {draft.provider &&
                  PROVIDER_MODEL_MAP[draft.provider].map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label htmlFor="byok-key" className="mb-1.5 block text-[10px] font-medium text-zinc-500">
                API key
              </label>
              <input
                id="byok-key"
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                onChange={(event) => onDraftChange({ ...draft, apiKey: event.target.value })}
                placeholder="Stored in memory only"
                className={`h-9 w-full rounded-md border border-white/10 bg-[#0a0a0b] px-3 text-xs text-zinc-200 placeholder:text-zinc-700 ${focusRing}`}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} className={`rounded-md px-3 py-2 text-xs text-zinc-500 hover:bg-white/5 ${focusRing}`}>
                Cancel
              </button>
              <button
                type="button"
                onClick={onSave}
                disabled={!draft.provider || !draft.modelId || !draft.apiKey.trim()}
                className={`rounded-md bg-zinc-100 px-3 py-2 text-xs font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
              >
                Use for this session
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
