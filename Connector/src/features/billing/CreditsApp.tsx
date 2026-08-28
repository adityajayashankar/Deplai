'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import { CreditBalanceWidget } from '@/features/billing/CreditBalanceWidget';
import { useRazorpayCheckout, type RazorpayCheckoutPayload } from '@/features/billing/useRazorpayCheckout';

type Pack = {
  id: string;
  name: string;
  creditAmount: number;
  priceCents: number;
  paidTiersOnly: boolean;
};

function formatUsdFromCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export default function CreditsApp() {
  const router = useRouter();
  const [packs, setPacks] = useState<Pack[]>([]);
  const [planId, setPlanId] = useState('free');
  const [notice, setNotice] = useState('');
  const [busyPackId, setBusyPackId] = useState<string | null>(null);
  const [razorpayConfigured, setRazorpayConfigured] = useState(false);
  const [balanceKey, setBalanceKey] = useState(0);
  const { start } = useRazorpayCheckout();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const plansRes = await fetch('/api/billing/plans', { cache: 'no-store' }).catch(() => null);
      if (cancelled) return;
      if (plansRes?.ok) {
        const payload = await plansRes.json() as { packs?: Pack[]; razorpayConfigured?: boolean };
        setPacks(Array.isArray(payload.packs) ? payload.packs : []);
        setRazorpayConfigured(Boolean(payload.razorpayConfigured));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const buy = async (pack: Pack) => {
    setBusyPackId(pack.id);
    setNotice('');
    try {
      const response = await fetch('/api/billing/credits/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credit_pack_id: pack.id }),
      });
      const payload = await response.json() as RazorpayCheckoutPayload & { error?: string };
      if (!response.ok) {
        setNotice(payload.error || 'Could not start top-up.');
        return;
      }
      const result = await start(payload);
      if (result.status === 'cancelled') {
        setNotice('Payment cancelled');
        return;
      }
      if (result.status === 'failed') {
        setNotice(result.message);
        return;
      }
      setBalanceKey((value) => value + 1);
      setNotice(`Payment successful. Invoice ${result.invoice.invoice_number} is ready.`);
    } finally {
      setBusyPackId(null);
    }
  };

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent font-sans">
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <WorkspaceCommandHeader section="Credits" onExit={() => router.push('/')} />
        <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
          <div className="mx-auto max-w-4xl">
            <div className="mb-8">
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Account</p>
              <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-black">Credits</h2>
              <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-zinc-500">
                Paid credits are used first. Bonus credits unlock after that allotment is gone and expire at the end of the calendar month.
              </p>
            </div>

            <CreditBalanceWidget
              refreshKey={balanceKey}
              onLoaded={(payload) => {
                if (payload.plan_id) setPlanId(payload.plan_id);
              }}
            />

            <h3 className="mt-10 font-display text-lg text-black">Top-up packs</h3>
            <p className="mt-2 mb-5 text-[13px] text-zinc-500">
              One-off packs are priced slightly above the subscription rate. They are available on paid plans only.
            </p>
            {notice ? (
              <p className="mb-5 border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-[13px] text-amber-100">
                {notice}
                {notice.startsWith('Payment successful') ? (
                  <>
                    {' '}
                    <a href="/dashboard/invoices" className="underline">View invoices</a>
                  </>
                ) : null}
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-3">
              {packs.map((pack) => {
                const blocked = pack.paidTiersOnly && planId === 'free';
                const unconfigured = !razorpayConfigured;
                return (
                  <div key={pack.id} className="app-paper p-5">
                    <p className="font-display text-xl text-black">{pack.name}</p>
                    <p className="mt-2 text-sm text-neutral-600">{formatUsdFromCents(pack.priceCents)}</p>
                    <p className="mt-1 font-mono text-[11px] text-neutral-500">
                      ${(pack.priceCents / 100 / pack.creditAmount).toFixed(2)} per credit · charged in INR + GST
                    </p>
                    <button
                      type="button"
                      disabled={blocked || unconfigured || Boolean(busyPackId)}
                      onClick={() => void buy(pack)}
                      className="mt-4 w-full border-[3px] border-black bg-black py-2 text-sm font-bold text-white shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:opacity-50"
                    >
                      {blocked ? 'Paid plans only' : unconfigured ? 'Checkout not configured' : busyPackId === pack.id ? 'Starting…' : 'Buy pack'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
