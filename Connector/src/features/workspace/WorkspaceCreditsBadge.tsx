'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Coins } from 'lucide-react';
import { appFocusRing } from '@/features/workspace/theme';
import { formatCreditAmount } from '@/lib/billing/credit-format';

type BalancePayload = {
  available?: number;
  plan_name?: string;
  plan_id?: string;
};

function formatCredits(value: number | undefined): string {
  return formatCreditAmount(value);
}

export function WorkspaceCreditsBadge({ compact = false }: { compact?: boolean }) {
  const [balance, setBalance] = useState<BalancePayload | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const response = await fetch('/api/billing/credits/balance', { cache: 'no-store' }).catch(() => null);
      if (cancelled) return;
      if (!response?.ok) {
        setError(true);
        return;
      }
      setBalance(await response.json() as BalancePayload);
      setError(false);
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const available = balance?.available;
  const planName = balance?.plan_name || 'Free';
  const onFree = (balance?.plan_id || 'free') === 'free';

  return (
    <Link
      href="/dashboard/credits"
      className={`inline-flex items-center gap-2 border-[3px] border-black bg-white text-black shadow-[3px_3px_0_0_#000] transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none ${compact ? 'px-2.5 py-1.5 text-[11px]' : 'px-3 py-1.5 text-[12px]'} font-bold ${appFocusRing}`}
      title="Organization managed-LLM credits"
    >
      <Coins className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} strokeWidth={2.4} />
      <span className="font-mono uppercase tracking-[0.08em]">
        {error ? 'Credits' : `${formatCredits(available)} credits`}
      </span>
      {!compact ? (
        <span className="hidden border-l-2 border-black pl-2 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-neutral-600 lg:inline">
          {onFree && available === 0 ? 'Upgrade' : planName}
        </span>
      ) : null}
    </Link>
  );
}

export function WorkspaceCreditsSlot() {
  return (
    <div className="pointer-events-none absolute right-4 top-2 z-[70] hidden sm:right-6 md:block">
      <div className="pointer-events-auto">
        <WorkspaceCreditsBadge />
      </div>
    </div>
  );
}
