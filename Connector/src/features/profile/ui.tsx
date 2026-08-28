'use client';

import React, { useEffect, useId, useRef } from 'react';
import { Loader2, X } from 'lucide-react';

import { appFocusRing, appInput, appPaper } from '@/features/workspace/theme';

export const focusRing = appFocusRing;

export function ProfileCard({
  children,
  className = '',
  danger = false,
}: {
  children: React.ReactNode;
  className?: string;
  danger?: boolean;
}) {
  return (
    <section
      className={`${appPaper} ${
        danger ? 'border-rose-600 bg-rose-50' : ''
      } ${className}`}
    >
      {children}
    </section>
  );
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const errorId = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-neutral-500">
        {label}
      </label>
      {children}
      {hint && !error ? <p className="text-[12px] text-zinc-500">{hint}</p> : null}
      {error ? (
        <p id={errorId} role="alert" className="text-[12px] text-rose-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const inputClass = appInput;

export function PrimaryButton({
  children,
  onClick,
  disabled,
  loading,
  type = 'button',
  className = '',
  variant = 'default',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  type?: 'button' | 'submit';
  className?: string;
  variant?: 'default' | 'danger' | 'ghost' | 'white';
}) {
  const styles = {
    default: 'border-[3px] border-black bg-black text-white shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none',
    danger: 'border-[3px] border-black bg-rose-600 text-white shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none',
    ghost: 'border-[3px] border-black bg-white text-black shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none',
    white: 'border-[3px] border-black bg-white text-black shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none',
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className={`inline-flex min-h-10 items-center justify-center gap-2 px-4 py-2 text-[13px] font-medium transition duration-150 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50 ${focusRing} ${styles} ${className}`}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-14 border-[3px] border-black p-0.5 transition duration-150 motion-reduce:transition-none disabled:opacity-50 ${focusRing} ${
        checked ? 'bg-black' : 'bg-white'
      }`}
    >
      <span
        className={`block h-5 w-5 border-2 border-black transition-transform duration-150 motion-reduce:transition-none ${
          checked ? 'translate-x-7 bg-white' : 'translate-x-0 bg-black'
        }`}
      />
    </button>
  );
}

export function Segmented({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  options: Array<{ id: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <div
      role="tablist"
      aria-label="Billing cadence"
      className="inline-flex border-[3px] border-black bg-white p-1"
    >
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={disabled}
            onClick={() => onChange(option.id)}
            className={`min-h-9 px-4 py-1.5 text-[13px] font-bold transition duration-200 motion-reduce:transition-none ${focusRing} ${
              selected ? 'bg-black text-white' : 'text-black hover:bg-black/10'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse bg-black/10 ${className}`} />;
}

export function InlineError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="border-[3px] border-rose-600 bg-rose-50 px-4 py-3 text-[13px] text-rose-800">
      <p>{message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry} className={`mt-2 text-[12px] font-medium underline ${focusRing}`}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Dialog({
  open,
  title,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () => Array.from(
      panel?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) || [],
    ).filter((node) => !node.hasAttribute('disabled'));
    window.setTimeout(() => focusables()[0]?.focus(), 0);

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = focusables();
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-dialog-title"
        className={`max-h-[90vh] w-full overflow-y-auto border-[3px] border-black bg-white p-5 text-black shadow-[8px_8px_0_0_#000] ${
          wide ? 'max-w-lg' : 'max-w-md'
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id="profile-dialog-title" className="font-display text-lg font-bold text-black">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className={`p-1 text-neutral-500 hover:text-black ${focusRing}`}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export type ToastTone = 'success' | 'error';

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Array<{ id: string; message: string; tone: ToastTone }>;
  onDismiss: (id: string) => void;
}) {
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(100%-2rem,22rem)] flex-col gap-2" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-start justify-between gap-3 border-[3px] border-black px-4 py-3 text-[13px] font-bold shadow-[4px_4px_0_0_#000] ${
            toast.tone === 'success'
              ? 'bg-white text-black'
              : 'bg-rose-600 text-white'
          }`}
          role="status"
        >
          <span>{toast.message}</span>
          <button type="button" className="text-current/70" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
