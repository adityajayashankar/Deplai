'use client';

import { Plus_Jakarta_Sans, Space_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-plus-jakarta',
});

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space-grotesk',
});

export const ninetiesInkBtn =
  'border-4 border-black bg-[#00ff00] px-5 py-3 text-sm font-black shadow-[6px_6px_0px_0px_#000] transition-all hover:translate-x-1 hover:translate-y-1 hover:shadow-[4px_4px_0px_0px_#000] disabled:opacity-60';

export const ninetiesGhostBtn =
  'border-4 border-[#00ff00] bg-black px-5 py-3 text-sm font-black text-[#00ff00] shadow-[6px_6px_0px_0px_#00ff00] transition-all hover:translate-x-1 hover:translate-y-1 hover:shadow-[4px_4px_0px_0px_#00ff00]';

export const ninetiesInput =
  'w-full border-4 border-black bg-[#00ffff] px-3 py-2.5 text-sm font-black text-black outline-none placeholder:text-black/50';

export function NinetiesFrame({ children }: { children: ReactNode }) {
  return (
    <div className={`${plusJakarta.variable} ${spaceGrotesk.variable} theme-invert-exempt h-full min-h-0 overflow-y-auto font-[family-name:var(--font-plus-jakarta)]`}>
      <div className="relative min-h-full overflow-hidden bg-[#00ffff] px-4 py-6 text-black sm:px-6 sm:py-8 lg:px-8">
        <div className="pointer-events-none absolute inset-0 opacity-20">
          <div className="absolute top-10 left-10 h-32 w-32 rotate-45 border-8 border-[#ff00ff]" />
          <div className="absolute top-40 right-20 h-24 w-24 rounded-full border-8 border-[#00ff00]" />
          <div className="absolute right-16 bottom-24 h-20 w-20 bg-[#ff00ff]" />
        </div>
        <div className="relative z-10 mx-auto flex w-full max-w-[1200px] flex-col gap-5">
          {children}
        </div>
      </div>
    </div>
  );
}

export function NinetiesHeader({
  kicker,
  title,
  blurb,
  actions,
}: {
  kicker: string;
  title: string;
  blurb: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 border-8 border-black bg-white p-5 shadow-[12px_12px_0px_0px_#000] sm:flex-row sm:items-end sm:justify-between sm:p-6">
      <div>
        <p className="inline-block border-2 border-black bg-[#ff00ff] px-2 py-1 text-[10px] font-black tracking-wider text-[#ffffff] uppercase">
          {kicker}
        </p>
        <h1 className="mt-3 font-[family-name:var(--font-space-grotesk)] text-4xl font-black leading-none tracking-tight sm:text-5xl">
          {title}
        </h1>
        <p className="mt-3 max-w-xl text-sm font-black leading-relaxed">{blurb}</p>
      </div>
      {actions ? <div className="flex flex-col gap-2 sm:flex-row">{actions}</div> : null}
    </header>
  );
}

export function NinetiesBanner({ children }: { children: ReactNode }) {
  return (
    <div className="border-4 border-black bg-[#ffff00] px-4 py-3 text-sm font-black shadow-[6px_6px_0px_0px_#000]">
      {children}
    </div>
  );
}

export function NinetiesStat({
  label,
  value,
  tone = 'white',
}: {
  label: string;
  value: string;
  tone?: 'lime' | 'yellow' | 'magenta' | 'white' | 'cyan';
}) {
  const fill =
    tone === 'lime' ? 'bg-[#00ff00]' :
    tone === 'yellow' ? 'bg-[#ffff00]' :
    tone === 'magenta' ? 'bg-[#ff00ff] text-[#ffffff]' :
    tone === 'cyan' ? 'bg-[#00ffff]' :
    'bg-white';
  return (
    <div className={`border-8 border-black p-4 shadow-[8px_8px_0px_0px_#000] transition-all hover:translate-x-1 hover:translate-y-1 hover:shadow-[4px_4px_0px_0px_#000] ${fill}`}>
      <p className="text-[10px] font-black tracking-wider uppercase">{label}</p>
      <p className="mt-2 font-[family-name:var(--font-space-grotesk)] text-3xl font-black leading-none sm:text-4xl">{value}</p>
    </div>
  );
}

export function NinetiesPanel({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-8 border-black bg-white p-4 shadow-[12px_12px_0px_0px_#000] sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-3 border-b-4 border-black pb-3">
        <h2 className="font-[family-name:var(--font-space-grotesk)] text-xl font-black sm:text-2xl">{title}</h2>
        {badge ? (
          <span className="border-2 border-black bg-[#00ffff] px-2 py-1 text-[10px] font-black uppercase">{badge}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function NinetiesMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-4 border-black bg-[#00ffff] p-3 shadow-[4px_4px_0px_0px_#000]">
      <p className="text-[10px] font-black tracking-wider uppercase">{label}</p>
      <p className="mt-1 font-[family-name:var(--font-space-grotesk)] text-xl font-black leading-none sm:text-2xl">{value}</p>
    </div>
  );
}

export function NinetiesField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[10px] font-black tracking-wider uppercase">{label}</span>
      {children}
    </label>
  );
}

export function NinetiesToggle({
  on,
  onClick,
  label,
}: {
  on: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`border-4 border-black px-4 py-2 text-sm font-black shadow-[4px_4px_0px_0px_#000] ${
        on ? 'bg-[#00ff00]' : 'bg-white'
      }`}
    >
      {on ? 'On' : 'Off'}{label ? ` · ${label}` : ''}
    </button>
  );
}


export function NinetiesRow({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  const className = `flex w-full flex-col gap-2 border-4 border-black p-3 text-left shadow-[6px_6px_0px_0px_#000] sm:flex-row sm:items-center ${
    active ? 'bg-[#ffff00]' : 'bg-[#00ffff]'
  }`;
  if (!onClick) return <div className={className}>{children}</div>;
  return (
    <button type="button" onClick={onClick} className={className}>
      {children}
    </button>
  );
}

export function NinetiesBar({ percent, tone = 'lime' }: { percent: number; tone?: 'lime' | 'yellow' | 'magenta' }) {
  const fill = tone === 'magenta' ? 'bg-[#ff00ff]' : tone === 'yellow' ? 'bg-[#ffff00]' : 'bg-[#00ff00]';
  return (
    <div className="h-3 w-full overflow-hidden border-2 border-black bg-black sm:w-36">
      <div className={`h-full ${fill}`} style={{ width: `${Math.max(8, Math.min(100, percent))}%` }} />
    </div>
  );
}

export function formatUsd(value: number | string | undefined): string {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatTokens(value: number | string | undefined): string {
  const n = Math.max(0, Math.round(Number(value || 0)));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return String(n);
}

export function formatWhen(value: string | Date | undefined | null): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 19);
  return date.toLocaleString();
}

export function providerLabel(id: string, providers: Array<{ id: string; displayName: string }>): string {
  return providers.find((item) => item.id === id)?.displayName || id;
}
