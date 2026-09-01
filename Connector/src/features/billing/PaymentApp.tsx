'use client';

import React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import SubscriptionApp from '@/features/billing/SubscriptionApp';
import CreditsApp from '@/features/billing/CreditsApp';

type PaymentView = 'plans' | 'credits';

function resolveView(raw: string | null): PaymentView {
  return raw === 'credits' ? 'credits' : 'plans';
}

export default function PaymentApp() {
  const searchParams = useSearchParams();
  const view = resolveView(searchParams.get('view'));

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="border-b-[3px] border-black bg-white px-6 py-3">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
          <span className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Billing</span>
          <div className="flex items-center border-[3px] border-black">
            <Link
              href="/dashboard/billing"
              className={`px-3 py-1.5 text-[12px] font-bold ${view === 'plans' ? 'bg-black text-white' : 'bg-white text-black hover:bg-neutral-100'}`}
            >
              Plans
            </Link>
            <Link
              href="/dashboard/billing?view=credits"
              className={`px-3 py-1.5 text-[12px] font-bold ${view === 'credits' ? 'bg-black text-white' : 'bg-white text-black hover:bg-neutral-100'}`}
            >
              Credit packs
            </Link>
          </div>
          <span className="text-[12px] text-neutral-500">
            Secure checkout powered by Razorpay
          </span>
        </div>
      </div>
      {view === 'credits' ? (
        <CreditsApp section="Billing & payments" embedded />
      ) : (
        <SubscriptionApp section="Billing & payments" embedded />
      )}
    </div>
  );
}
