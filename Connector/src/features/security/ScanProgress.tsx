'use client';

import type { SecurityModule } from './types';
import { MODULE_ENGINES, SDLC_PHASES } from './types';
import { secPaper } from '@/features/workspace/theme';

export function ScanProgress({ modules }: { modules: SecurityModule[] }) {
  const byId = new Map(modules.map((module) => [module.id, module]));
  const finished = modules.filter((module) =>
    ['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED', 'TIMED OUT'].includes(module.status),
  ).length;
  const running = modules.filter((module) => module.status === 'RUNNING' || module.status === 'STARTING');
  const failed = modules.filter((module) => module.status === 'FAILED').length;
  const percent = modules.length ? Math.round((finished / modules.length) * 100) : 0;

  return (
    <div className={`${secPaper} space-y-3 px-4 py-3`}>
      <div className="flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">
        <span>Pipeline progress</span>
        <span className="text-black">
          {finished}/{modules.length} modules
          {running.length ? ` · ${running.map((m) => m.engine || MODULE_ENGINES[m.id] || m.id).join(', ')} running` : ''}
          {failed ? ` · ${failed} failed` : ''}
        </span>
      </div>
      <div className="h-px w-full bg-neutral-200" aria-hidden="true">
        <div className="h-px bg-black transition-[width] duration-500 ease-out" style={{ width: `${percent}%` }} />
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {SDLC_PHASES.map((phase) => {
          const phaseModules = phase.modules
            .map((id) => byId.get(id))
            .filter((item): item is SecurityModule => Boolean(item));
          if (!phaseModules.length) return null;
          const active = phaseModules.some((m) => m.status === 'RUNNING' || m.status === 'STARTING');
          const done = phaseModules.every((m) =>
            ['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED', 'TIMED OUT'].includes(m.status),
          );
          return (
            <div
              key={phase.id}
              className={`rounded border px-2 py-1.5 ${active ? 'border-black bg-neutral-50' : 'border-neutral-200'}`}
            >
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-neutral-500">
                {phase.label}
                {active ? ' · live' : done ? ' · done' : ''}
              </p>
              <ul className="mt-1 space-y-0.5">
                {phaseModules.map((module) => (
                  <li key={module.id} className="truncate text-[10px] text-neutral-700">
                    <span className="font-medium text-black">
                      {module.engine || MODULE_ENGINES[module.id] || module.id}
                    </span>
                    <span className="text-neutral-400"> · {module.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
