'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Info } from 'lucide-react';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import { CreditBalanceWidget } from '@/features/billing/CreditBalanceWidget';
import { useRazorpayCheckout, type RazorpayCheckoutPayload } from '@/features/billing/useRazorpayCheckout';

type Plan = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  priceCents: number;
  yearlyPriceCents: number;
  paidCreditAmount: number;
  bonusCreditPercent: number;
  isCustom: boolean;
  isRecommended: boolean;
  bonusTermsCopy: string;
  features: string[];
};

function formatUsdFromCents(cents: number): string {
  const amount = cents / 100;
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export default function SubscriptionApp() {
  const router = useRouter();
  const [yearly, setYearly] = useState(false);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [salesEmail, setSalesEmail] = useState('founders@deplai.tech');
  const [currentPlanId, setCurrentPlanId] = useState<string>('free');
  const [razorpayConfigured, setRazorpayConfigured] = useState(false);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [balanceKey, setBalanceKey] = useState(0);
  const { start } = useRazorpayCheckout();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const plansRes = await fetch('/api/billing/plans', { cache: 'no-store' }).catch(() => null);
      if (cancelled) return;
      if (plansRes?.ok) {
        const payload = await plansRes.json() as { plans?: Plan[]; salesEmail?: string; razorpayConfigured?: boolean };
        setPlans(Array.isArray(payload.plans) ? payload.plans : []);
        if (payload.salesEmail) setSalesEmail(payload.salesEmail);
        setRazorpayConfigured(Boolean(payload.razorpayConfigured));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const checkout = async (plan: Plan) => {
    if (plan.isCustom) {
      window.location.href = `mailto:${salesEmail}`;
      return;
    }
    if (plan.id === 'free') {
      setNotice('You are already on the Free plan, or it is provisioned automatically.');
      return;
    }
    setBusyPlanId(plan.id);
    setNotice('');
    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id: plan.id, cadence: yearly ? 'yearly' : 'monthly' }),
      });
      const payload = await response.json() as RazorpayCheckoutPayload & { error?: string };
      if (response.status === 501 || !response.ok) {
        setNotice(payload.error || 'Checkout is not available yet.');
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
      setCurrentPlanId(plan.id);
      setBalanceKey((value) => value + 1);
      setNotice(`Payment successful. Invoice ${result.invoice.invoice_number} is ready.`);
    } finally {
      setBusyPlanId(null);
    }
  };

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent font-sans">
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <WorkspaceCommandHeader section="Subscription" onExit={() => router.push('/')} />
        <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
          <div className="mx-auto max-w-6xl">
            <div className="mb-8 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Account</p>
                <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-black">Subscription</h2>
                <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-zinc-500">
                  Paid credits match your subscription dollars 1:1. Razorpay charges INR including 18% GST. Bonus credits unlock after paid credits are used.
                </p>
              </div>
              <div className="w-full max-w-sm">
                <CreditBalanceWidget
                  compact
                  refreshKey={balanceKey}
                  onLoaded={(payload) => {
                    if (payload.plan_id) setCurrentPlanId(payload.plan_id);
                  }}
                />
              </div>
            </div>

            <div className="mb-8 flex items-center gap-3">
              <span className={`text-sm font-bold ${yearly ? 'text-neutral-400' : 'text-black'}`}>Monthly</span>
              <button
                type="button"
                onClick={() => setYearly((value) => !value)}
                className={`relative h-7 w-14 border-[3px] border-black p-0.5 ${yearly ? 'bg-black' : 'bg-white'}`}
                aria-label="Toggle yearly billing"
              >
                <span className={`block h-5 w-5 border-2 border-black transition-transform ${yearly ? 'translate-x-7 bg-white' : 'translate-x-0 bg-black'}`} />
              </button>
              <span className={`text-sm font-bold ${yearly ? 'text-black' : 'text-neutral-400'}`}>Yearly</span>
              {yearly ? (
                <span className="ml-1 border-2 border-black px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-black">
                  Save 20%
                </span>
              ) : null}
            </div>

            {notice ? (
              <p className="mb-6 border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-[13px] text-amber-100">
                {notice}
                {notice.startsWith('Payment successful') ? (
                  <>
                    {' '}
                    <a href="/dashboard/invoices" className="underline">View invoices</a>
                  </>
                ) : null}
              </p>
            ) : null}

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {plans.map((plan) => {
                const monthlyCents = plan.priceCents;
                const yearlyMonthlyCents = plan.yearlyPriceCents > 0 ? Math.round(plan.yearlyPriceCents / 12) : monthlyCents;
                const displayCents = plan.isCustom ? null : yearly ? yearlyMonthlyCents : monthlyCents;
                const current = currentPlanId === plan.id;
                const cta = plan.isCustom
                  ? 'Contact sales'
                  : plan.id === 'free'
                    ? current
                      ? 'Current plan'
                      : 'Included'
                    : current
                      ? 'Current plan'
                      : razorpayConfigured
                        ? 'Upgrade'
                        : 'Checkout not configured';

                return (
                  <div
                    key={plan.id}
                    className={`app-paper relative p-6 ${plan.isRecommended ? 'xl:-my-2 xl:py-8' : ''}`}
                  >
                    {plan.isRecommended ? (
                      <span className="absolute -top-3 left-6 border-2 border-black bg-black px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-white">
                        Recommended
                      </span>
                    ) : null}
                    <div className="mb-6">
                      <h3 className="font-display text-2xl text-black">{plan.displayName}</h3>
                      <p className="mt-2 text-[13px] text-neutral-600">{plan.description}</p>
                    </div>
                    <div className="mb-6 border-b-[3px] border-black pb-6">
                      {displayCents === null ? (
                        <p className="font-display text-3xl text-black">Custom</p>
                      ) : (
                        <p className="font-display text-4xl text-black">
                          ${formatUsdFromCents(displayCents)}
                          <span className="ml-2 text-sm font-normal text-neutral-500">/month</span>
                        </p>
                      )}
                    </div>
                    <ul className="mb-6 space-y-3 text-[13px] text-neutral-700">
                      <li className="flex items-start gap-2">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-black" />
                        Includes ${plan.paidCreditAmount}/month paid credits
                      </li>
                      <li className="flex items-start gap-2">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-black" />
                        <span className="flex-1">
                          {plan.bonusCreditPercent > 0
                            ? `Up to ${plan.bonusCreditPercent}% free bonus credits`
                            : 'No bonus credits'}
                        </span>
                        <span className="group relative shrink-0">
                          <Info className="h-3.5 w-3.5 text-neutral-500" aria-label="Bonus credit terms" />
                          <span className="pointer-events-none absolute right-0 top-5 z-20 hidden w-64 border-[3px] border-black bg-white p-3 text-[11px] leading-relaxed text-black shadow-[4px_4px_0_0_#000] group-hover:block">
                            {plan.bonusTermsCopy}
                          </span>
                        </span>
                      </li>
                      {plan.features.map((feature) => (
                        <li key={feature} className="flex items-start gap-2">
                          <Check className="mt-0.5 h-4 w-4 shrink-0 text-black" />
                          {feature}
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      disabled={Boolean(busyPlanId) || current}
                      onClick={() => void checkout(plan)}
                      className={`w-full py-3 text-sm font-bold transition ${
                        plan.isRecommended
                          ? 'border-[3px] border-black bg-black text-white shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none'
                          : 'border-[3px] border-black bg-white text-black shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none'
                      } disabled:opacity-50`}
                    >
                      {busyPlanId === plan.id ? 'Starting checkout…' : cta}
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
