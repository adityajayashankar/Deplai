'use client';

import React from 'react';
import { Check } from 'lucide-react';

export type SecurityPipelineStageId =
  | 'scan'
  | 'results'
  | 'remediate_setup'
  | 'remediate_run'
  | 'approval'
  | 'pr_rescan';

export const SECURITY_PIPELINE_STAGES: Array<{ id: SecurityPipelineStageId; label: string }> = [
  { id: 'scan', label: 'Scan' },
  { id: 'results', label: 'Results' },
  { id: 'remediate_setup', label: 'Agent setup' },
  { id: 'remediate_run', label: 'Remediation' },
  { id: 'approval', label: 'Review' },
  { id: 'pr_rescan', label: 'GitHub & verify' },
];

export const SECURITY_STAGE_INDEX: Record<SecurityPipelineStageId, number> = {
  scan: 0,
  results: 1,
  remediate_setup: 2,
  remediate_run: 3,
  approval: 4,
  pr_rescan: 5,
};

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/35 focus-visible:ring-offset-2 focus-visible:ring-offset-white';

export function SecurityStageRail({
  activeStage,
  maxUnlockedIndex,
  onSelectStage,
}: {
  activeStage: SecurityPipelineStageId;
  maxUnlockedIndex: number;
  onSelectStage: (stage: SecurityPipelineStageId) => void;
}) {
  const activeIndex = SECURITY_STAGE_INDEX[activeStage];
  const total = SECURITY_PIPELINE_STAGES.length;
  const percent = total > 1 ? Math.round((activeIndex / (total - 1)) * 100) : 0;
  const activeLabel = SECURITY_PIPELINE_STAGES[activeIndex]?.label || 'Scan';

  return (
    <div className="shrink-0 border-b-[3px] border-black bg-white px-5 py-4 sm:px-8">
      <div className="mb-3 flex items-end justify-between gap-4">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-neutral-500">
          Pipeline
        </p>
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">
          <span className="text-black">{String(activeIndex + 1).padStart(2, '0')}</span>
          <span className="text-neutral-400"> / {String(total).padStart(2, '0')}</span>
          <span className="mx-2 text-neutral-300">·</span>
          <span className="text-black">{activeLabel}</span>
        </p>
      </div>

      <div className="mb-4 h-px w-full bg-neutral-200" aria-hidden="true">
        <div
          className="h-px bg-black transition-[width] duration-500 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>

      <ol className="flex items-stretch">
        {SECURITY_PIPELINE_STAGES.map((stage, index) => {
          const locked = index > maxUnlockedIndex;
          const complete = index < activeIndex;
          const active = stage.id === activeStage;

          return (
            <li key={stage.id} className="flex min-w-0 flex-1 items-center">
              <button
                type="button"
                disabled={locked}
                onClick={() => onSelectStage(stage.id)}
                aria-current={active ? 'step' : undefined}
                title={stage.label}
                className={`flex min-w-0 items-center gap-2.5 border-b-[3px] py-2 pr-3 text-left transition-colors ${focusRing} ${
                  locked
                    ? 'cursor-not-allowed border-transparent'
                    : active
                      ? 'border-black'
                      : 'cursor-pointer border-transparent hover:border-black/30'
                }`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center border-[2px] border-black font-mono text-[10px] font-medium ${
                    complete || active
                      ? 'bg-black text-white'
                      : 'bg-white text-neutral-500'
                  }`}
                >
                  {complete ? <Check className="h-3 w-3" strokeWidth={2.2} /> : String(index + 1).padStart(2, '0')}
                </span>
                <span
                  className={`hidden truncate text-[12px] tracking-tight md:inline ${
                    active
                      ? 'font-bold text-black'
                      : complete
                        ? 'text-neutral-700'
                        : 'text-neutral-500'
                  }`}
                >
                  {stage.label}
                </span>
              </button>
              {index < total - 1 ? (
                <span
                  aria-hidden="true"
                  className="relative mx-1 hidden h-px min-w-3 flex-1 bg-neutral-200 sm:block"
                >
                  <span
                    className="absolute inset-y-0 left-0 bg-black transition-[width] duration-500 ease-out"
                    style={{ width: complete ? '100%' : '0%' }}
                  />
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
