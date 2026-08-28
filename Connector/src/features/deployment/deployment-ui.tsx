'use client';

import React from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Info, Loader2, XCircle } from 'lucide-react';

/* ────────────────────────────────────────────────────────────────────────────
   Design system for the deployment pipeline workspace.

   Visual tokens live in globals.css under the `.deployment-workspace` scope,
   so every primitive here reads from CSS variables (`--dw-*`) rather than
   hardcoding hexes. Panels are white paper with 3px black borders at three
   elevations: recessed (dark consoles), base, and raised.
   ──────────────────────────────────────────────────────────────────────────── */

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'agent';

type ToneStyle = {
  fg: string;
  border: string;
  bg: string;
  dot: string;
};

const TONES: Record<Tone, ToneStyle> = {
  neutral: {
    fg: 'text-[var(--dw-fg)]',
    border: 'border-black',
    bg: 'bg-white',
    dot: 'bg-[var(--dw-muted)]',
  },
  accent: {
    fg: 'text-[var(--dw-accent)]',
    border: 'border-black',
    bg: 'bg-white',
    dot: 'bg-[var(--dw-accent)]',
  },
  ok: {
    fg: 'text-[var(--dw-ok)]',
    border: 'border-black',
    bg: 'bg-white',
    dot: 'bg-[var(--dw-ok)]',
  },
  warn: {
    fg: 'text-[var(--dw-warn)]',
    border: 'border-black',
    bg: 'bg-white',
    dot: 'bg-[var(--dw-warn)]',
  },
  danger: {
    fg: 'text-[var(--dw-danger)]',
    border: 'border-black',
    bg: 'bg-white',
    dot: 'bg-[var(--dw-danger)]',
  },
  info: {
    fg: 'text-[var(--dw-info)]',
    border: 'border-black',
    bg: 'bg-white',
    dot: 'bg-[var(--dw-info)]',
  },
  agent: {
    fg: 'text-[var(--dw-agent)]',
    border: 'border-black',
    bg: 'bg-white',
    dot: 'bg-[var(--dw-agent)]',
  },
};

export const paperInsetClass = 'rounded-none border-[3px] border-black bg-white';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ── Formatting helpers ──────────────────────────────────────────────────── */

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

/* ── Panels ──────────────────────────────────────────────────────────────── */

export function Panel({
  children,
  className = '',
  elevation = 'base',
  padded = true,
  glow = false,
  as: Tag = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  elevation?: 'recessed' | 'base' | 'raised';
  padded?: boolean | 'sm' | 'lg';
  glow?: boolean;
  as?: 'div' | 'section' | 'aside';
}) {
  const elevationClass =
    elevation === 'raised' ? 'dw-panel dw-panel-raised' : elevation === 'recessed' ? 'dw-panel-recessed' : 'dw-panel';
  const padding =
    padded === true ? 'p-5' : padded === 'sm' ? 'p-3.5' : padded === 'lg' ? 'p-6 lg:p-7' : '';
  return (
    <Tag className={cx('overflow-hidden rounded-none', elevationClass, glow && 'dw-glow', padding, className)}>
      {children}
    </Tag>
  );
}

