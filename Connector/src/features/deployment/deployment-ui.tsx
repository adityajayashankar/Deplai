'use client';

import React from 'react';
import { ExternalLink } from 'lucide-react';

/** Scoped tokens — match Customization workspace, not cyan/purple pipeline chrome. */
export const DEPLOYMENT_WORKSPACE_STYLE = `
  .deployment-workspace {
    --font-sans: 'Noto Sans', sans-serif;
    --font-display: 'Space Grotesk', 'Avenir Next', sans-serif;
    --font-mono: 'JetBrains Mono', monospace;
    --dw-bg: #09090b;
    --dw-panel: #111113;
    --dw-panel-raised: #16161a;
    --dw-border: rgba(255,255,255,0.08);
    --dw-border-strong: rgba(255,255,255,0.14);
    --dw-muted: #71717a;
    --dw-fg: #e4e4e7;
    --dw-accent: #fafafa;
  }
  .deployment-workspace h1,
  .deployment-workspace h2 {
    font-family: var(--font-display);
    letter-spacing: -0.02em;
  }
  .deployment-workspace .font-mono {
    font-family: var(--font-mono);
  }
  .deployment-scrollbar { scrollbar-width: thin; scrollbar-color: #27272a transparent; }
  .deployment-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
  .deployment-scrollbar::-webkit-scrollbar-thumb { background: #27272a; border-radius: 999px; }
  @media (prefers-reduced-motion: reduce) {
    .deployment-workspace *,
    .deployment-workspace *::before,
    .deployment-workspace *::after {
      scroll-behavior: auto !important;
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
`;

const COST_LABELS: Record<string, string> = {
  ec2: 'EC2 compute',
  ebs: 'EBS storage',
  alb: 'Application Load Balancer',
  alb_lcu: 'ALB capacity units',
  eip: 'Elastic IP',
  nat: 'NAT gateway',
  nat_data: 'NAT data processing',
  rds: 'RDS database',
  redis: 'ElastiCache Redis',
  s3: 'S3 storage',
  cloudfront: 'CloudFront',
  transfer: 'Data transfer',
};

export function formatCostComponentLabel(component: string, label?: string): string {
  const key = String(component || '').trim().toLowerCase();
  if (COST_LABELS[key]) return COST_LABELS[key];
  const raw = String(label || component || '').trim();
  if (!raw) return 'Resource';
  if (COST_LABELS[raw.toLowerCase()]) return COST_LABELS[raw.toLowerCase()];
  return raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function shortenDecisionHash(hash: string | undefined | null): string {
  const value = String(hash || '').trim();
  if (!value) return '';
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function resolveEndpointHref(value: string): string | null {
  const raw = String(value || '').trim();
  if (!raw || raw === 'n/a') return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return `http://${raw}`;
  if (raw.includes('.')) return `https://${raw}`;
  return null;
}

export function StageHeader({
  title,
  description,
  meta,
  actions,
}: {
  title: string;
  description: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 border-b border-white/10 pb-6 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-zinc-50">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-500">{description}</p>
        {meta ? <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Surface({
  children,
  className = '',
  padded = true,
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={`overflow-hidden rounded-xl border border-white/10 bg-[#111113] ${padded ? 'p-5' : ''} ${className}`}
    >
      {children}
    </div>
  );
}

export function SurfaceLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
      {children}
    </div>
  );
}

export function MetaChip({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger';
}) {
  const toneClass =
    tone === 'ok'
      ? 'border-zinc-600 bg-zinc-800/60 text-zinc-200'
      : tone === 'warn'
        ? 'border-amber-500/25 bg-amber-500/10 text-amber-200'
        : tone === 'danger'
          ? 'border-red-500/25 bg-red-500/10 text-red-200'
          : 'border-white/10 bg-black/40 text-zinc-300';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] ${toneClass}`}>
      <span className="text-zinc-500">{label}</span>
      <span className="font-mono text-[11px]">{value}</span>
    </span>
  );
}

export function EndpointRow({
  label,
  value,
  href,
  primary = false,
}: {
  label: string;
  value: string;
  href?: string | null;
  primary?: boolean;
}) {
  const display = String(value || '').trim();
  const missing = !display || display === 'n/a';
  const link = href || resolveEndpointHref(display);
  return (
    <div className={`flex items-start justify-between gap-4 border-b border-white/5 py-3 last:border-0 last:pb-0 first:pt-0 ${primary ? '' : ''}`}>
      <div className="min-w-0">
        <div className={`text-xs ${primary ? 'font-semibold text-zinc-200' : 'text-zinc-500'}`}>{label}</div>
        {missing ? (
          <div className="mt-1 font-mono text-sm text-zinc-600">—</div>
        ) : (
          <div className={`mt-1 break-all font-mono text-sm ${primary ? 'text-zinc-50' : 'text-zinc-200'}`}>{display}</div>
        )}
      </div>
      {!missing && link ? (
        <button
          type="button"
          onClick={() => window.open(link, '_blank', 'noopener,noreferrer')}
          className="mt-0.5 shrink-0 rounded-md border border-white/10 p-1.5 text-zinc-500 hover:border-white/20 hover:text-zinc-200"
          aria-label={`Open ${label}`}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export function primaryButtonClass(disabled?: boolean): string {
  return disabled
    ? 'inline-flex items-center justify-center gap-2 rounded-md bg-zinc-800 px-5 py-2.5 text-sm font-semibold text-zinc-500'
    : 'inline-flex items-center justify-center gap-2 rounded-md bg-zinc-100 px-5 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-white';
}

export function secondaryButtonClass(disabled?: boolean): string {
  return disabled
    ? 'inline-flex items-center justify-center gap-2 rounded-md border border-white/5 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-600'
    : 'inline-flex items-center justify-center gap-2 rounded-md border border-white/10 bg-[#16161a] px-4 py-2 text-sm font-semibold text-zinc-200 hover:border-white/20 hover:bg-[#1c1c21]';
}

export function accentButtonClass(disabled?: boolean): string {
  return disabled
    ? 'inline-flex items-center justify-center gap-2 rounded-md bg-zinc-800 px-5 py-2.5 text-sm font-semibold text-zinc-500'
    : 'inline-flex items-center justify-center gap-2 rounded-md bg-zinc-100 px-5 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-white';
}
