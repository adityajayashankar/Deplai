'use client';

import { secPaper } from '@/features/workspace/theme';
import type { SecurityRisk } from './types';

const LEVEL_TONE: Record<string, string> = {
  critical: 'text-rose-700',
  high: 'text-amber-700',
  medium: 'text-yellow-700',
  low: 'text-sky-700',
};

export function RiskScore({
  risk,
  onExplain,
}: {
  risk?: SecurityRisk | null;
  onExplain?: () => void;
}) {
  const score = risk?.score ?? 12;
  const level = String(risk?.level || 'low');
  const reasons = Array.isArray(risk?.reasons) ? risk.reasons : [];

  return (
    <div className={`${secPaper} p-5`}>
      <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-neutral-500">Overall risk score</p>
      <div className="mt-3 flex items-end gap-4">
        <div className={`text-5xl font-bold ${LEVEL_TONE[level] || 'text-black'}`}>{score}</div>
        <div className={`mb-1 font-mono text-[11px] uppercase tracking-[0.16em] ${LEVEL_TONE[level] || 'text-black'}`}>
          {level}
        </div>
      </div>
      <ul className="mt-4 space-y-1 text-[13px] text-neutral-600">
        {reasons.map((reason, index) => (
          <li key={`${reason}-${index}`}>+ {reason}</li>
        ))}
      </ul>
      {onExplain ? (
        <button
          type="button"
          onClick={onExplain}
          className="mt-4 text-xs font-bold uppercase tracking-wider text-black underline underline-offset-4"
        >
          Why is this {level}?
        </button>
      ) : null}
    </div>
  );
}