export function PanelHeader({
  title,
  subtitle,
  icon,
  actions,
  tone = 'neutral',
  className = '',
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  const toneStyle = TONES[tone];
  return (
    <div
      className={cx(
        'flex flex-wrap items-center justify-between gap-3 border-b border-[var(--dw-border)] px-5 py-3.5',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {icon ? (
          <span
            className={cx(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-none border-[3px]',
              toneStyle.border,
              toneStyle.bg,
              toneStyle.fg,
            )}
          >
            {icon}
          </span>
        ) : null}
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-[var(--dw-fg)]">{title}</div>
          {subtitle ? (
            <div className="mt-0.5 truncate text-[11px] text-[var(--dw-muted)]">{subtitle}</div>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionLabel({
  children,
  className = '',
  trailing,
}: {
  children: React.ReactNode;
  className?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className={cx('mb-3 flex items-center justify-between gap-3', className)}>
      <div className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-[var(--dw-muted)]">
        {children}
      </div>
      {trailing ? <div className="flex items-center gap-2">{trailing}</div> : null}
    </div>
  );
}

/* ── Stage frame ─────────────────────────────────────────────────────────── */

/**
 * Wraps a stage body: constrains width, animates on stage change, and reserves
 * space for a sticky action bar. `stageKey` remounts the animation each time
 * the pipeline advances.
 */
export function StageShell({
  children,
  stageKey,
  className = '',
  width = 'default',
  hasActionBar = false,
}: {
  children: React.ReactNode;
  stageKey?: string;
  className?: string;
  width?: 'default' | 'wide' | 'full';
  hasActionBar?: boolean;
}) {
  const maxWidth = width === 'full' ? '' : width === 'wide' ? 'max-w-[1440px]' : 'max-w-6xl';
  return (
    <div
      key={stageKey}
      className={cx('dw-stage-enter mx-auto w-full', maxWidth, hasActionBar && 'pb-4', className)}
    >
      {children}
    </div>
  );
}

export function StageHeader({
  title,
  description,
  meta,
  actions,
  eyebrow,
}: {
  title: string;
  description: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
}) {
  return (
    <div className="relative mb-7 pb-6">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[var(--dw-border-strong)] to-transparent" />
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          {eyebrow ? (
            <div className="mb-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.24em] text-[var(--dw-accent)]">
              {eyebrow}
            </div>
          ) : null}
          <h1 className="text-[26px] font-semibold leading-tight text-[var(--dw-fg)]">{title}</h1>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-[var(--dw-muted)]">{description}</p>
          {meta ? <div className="mt-4 flex flex-wrap items-center gap-2">{meta}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/* ── Status + metadata ───────────────────────────────────────────────────── */

export function StatusPill({
  children,
  tone = 'neutral',
  live = false,
  icon,
  className = '',
}: {
  children: React.ReactNode;
  tone?: Tone;
  live?: boolean;
  icon?: React.ReactNode;
  className?: string;
}) {
  const toneStyle = TONES[tone];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-2 rounded-none border-[3px] border-black bg-white px-2.5 py-1 text-[11px] font-medium',
        toneStyle.fg,
        className,
      )}
    >
      {icon ? (
        <span className="flex items-center">{icon}</span>
      ) : (
        <span className="relative flex h-1.5 w-1.5 items-center justify-center">
          {live ? <span className={cx('dw-ping absolute h-1.5 w-1.5 rounded-full', toneStyle.dot)} /> : null}
          <span className={cx('h-1.5 w-1.5 rounded-full', toneStyle.dot, live && 'dw-pulse')} />
        </span>
      )}
      {children}
    </span>
  );
}

export function Chip({
  children,
  tone = 'neutral',
  mono = false,
  className = '',
}: {
  children: React.ReactNode;
  tone?: Tone;
  mono?: boolean;
  className?: string;
}) {
  const toneStyle = TONES[tone];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-none border-[3px] border-black bg-white px-2 py-1 text-[11px]',
        toneStyle.fg,
        mono && 'font-mono',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function MetaChip({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: Tone;
}) {
  const toneStyle = TONES[tone];
  return (
    <span className="inline-flex items-center gap-2 rounded-none border-[3px] border-black bg-white px-2.5 py-1.5 text-[11px]">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--dw-muted)]">{label}</span>
      <span className={cx('font-mono text-[11px]', tone === 'neutral' ? 'text-[var(--dw-fg)]' : toneStyle.fg)}>
        {value}
      </span>
    </span>
  );
}

export function CountUp({
  value,
  prefix = '',
  suffix = '',
  decimals = 2,
  className = '',
}: {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  className?: string;
}) {
  const target = Number.isFinite(value) ? value : 0;
  const [display, setDisplay] = React.useState(target);

  React.useEffect(() => {
    const reduced =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setDisplay(target);
      return;
    }
    let frame = 0;
    const from = display;
    const delta = target - from;
    if (Math.abs(delta) < 0.001) {
      setDisplay(target);
      return;
    }
    const duration = 700;
    const started = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + delta * eased);
      if (t < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
    // Intentionally start from the last rendered value when `target` changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return (
    <span className={className}>
      {prefix}
      {display.toFixed(decimals)}
      {suffix}
    </span>
  );
}

export function fieldClass(disabled?: boolean): string {
  return cx(
    'w-full rounded-none border-[3px] border-black bg-white px-3.5 py-2.5 font-mono text-[13px] text-black outline-none transition-colors',
    'placeholder:text-neutral-500 focus:border-black',
    'focus-visible:ring-2 focus-visible:ring-black/35 focus-visible:ring-offset-2 focus-visible:ring-offset-white',
    disabled && 'cursor-not-allowed opacity-40',
  );
}

export function fieldLabelClass(): string {
  return 'mb-1.5 block font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--dw-muted)]';
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
  icon,
  loading = false,
  className = '',
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: Tone;
  icon?: React.ReactNode;
  loading?: boolean;
  className?: string;
}) {
  const toneStyle = TONES[tone];
  return (
    <div className={cx('dw-panel group relative rounded-none p-4 transition-colors hover:bg-neutral-50', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--dw-faint)]">
          {label}
        </div>
        {icon ? <span className={cx('shrink-0', toneStyle.fg)}>{icon}</span> : null}
      </div>
      {loading ? (
        <Skeleton className="mt-3 h-7 w-20" />
      ) : (
        <div
          className={cx(
            'mt-2.5 text-[22px] font-semibold leading-none tracking-tight',
            tone === 'neutral' ? 'text-[var(--dw-fg)]' : toneStyle.fg,
          )}
        >
          {value}
        </div>
      )}
      {hint ? <div className="mt-2 text-[11px] leading-relaxed text-[var(--dw-muted)]">{hint}</div> : null}
    </div>
  );
}

/* ── Buttons ─────────────────────────────────────────────────────────────── */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3 text-[12px]',
  md: 'h-10 gap-2 px-4 text-[13px]',
  lg: 'h-11 gap-2 px-5 text-[13px]',
};

/**
 * Single source of truth for pipeline button styling. The older
 * `*ButtonClass()` helpers below delegate here so both call styles agree.
 */
export function buttonClass(
  variant: ButtonVariant = 'primary',
  options: { size?: ButtonSize; disabled?: boolean; block?: boolean } = {},
): string {
  const { size = 'md', disabled = false, block = false } = options;
  const base = cx(
    'inline-flex items-center justify-center rounded-none font-bold whitespace-nowrap transition-transform',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/35 focus-visible:ring-offset-2 focus-visible:ring-offset-white',
    BUTTON_SIZES[size],
    block && 'w-full',
  );

  if (disabled) {
    return cx(
      base,
      'cursor-not-allowed border-[3px] border-black bg-neutral-100 text-neutral-400 shadow-none',
    );
  }

  switch (variant) {
    case 'primary':
    case 'accent':
      return cx(
        base,
        'border-[3px] border-black bg-black text-white shadow-[4px_4px_0_0_#000]',
        'hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none',
      );
    case 'secondary':
      return cx(
        base,
        'border-[3px] border-black bg-white text-black shadow-[4px_4px_0_0_#000]',
        'hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none',
      );
    case 'danger':
      return cx(
        base,
        'border-[3px] border-black bg-white text-[var(--dw-danger)] shadow-[4px_4px_0_0_#000]',
        'hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none',
      );
    case 'ghost':
    default:
      return cx(base, 'border-[3px] border-transparent text-[var(--dw-fg-soft)] hover:border-black hover:bg-white hover:text-[var(--dw-fg)]');
  }
}

export function primaryButtonClass(disabled?: boolean): string {
  return buttonClass('primary', { disabled, size: 'lg' });
}

/** Lime-accent CTA used by the deployment pipeline stepper screens. */
export function pipelinePrimaryButtonClass(disabled?: boolean): string {
  return buttonClass('primary', { disabled, size: 'lg' });
}

export function secondaryButtonClass(disabled?: boolean): string {
  return buttonClass('secondary', { disabled });
}

export function accentButtonClass(disabled?: boolean): string {
  return buttonClass('accent', { disabled, size: 'lg' });
}

/* ── Progress ────────────────────────────────────────────────────────────── */

export function ProgressBar({
  value,
  tone = 'accent',
  indeterminate = false,
  className = '',
  height = 'md',
}: {
  value?: number;
  tone?: Tone;
  indeterminate?: boolean;
  className?: string;
  height?: 'sm' | 'md';
}) {
  const toneStyle = TONES[tone];
  const pct = Math.max(0, Math.min(100, Number.isFinite(Number(value)) ? Number(value) : 0));
  return (
    <div
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cx(
        'relative w-full overflow-hidden rounded-none bg-neutral-200',
        height === 'sm' ? 'h-1' : 'h-1.5',
        className,
      )}
    >
      {indeterminate ? (
        <div className={cx('dw-progress-sweep h-full w-1/3 rounded-none', toneStyle.dot)} />
      ) : (
        <div
          className={cx('h-full rounded-none transition-[width] duration-500 ease-out', toneStyle.dot)}
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  );
}

/* ── Consoles + code ─────────────────────────────────────────────────────── */

export type LogLine = { text: string; tone?: Tone };

/**
 * Recessed terminal surface. Auto-scrolls to the tail while `streaming`, and
 * shows a blinking caret so a stalled run still reads as live.
 */
export function LogConsole({
  lines,
  streaming = false,
  emptyLabel = 'Waiting for output…',
  className = '',
  maxHeight = '20rem',
}: {
  lines: Array<string | LogLine>;
  streaming?: boolean;
  emptyLabel?: string;
  className?: string;
  maxHeight?: string;
}) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = React.useRef(true);
  const count = lines.length;

  React.useEffect(() => {
    if (!streaming) return;
    const node = scrollRef.current;
    if (!node || !stickToBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [count, streaming]);

  return (
    <div
      ref={scrollRef}
      onScroll={() => {
        const node = scrollRef.current;
        if (!node) return;
        stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
      }}
      className={cx('dw-scrollbar dw-no-scroll-anchor overflow-y-auto rounded-none p-4 font-mono text-[11.5px] leading-[1.7]', 'dw-panel-recessed', className)}
      style={{ maxHeight, overflowAnchor: 'none' }}
    >
      {count === 0 ? (
        <div className="text-[var(--dw-faint)]">{emptyLabel}</div>
      ) : (
        lines.map((line, index) => {
          const entry: LogLine = typeof line === 'string' ? { text: line } : line;
          const tone = entry.tone ?? inferLogTone(entry.text);
          return (
            <div key={`${index}-${entry.text.slice(0, 24)}`} className={cx('whitespace-pre-wrap break-words', TONES[tone].fg)}>
              {entry.text}
            </div>
          );
        })
      )}
      {streaming ? (
        <div className="mt-0.5 flex items-center gap-1.5 text-[var(--dw-accent)]">
          <span className="dw-caret inline-block h-3.5 w-[7px] bg-[var(--dw-accent)]" />
        </div>
      ) : null}
    </div>
  );
}

function inferLogTone(text: string): Tone {
  const value = String(text || '').toLowerCase();
  if (/(^|\s)(error|failed|failure|fatal|denied)/.test(value)) return 'danger';
  if (/(^|\s)(warn|warning|skipped)/.test(value)) return 'warn';
  if (/(complete|created|success|applied|ready|✓)/.test(value)) return 'ok';
  return 'neutral';
}

export function CodeSurface({
  code,
  language,
  filename,
  actions,
  className = '',
  maxHeight = '32rem',
  editable = false,
  onChange,
}: {
  code: string;
  language?: string;
  filename?: string;
  actions?: React.ReactNode;
  className?: string;
  maxHeight?: string;
  editable?: boolean;
  onChange?: (value: string) => void;
}) {
  return (
    <div className={cx('dw-code-surface overflow-hidden rounded-none dw-panel', className)}>
      {filename || actions ? (
        <div className="flex items-center justify-between gap-3 border-b-[3px] border-black bg-white px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            {filename ? (
              <span className="truncate font-mono text-[11.5px] text-black">{filename}</span>
            ) : null}
            {language ? (
              <span className="shrink-0 rounded-none border-[3px] border-black bg-white px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-black">
                {language}
              </span>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        </div>
      ) : null}
      {editable ? (
        <textarea
          value={code}
          onChange={(event) => onChange?.(event.target.value)}
          spellCheck={false}
          className="dw-scrollbar w-full resize-none bg-white p-4 font-mono text-[12px] leading-[1.7] text-black outline-none placeholder:text-neutral-500"
          style={{ height: maxHeight }}
        />
      ) : (
        <pre
          className="dw-scrollbar overflow-auto bg-white p-4 font-mono text-[12px] leading-[1.7] text-black"
          style={{ maxHeight }}
        >
          {code}
        </pre>
      )}
    </div>
  );
}

/* ── Messaging ───────────────────────────────────────────────────────────── */

const CALLOUT_ICONS: Partial<Record<Tone, React.ComponentType<{ className?: string }>>> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  danger: XCircle,
  info: Info,
  accent: Info,
  agent: Info,
  neutral: Info,
};

export function Callout({
  tone = 'info',
  title,
  children,
  actions,
  icon,
  className = '',
}: {
  tone?: Tone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  const toneStyle = TONES[tone];
  const Icon = CALLOUT_ICONS[tone] ?? Info;
  return (
    <div
      className={cx(
        'flex flex-col gap-3 rounded-none border-[3px] p-4 sm:flex-row sm:items-center sm:justify-between',
        toneStyle.border,
        toneStyle.bg,
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className={cx('mt-0.5 shrink-0', toneStyle.fg)}>{icon ?? <Icon className="h-4 w-4" />}</span>
        <div className="min-w-0">
          {title ? <div className={cx('text-[13px] font-semibold', toneStyle.fg)}>{title}</div> : null}
          {children ? (
            <div className={cx('text-[12.5px] leading-relaxed', title ? 'mt-1 text-[var(--dw-fg-soft)]' : toneStyle.fg)}>
              {children}
            </div>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  actions,
  loading = false,
  className = '',
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  loading?: boolean;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-none border-[3px] border-black bg-white text-[var(--dw-muted)]">
        {loading ? <Loader2 className="h-5 w-5 animate-spin text-[var(--dw-accent)]" /> : icon}
      </div>
      <div className="text-[14px] font-semibold text-[var(--dw-fg)]">{title}</div>
      {description ? (
        <p className="mt-2 max-w-md text-[12.5px] leading-relaxed text-[var(--dw-muted)]">{description}</p>
      ) : null}
      {actions ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={cx('dw-shimmer rounded-none bg-neutral-200', className)} />;
}

/* ── Rows ────────────────────────────────────────────────────────────────── */

export function KeyValueRow({
  label,
  value,
  mono = true,
  tone = 'neutral',
  className = '',
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'flex items-baseline justify-between gap-4 border-b border-[var(--dw-border)] py-2.5 first:pt-0 last:border-0 last:pb-0',
        className,
      )}
    >
      <span className="shrink-0 text-[12px] text-[var(--dw-muted)]">{label}</span>
      <span
        className={cx(
          'min-w-0 break-words text-right text-[12.5px]',
          mono && 'font-mono',
          tone === 'neutral' ? 'text-[var(--dw-fg)]' : TONES[tone].fg,
        )}
      >
        {value}
      </span>
    </div>
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
    <div className="group flex items-start justify-between gap-4 border-b border-[var(--dw-border)] py-3.5 first:pt-0 last:border-0 last:pb-0">
      <div className="min-w-0">
        <div
          className={cx(
            'text-[11px]',
            primary
              ? 'font-mono uppercase tracking-[0.16em] text-[var(--dw-accent)]'
              : 'font-mono uppercase tracking-[0.16em] text-[var(--dw-faint)]',
          )}
        >
          {label}
        </div>
        {missing ? (
          <div className="mt-1.5 font-mono text-[13px] text-[var(--dw-faint)]">—</div>
        ) : (
          <div
            className={cx(
              'mt-1.5 break-all font-mono text-[13px]',
              primary ? 'text-[var(--dw-fg)]' : 'text-[var(--dw-fg-soft)]',
            )}
          >
            {display}
          </div>
        )}
      </div>
      {!missing && link ? (
        <button
          type="button"
          onClick={() => window.open(link, '_blank', 'noopener,noreferrer')}
          className="mt-0.5 shrink-0 rounded-lg border border-[var(--dw-border)] p-2 text-[var(--dw-muted)] transition-colors hover:border-[var(--dw-accent-line)] hover:text-[var(--dw-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dw-accent)]/60"
          aria-label={`Open ${label}`}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/* ── Sticky action bar ───────────────────────────────────────────────────── */

/**
 * Bottom gate bar for stage continue/approve actions. Because it lives inside
 * the scroll container's flex parent, it pins to the viewport without needing
 * to know the persistent nav width.
 */
export function StickyActionBar({
  children,
  hint,
  className = '',
}: {
  children: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('pointer-events-none sticky bottom-0 z-20 -mx-6 mt-8 px-6 lg:-mx-8 lg:px-8', className)}>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-white via-white/85 to-transparent" />
      <div className="pointer-events-auto relative mb-5 flex flex-col gap-3 app-paper px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-[12px] leading-relaxed text-[var(--dw-muted)]">{hint}</div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
      </div>
    </div>
  );
}

/* ── Back-compat wrappers ────────────────────────────────────────────────── */

/** @deprecated Use `Panel`. */
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
    <Panel className={className} padded={padded}>
      {children}
    </Panel>
  );
}

/** @deprecated Use `SectionLabel`. */
export function SurfaceLabel({ children }: { children: React.ReactNode }) {
  return <SectionLabel>{children}</SectionLabel>;
}
