'use client';

import type { SecurityModuleStatus } from './types';

const STATUS_CLASS: Record<string, string> = {
  QUEUED: 'text-zinc-500',
  STARTING: 'text-sky-300',
  RUNNING: 'text-black',
  COMPLETED: 'text-emerald-700',
  FAILED: 'text-rose-400',
  CANCELLED: 'text-zinc-400',
  'TIMED OUT': 'text-amber-400',
  SKIPPED: 'text-zinc-500',
};

export function ScanStatus({
  status,
  pulsing = false,
}: {
  status: SecurityModuleStatus | string;
  pulsing?: boolean;
}) {
  const label = String(status || 'QUEUED');
  const tone = STATUS_CLASS[label] || 'text-zinc-400';
  const isLive = pulsing || label === 'RUNNING' || label === 'STARTING';

  return (
    <span className={`inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] ${tone}`}>
      {isLive ? (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-black opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-black" />
        </span>
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
      )}
      {label === 'TIMED OUT' ? 'Timed out' : label.charAt(0) + label.slice(1).toLowerCase()}
    </span>
  );
}
