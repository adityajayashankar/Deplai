'use client';

import { ScanStatus } from './ScanStatus';
import { PIPELINE_MODULES, type SecurityModule, type SecurityModuleId } from './types';
import { secPaper } from '@/features/workspace/theme';

export function SecurityModuleCard({
  module,
  onSelect,
}: {
  module: SecurityModule;
  onSelect?: (id: SecurityModuleId) => void;
}) {
  const meta = PIPELINE_MODULES.find((item) => item.id === module.id);
  const clickable = Boolean(onSelect);
  const countLabel =
    module.id === 'sbom'
      ? module.status === 'COMPLETED'
        ? `${module.component_count || 0} components`
        : 'Inventory'
      : `${module.finding_count || 0} finding${module.finding_count === 1 ? '' : 's'}`;
  const detail = module.error || module.reason;

  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => onSelect?.(module.id)}
      className={`${secPaper} flex h-full w-full flex-col items-start p-4 text-left transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:cursor-default disabled:hover:translate-x-0 disabled:hover:translate-y-0 disabled:hover:shadow-[6px_6px_0_0_#000]`}
    >
      <div className="mb-3 flex w-full items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-black">{meta?.label || module.id}</p>
          <p className="mt-1 text-[11px] text-zinc-500">{meta?.summary}</p>
        </div>
        <ScanStatus status={module.status} />
      </div>
      <p className="font-mono text-xs text-neutral-700">{countLabel}</p>
      {detail ? <p className="mt-2 text-[11px] leading-5 text-zinc-500">{detail}</p> : null}
    </button>
  );
}

export function SecurityModuleGrid({
  modules,
  onSelect,
}: {
  modules: SecurityModule[];
  onSelect?: (id: SecurityModuleId) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {modules.map((module) => (
        <SecurityModuleCard key={module.id} module={module} onSelect={onSelect} />
      ))}
    </div>
  );
}
