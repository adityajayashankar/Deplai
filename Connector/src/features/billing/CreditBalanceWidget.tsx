'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

export type CreditBalancePayload = {
  paid_remaining: number;
  bonus_remaining: number;
  bonus_unlocked: boolean;
  bonus_expires_at: string | null;
  total: number;
  plan_id?: string;
  plan_name?: string;
};

function formatCountdown(iso: string | null): string | null {
  if (!iso) return null;
  const expires = new Date(iso);
  if (Number.isNaN(expires.getTime())) return null;
  const ms = expires.getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `${days}d ${hours % 24}h left`;
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m left`;
}

function creditStatusCopy(args: {
  onFreePlan: boolean;
  bonusUnlocked: boolean;
  countdown: string | null;
}): string {
  if (args.onFreePlan) {
    return 'Free plan includes 5 credits each month. Checkout does not add more until payment succeeds.';
  }
  if (!args.bonusUnlocked) {
    return 'Bonus credits unlock after paid credits are fully used.';
  }
  if (args.countdown === 'expired') {
    return 'Bonus credits have expired for this month.';
  }
  if (args.countdown) {
    return `Bonus expires ${args.countdown}`;
  }
  return 'Bonus credits are unlocked.';
}

export function CreditBalanceWidget({
  compact = false,
  refreshKey = 0,
  onLoaded,
}: {
  compact?: boolean;
  refreshKey?: number;
  onLoaded?: (payload: CreditBalancePayload) => void;
}) {
  const [balance, setBalance] = useState<CreditBalancePayload | null>(null);
  const [error, setError] = useState('');
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    const load = async () => {
      let lastError = 'Could not load credit balance';
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (cancelled) return;
        const response = await fetch('/api/billing/credits/balance', {
          cache: 'no-store',
          signal: controller.signal,
        }).catch((err: unknown) => {
          if ((err as { name?: string }).name === 'AbortError') return null;
          return null;
        });
        if (cancelled) return;
        if (response?.ok) {
          const payload = await response.json() as CreditBalancePayload;
          setBalance(payload);
          setError('');
          onLoadedRef.current?.(payload);
          return;
        }
        if (response?.status === 401) {
          lastError = 'Sign in to view credit balance';
          break;
        }
        lastError = 'Could not load credit balance';
        await new Promise((resolve) => window.setTimeout(resolve, 400 * (attempt + 1)));
      }
      if (!cancelled) setError(lastError);
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [refreshKey]);

  const countdown = useMemo(
    () => (balance?.bonus_unlocked ? formatCountdown(balance.bonus_expires_at) : null),
    [balance],
  );
  const onFreePlan = (balance?.plan_id || balance?.plan_name || 'free') === 'free';

  return (
    <div className={`app-paper ${compact ? 'p-4' : 'p-5'}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-neutral-500">Credits</p>
        {balance?.plan_name ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-black">{balance.plan_name}</span>
        ) : null}
      </div>
      {error && !balance ? (
        <p className="mt-3 text-[13px] text-neutral-600">{error}</p>
      ) : (
        <>
          <p className="mt-3 font-display text-3xl font-semibold tracking-tight text-black">
            {balance ? balance.total : '—'}
            <span className="ml-2 text-sm font-normal text-neutral-500">total</span>
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="border-2 border-black bg-white px-3 py-2">
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-neutral-500">
                {onFreePlan ? 'Included' : 'Paid'}
              </p>
              <p className="mt-1 text-lg font-medium text-black">{balance?.paid_remaining ?? '—'}</p>
            </div>
            <div className="border-2 border-black bg-white px-3 py-2">
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-neutral-500">Bonus</p>
              <p className="mt-1 text-lg font-medium text-black">{balance?.bonus_remaining ?? '—'}</p>
            </div>
          </div>
          <p className="mt-3 text-[12px] text-neutral-600">
            {balance
              ? creditStatusCopy({
                  onFreePlan,
                  bonusUnlocked: Boolean(balance.bonus_unlocked),
                  countdown,
                })
              : 'Loading credit balance…'}
          </p>
        </>
      )}
    </div>
  );
}
