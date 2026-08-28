'use client';

import type { ReactNode } from 'react';
import { appBtnInk, appBtnPaper, appInput, appPaper } from '@/features/workspace/theme';

export function HealthDot({ status }: { status: string }) {
  const color =
    status === 'Healthy' || status === 'VALID' || status === 'active' ? 'bg-emerald-400' :
    status === 'Degraded' || status === 'PENDING' ? 'bg-amber-400' :
    status === 'Unavailable' || status === 'INVALID' || status === 'REVOKED' ? 'bg-rose-400' :
    'bg-zinc-500';
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />;
}

export function CapabilityBar({ label, value, source }: { label: string; value: number; source?: string }) {
  const width = Math.max(8, Math.min(100, value * 10));
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-[11px] text-zinc-500">{label}</span>
      <div className="h-1.5 flex-1 border-2 border-black bg-white">
        <div className="h-full bg-black" style={{ width: `${width}%` }} />
      </div>
      {source ? <span className="w-16 text-right font-mono text-[9px] uppercase tracking-wider text-zinc-600">{source}</span> : null}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className={`${appPaper} px-6 py-10 text-center`}>
      <p className="text-sm font-semibold text-black">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-zinc-500">{body}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`${appPaper} ${className}`}>{children}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

export const inputClass = appInput;

export const btnPrimary = appBtnInk;

export const btnGhost = appBtnPaper;

export async function aiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/ai/${path.replace(/^\//, '')}`, {
    cache: 'no-store',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error || 'AI platform request failed');
  }
  return payload as T;
}
