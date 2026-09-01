'use client';

import React, { useEffect, useRef, useState } from 'react';

export type CreditBalancePayload = {
  available: number;
  reserved: number;
  total: number;
  lifetime_granted: number;
  lifetime_consumed: number;
  never_expires: boolean;
  organization_id: string;
  status: 'ACTIVE' | 'DEBT' | 'FROZEN';
  plan_id?: string;
  plan_name?: string;
};

function displayCredits(value: number | undefined): string {
  if (value == null) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
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
      let lastError = 'Could not load organization credit balance';
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (cancelled) return;
        const response = await fetch('/api/billing/credits/balance', {
          cache: 'no-store',
          signal: controller.signal,
        }).catch(() => null);
        if (cancelled) return;
        if (response?.ok) {
          const payload = await response.json() as CreditBalancePayload;
          setBalance(payload);
          setError('');
          onLoadedRef.current?.(payload);
          return;
        }
        if (response?.status === 401) {
          lastError = 'Sign in to view organization credits';
          break;
        }
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

  const onFreePlan = (balance?.plan_id || balance?.plan_name || 'free') === 'free';

  return (
    <div className={`app-paper ${compact ? 'p-4' : 'p-5'}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-neutral-500">Organization credits</p>
        {balance?.plan_name ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-black">{balance.plan_name}</span>
        ) : null}
      </div>
      {error && !balance ? (
        <p className="mt-3 text-[13px] text-neutral-600">{error}</p>
      ) : (
        <>
          <p className="mt-3 font-display text-3xl font-semibold tracking-tight text-black">
            {displayCredits(balance?.available)}
            <span className="ml-2 text-sm font-normal text-neutral-500">available</span>
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="border-2 border-black bg-white px-3 py-2">
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-neutral-500">Reserved</p>
              <p className="mt-1 text-lg font-medium text-black">{displayCredits(balance?.reserved)}</p>
            </div>
            <div className="border-2 border-black bg-white px-3 py-2">
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-neutral-500">Lifetime used</p>
              <p className="mt-1 text-lg font-medium text-black">{displayCredits(balance?.lifetime_consumed)}</p>
            </div>
          </div>
          <p className="mt-3 text-[12px] text-neutral-600">
            {balance
              ? onFreePlan && balance.available === 0
                ? 'Free organizations receive 0 managed credits. Upgrade or connect a BYOK provider.'
                : 'Credits are shared by this organization and never expire.'
              : 'Loading organization credit balance…'}
          </p>
        </>
      )}
    </div>
  );
}
