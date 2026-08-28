'use client';

import { secPaper } from '@/features/workspace/theme';

export function SecurityKPI({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number | string;
  tone?: 'default' | 'critical' | 'high' | 'medium' | 'low' | 'success';
}) {
  const tones = {
    default: { label: 'text-neutral-500', value: 'text-black' },
    critical: { label: 'text-rose-700', value: 'text-rose-700' },
    high: { label: 'text-amber-700', value: 'text-amber-700' },
    medium: { label: 'text-yellow-700', value: 'text-yellow-700' },
    low: { label: 'text-sky-700', value: 'text-sky-700' },
    success: { label: 'text-emerald-700', value: 'text-emerald-700' },
  }[tone];

  return (
    <div className={`${secPaper} p-5`}>
      <h3 className={`mb-2 text-[10px] font-bold uppercase tracking-widest ${tones.label}`}>{label}</h3>
      <div className={`text-3xl font-bold ${tones.value}`}>{value}</div>
    </div>
  );
}
