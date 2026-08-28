'use client';

import { PIPELINE_MODULES, type SecurityModuleId } from './types';
import { secPaper } from '@/features/workspace/theme';

export { defaultEnabledModules, modulesForScan, looksLikePublicHttpUrl } from './dastTarget';

export function PipelineConfig({
  enabled,
  onToggle,
  dastTargetUrl,
  onDastTargetUrlChange,
}: {
  enabled: SecurityModuleId[];
  onToggle: (id: SecurityModuleId) => void;
  dastTargetUrl: string;
  onDastTargetUrlChange: (value: string) => void;
}) {
  return (
    <div className={`${secPaper} p-5`}>
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-black">Pipeline modules</h3>
        <p className="mt-1 text-xs text-neutral-500">
          Modules without matching files are skipped automatically. Dynamic testing only runs against an authorized public URL.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {PIPELINE_MODULES.filter((module) => !module.tabOnly).map((module) => {
          const checked = enabled.includes(module.id);
          return (
            <label key={module.id} className="flex cursor-pointer items-start gap-3 border-[2px] border-black/15 px-3 py-2">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(module.id)}
                className="mt-1 h-4 w-4 accent-black"
              />
              <span>
                <span className="block text-sm font-semibold text-black">{module.label}</span>
                <span className="block text-[11px] text-neutral-500">{module.summary}</span>
              </span>
            </label>
          );
        })}
      </div>
      <div className="mt-4">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">
          Dynamic testing uses a verified project target, not a free-form URL.
        </p>
        <a href="/dashboard/dast" className="text-sm font-semibold text-black underline">
          Open Dynamic Testing to verify a host
        </a>
        {dastTargetUrl ? (
          <p className="mt-2 font-mono text-xs text-neutral-500">Selected: {dastTargetUrl}</p>
        ) : (
          <p className="mt-2 text-[11px] text-neutral-500">
            Verify ownership first. Unrelated public websites are blocked.
          </p>
        )}
      </div>
    </div>
  );
}
