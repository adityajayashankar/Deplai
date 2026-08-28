'use client';

const TONE: Record<string, string> = {
  critical: 'bg-rose-500/10 text-rose-500 border border-rose-500/20',
  high: 'bg-amber-500/10 text-amber-500 border border-amber-500/20',
  medium: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20',
  low: 'bg-sky-500/10 text-sky-400 border border-sky-500/20',
  informational: 'bg-zinc-500/10 text-zinc-400 border border-white/10',
};

export function SeverityBadge({ severity }: { severity: string }) {
  const value = String(severity || 'low').toLowerCase();
  const className = TONE[value] || TONE.low;
  return (
    <span className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${className}`}>
      {severity || 'low'}
    </span>
  );
}
