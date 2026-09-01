'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import { CreditBalanceWidget } from '@/features/billing/CreditBalanceWidget';
import { useRazorpayCheckout, type CheckoutPhase, type RazorpayCheckoutPayload } from '@/features/billing/useRazorpayCheckout';

type Pack = {
  id: string;
  name: string;
  creditAmount: number;
  paidTiersOnly: boolean;
  pricePaise: number;
  providerBudgetPaise: number;
};

type PaymentsInfo = {
  mode: 'test' | 'live';
  testAmountOverride: boolean;
  testAmountPaise: number | null;
};

type CreditTransaction = {
  id: string;
  type: string;
  amount_credits: number;
  source: string;
  provider_id?: string | null;
  model_id?: string | null;
  created_at: string;
};

function formatInr(paise: number): string {
  const rupees = paise / 100;
  return rupees.toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function formatCredits(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, '');
}

export default function CreditsApp({ section = 'Credits', embedded = false }: { section?: string; embedded?: boolean }) {
  const router = useRouter();
  const [packs, setPacks] = useState<Pack[]>([]);
  const [planId, setPlanId] = useState('free');
  const [notice, setNotice] = useState('');
  const [busyPackId, setBusyPackId] = useState<string | null>(null);
  const [razorpayConfigured, setRazorpayConfigured] = useState(false);
  const [payments, setPayments] = useState<PaymentsInfo | null>(null);
  const [checkoutPhase, setCheckoutPhase] = useState<CheckoutPhase | null>(null);
  const [balanceKey, setBalanceKey] = useState(0);
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const { start } = useRazorpayCheckout();

  const loadTransactions = async () => {
    const response = await fetch('/api/billing/credits/transactions?limit=20', { cache: 'no-store' }).catch(() => null);
    if (!response?.ok) return;
    const payload = await response.json() as { items?: CreditTransaction[] };
    setTransactions(Array.isArray(payload.items) ? payload.items : []);
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const response = await fetch('/api/billing/plans', { cache: 'no-store' }).catch(() => null);
      if (!cancelled && response?.ok) {
        const payload = await response.json() as { packs?: Pack[]; razorpayConfigured?: boolean; payments?: PaymentsInfo };
        setPacks(Array.isArray(payload.packs) ? payload.packs : []);
        setRazorpayConfigured(Boolean(payload.razorpayConfigured));
        if (payload.payments) setPayments(payload.payments);
      }
      if (!cancelled) await loadTransactions();
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  const buy = async (pack: Pack) => {
    setBusyPackId(pack.id);
    setCheckoutPhase(null);
    setNotice('Preparing payment…');
    try {
      const response = await fetch('/api/billing/credits/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credit_pack_id: pack.id,
          idempotency_key: `pack_${crypto.randomUUID().replace(/-/g, '')}`,
        }),
      });
      const payload = await response.json() as RazorpayCheckoutPayload & { error?: string };
      if (!response.ok) {
        setNotice(payload.error || 'Could not start top-up.');
        return;
      }
      const result = await start(payload, (phase) => {
        setCheckoutPhase(phase);
        if (phase === 'checkout') setNotice('Secure checkout opened');
        if (phase === 'verifying') setNotice('Verifying payment…');
        if (phase === 'pending') setNotice('Payment received. Waiting for secure confirmation…');
      });
      if (result.status === 'cancelled') return setNotice('Payment cancelled');
      if (result.status === 'failed' || result.status === 'pending') return setNotice(result.message);
      setBalanceKey((value) => value + 1);
      await loadTransactions();
      setNotice(`Payment successful. Invoice ${result.invoice.invoice_number} is ready.`);
    } finally {
      setBusyPackId(null);
    }
  };

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent font-sans">
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <WorkspaceCommandHeader section={section} onExit={() => router.push('/')} />
        <div className={`custom-scrollbar flex-1 overflow-y-auto ${embedded ? 'p-6' : 'p-8'}`}>
          <div className="mx-auto max-w-4xl">
            {payments?.testAmountOverride ? (
              <div className="mb-6 border-[3px] border-black bg-white px-4 py-3 shadow-[4px_4px_0_0_#000]">
                <span className="border-2 border-black bg-black px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-white">Test mode</span>
                <strong className="ml-3 text-sm text-black">₹1 sandbox charge</strong>
                <span className="ml-3 text-[12px] text-neutral-600">Sandbox credits are never created in production.</span>
              </div>
            ) : null}

            <div className="mb-8">
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Organization billing</p>
              <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-black">Credits</h2>
              <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-zinc-500">
                Shared credits pay only for DeplAI-managed LLM calls. Token value varies by model; every debit uses the recorded provider pricing and FX version.
              </p>
            </div>

            <CreditBalanceWidget refreshKey={balanceKey} onLoaded={(payload) => setPlanId(payload.plan_id || 'free')} />

            {planId === 'free' ? (
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <button type="button" className="app-btn-ink" onClick={() => router.push('/dashboard/billing')}>Upgrade for managed LLMs</button>
                <button type="button" className="app-btn-paper" onClick={() => router.push('/dashboard/ai/providers')}>Set up BYOK</button>
              </div>
            ) : null}

            <h3 className="mt-10 font-display text-lg text-black">Top-up</h3>
            <p className="mb-5 mt-2 text-[13px] text-zinc-500">Fixed GST-inclusive INR pricing. Top-ups are available to paid organizations and never expire.</p>
            {notice ? <p className="mb-5 border-[3px] border-black bg-white px-4 py-3 text-[13px] text-black shadow-[3px_3px_0_0_#000]" role="status">{notice}</p> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              {packs.map((pack) => {
                const blocked = pack.paidTiersOnly && planId === 'free';
                return (
                  <div key={pack.id} className="app-paper p-5">
                    <p className="font-display text-xl text-black">{pack.name}</p>
                    <p className="mt-2 text-sm text-neutral-600">{formatInr(pack.pricePaise)} incl. GST</p>
                    <p className="mt-1 font-mono text-[11px] text-neutral-500">{pack.creditAmount} credits</p>
                    <button
                      type="button"
                      disabled={blocked || !razorpayConfigured || Boolean(busyPackId)}
                      onClick={() => void buy(pack)}
                      className="app-btn-ink mt-4 w-full disabled:opacity-50"
                    >
                      {blocked ? 'Paid plans only' : !razorpayConfigured ? 'Checkout not configured' : busyPackId === pack.id ? (checkoutPhase === 'verifying' ? 'Verifying…' : 'Preparing…') : payments?.testAmountOverride ? 'Pay ₹1' : 'Buy top-up'}
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="mt-10 flex items-end justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-500">Organization ledger</p>
                <h3 className="mt-2 font-display text-lg text-black">Recent credit activity</h3>
              </div>
              <Link href="/dashboard/ai/usage" className="text-[12px] font-bold underline">Usage breakdown</Link>
            </div>
            <div className="app-paper mt-4 overflow-hidden">
              {transactions.length === 0 ? (
                <p className="p-5 text-[13px] text-neutral-500">No purchases, grants, refunds, reservations, or consumption yet.</p>
              ) : transactions.map((transaction) => (
                <div key={transaction.id} className="grid grid-cols-[1fr_auto] gap-4 border-b-2 border-black px-4 py-3 last:border-b-0">
                  <div>
                    <p className="text-[13px] font-bold text-black">{transaction.type.replaceAll('_', ' ')}</p>
                    <p className="mt-1 font-mono text-[10px] text-neutral-500">{[transaction.provider_id, transaction.model_id, transaction.source].filter(Boolean).join(' · ')}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-[12px] font-bold text-black">{transaction.amount_credits > 0 ? '+' : ''}{formatCredits(transaction.amount_credits)}</p>
                    <p className="mt-1 text-[10px] text-neutral-500">{new Date(transaction.created_at).toLocaleString()}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
