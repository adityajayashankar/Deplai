'use client';

import { KeyRound, Sparkles, X } from 'lucide-react';
import {
  PlatformModelPicker,
  type PlatformModelValue,
} from '@/features/ai-platform/PlatformModelPicker';

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/35 focus-visible:ring-offset-2 focus-visible:ring-offset-white';

export function ModelSourceDialog({
  open,
  value,
  onChange,
  onClose,
}: {
  open: boolean;
  value: PlatformModelValue;
  onChange: (next: PlatformModelValue) => void;
  onClose: () => void;
}) {
  const Icon = value.accessMode === 'byok' ? KeyRound : Sparkles;
  return (
    <div
      className={open ? 'fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4' : 'hidden'}
      role="presentation"
      onMouseDown={open ? onClose : undefined}
    >
      <section
        role="dialog"
        aria-modal={open}
        aria-labelledby="model-source-title"
        hidden={!open}
        onMouseDown={(event) => event.stopPropagation()}
        className="app-paper w-full max-w-lg overflow-hidden"
      >
        <header className="flex items-center justify-between border-b-[3px] border-black px-5 py-4">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-black" />
            <h2 id="model-source-title" className="text-sm font-semibold text-black">
              Model source
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close model source dialog" className={`rounded p-1 text-neutral-500 hover:text-black ${focusRing}`}>
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="max-h-[min(72vh,640px)] overflow-y-auto p-5">
          <p className="mb-4 text-[12px] leading-5 text-neutral-600">
            Use DeplAI-hosted models included with your plan, or a key already saved in AI Platform credentials. API keys are not pasted here.
          </p>
          <PlatformModelPicker value={value} onChange={onChange} workNoun="customization" />
          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className={`border-[3px] border-black bg-black px-3 py-2 text-xs font-bold text-white shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none ${focusRing}`}
            >
              Done
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
