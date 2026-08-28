'use client';

import type { SecurityModule } from './types';
import { secPaper } from '@/features/workspace/theme';

export function ScanProgress({ modules }: { modules: SecurityModule[] }) {
  const finished = modules.filter((module) =>
    ['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED', 'TIMED OUT'].includes(module.status),
  ).length;
  const running = modules.filter((module) => module.status === 'RUNNING' || module.status === 'STARTING').length;
  const failed = modules.filter((module) => module.status === 'FAILED').length;
  const percent = modules.length ? Math.round((finished / modules.length) * 100) : 0;

  return (
    <div className={`${secPaper} px-4 py-3`}>
      <div className="mb-2 flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">
        <span>Pipeline progress</span>
        <span className="text-black">
          {finished}/{modules.length} modules
          {running ? ` · ${running} running` : ''}
          {failed ? ` · ${failed} failed` : ''}
        </span>
      </div>
      <div className="h-px w-full bg-neutral-200" aria-hidden="true">
        <div className="h-px bg-black transition-[width] duration-500 ease-out" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
