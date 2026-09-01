'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check } from 'lucide-react';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import { CreditBalanceWidget } from '@/features/billing/CreditBalanceWidget';
import { useRazorpayCheckout, type CheckoutPhase, type RazorpayCheckoutPayload } from '@/features/billing/useRazorpayCheckout';

type Plan = {
  id: string;
  displayName: string;
  description: string;
  pricePaise: number;
  yearlyPricePaise: number;
  paidCreditAmount: number;
  annualCreditAmount: number;
  providerBudgetPaise: number;
  isCustom: boolean;
  isRecommended: boolean;
  features: string[];
};

type PaymentsInfo = {
  enabled: boolean;
  mode: 'test' | 'live';
  testAmountOverride: boolean;
  testAmountPaise: number | null;
};

type ReferralInfo = {
  eligible: boolean;
  discountPercent: number;
  headline: string;
  refereeBenefit: string;
} | null;

function formatInr(paise: number): string {
  const rupees = paise / 100;
  return rupees.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function isPerCreditRateFeature(feature: string): boolean {
  return /(?:\d+\s*credit\s*=|per\s+credit|provider\s+(?:usage|value))/i.test(feature);
}

export default function SubscriptionApp({ section = 'Billing', embedded = false }: { section?: string; embedded?: boolean }) {
  const router = useRouter();
  const [yearly, setYearly] = useState(false);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [salesEmail, setSalesEmail] = useState('founders@deplai.tech');
  const [currentPlanId, setCurrentPlanId] = useState('free');
  const [razorpayConfigured, setRazorpayConfigured] = useState(false);
  const [payments, setPayments] = useState<PaymentsInfo | null>(null);
  const [referral, setReferral] = useState<ReferralInfo>(null);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  const [checkoutPhase, setCheckoutPhase] = useState<CheckoutPhase | null>(null);
  const [notice, setNotice] = useState('');
  const [balanceKey, setBalanceKey] = useState(0);
  const { start } = useRazorpayCheckout();

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/billing/plans', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok || cancelled) return;
      const payload = await response.json() as {
        plans?: Plan[];
        salesEmail?: string;
        razorpayConfigured?: boolean;
        payments?: PaymentsInfo;
        referral?: ReferralInfo;
      };
      if (cancelled) return;
      setPlans(Array.isArray(payload.plans) ? payload.plans : []);
      if (payload.salesEmail) setSalesEmail(payload.salesEmail);
      setRazorpayConfigured(Boolean(payload.razorpayConfigured));
      if (payload.payments) setPayments(payload.payments);
      if (payload.referral) setReferral(payload.referral);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const checkout = async (plan: Plan) => {
    if (plan.isCustom) return void (window.location.href = `mailto:${salesEmail}`);
    if (plan.id === 'free') return setNotice('Free organizations receive 0 managed credits. Connect BYOK or choose a paid plan.');
    setBusyPlanId(plan.id);
    setCheckoutPhase(null);
    setNotice('Preparing payment…');
    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan_id: plan.id,
          cadence: yearly ? 'yearly' : 'monthly',
          idempotency_key: `plan_${crypto.randomUUID().replace(/-/g, '')}`,
        }),
      });
      const payload = await response.json() as RazorpayCheckoutPayload & { error?: string };
      if (!response.ok) return setNotice(payload.error || 'Checkout is not available.');
      const result = await start(payload, (phase) => {
        setCheckoutPhase(phase);
        if (phase === 'checkout') setNotice('Secure checkout opened');
        if (phase === 'verifying') setNotice('Verifying payment…');
        if (phase === 'pending') setNotice('Payment received. Waiting for confirmation…');
      });
      if (result.status === 'cancelled') return setNotice('Payment cancelled');
      if (result.status === 'failed' || result.status === 'pending') return setNotice(result.message);
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
        <WorkspaceCommandHeader section={section} onExit={() => router.push('/')} />
        <div className={`custom-scrollbar flex-1 overflow-y-auto ${embedded ? 'p-6' : 'p-8'}`}>
          <div className="mx-auto max-w-6xl">
            {payments?.testAmountOverride ? (
              <div className="mb-6 border-[3px] border-black bg-white px-4 py-3 shadow-[4px_4px_0_0_#000]">
                <span className="border-2 border-black bg-black px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-white">Test mode</span>
                <strong className="ml-3 text-sm text-black">₹1 sandbox charge</strong>
                <span className="ml-3 text-[12px] text-neutral-600">Catalog prices remain authoritative; sandbox credits cannot be created in production.</span>
              </div>
            ) : null}

            {referral?.eligible ? (
              <div className="mb-6 border-[3px] border-emerald-700 bg-emerald-50 px-4 py-3 shadow-[4px_4px_0_0_#047857]">
                <strong className="text-sm text-emerald-900">Referral discount active</strong>
                <span className="ml-2 text-[12px] text-emerald-800">
                  {referral.refereeBenefit} on your first paid plan checkout.
                </span>
              </div>
            ) : null}

            <div className="mb-8 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Organization billing</p>
                <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-black">Subscription</h2>
                <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-zinc-500">Fixed INR prices include GST. Managed-LLM credits are shared by the organization and never expire.</p>
              </div>
              <div className="w-full max-w-sm">
                <CreditBalanceWidget compact refreshKey={balanceKey} onLoaded={(payload) => setCurrentPlanId(payload.plan_id || 'free')} />
              </div>
            </div>

            <div className="mb-8 flex items-center gap-3">
              <span className={`text-sm font-bold ${yearly ? 'text-neutral-400' : 'text-black'}`}>Monthly</span>
              <button type="button" onClick={() => setYearly((value) => !value)} className={`relative h-7 w-14 border-[3px] border-black p-0.5 ${yearly ? 'bg-black' : 'bg-white'}`} aria-label="Toggle yearly billing">
                <span className={`block h-5 w-5 border-2 border-black transition-transform ${yearly ? 'translate-x-7 bg-white' : 'translate-x-0 bg-black'}`} />
              </button>
              <span className={`text-sm font-bold ${yearly ? 'text-black' : 'text-neutral-400'}`}>Yearly</span>
              {yearly ? <span className="border-2 border-black px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest">Save ~10%</span> : null}
            </div>

            {notice ? <p className="mb-6 border-[3px] border-black bg-white px-4 py-3 text-[13px] text-black shadow-[3px_3px_0_0_#000]" role="status">{notice}</p> : null}

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {plans.map((plan) => {
                const totalPaise = yearly && plan.yearlyPricePaise > 0 ? plan.yearlyPricePaise : plan.pricePaise;
                const current = currentPlanId === plan.id;
                const credits = yearly ? plan.annualCreditAmount : plan.paidCreditAmount;
                return (
                  <div key={plan.id} className={`app-paper relative p-6 ${plan.isRecommended ? 'xl:-my-2 xl:py-8' : ''}`}>
                    {plan.isRecommended ? <span className="absolute -top-3 left-6 border-2 border-black bg-black px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-white">Recommended</span> : null}
                    <h3 className="font-display text-2xl text-black">{plan.displayName}</h3>
                    <p className="mt-2 min-h-10 text-[13px] text-neutral-600">{plan.description}</p>
                    <div className="my-6 border-b-[3px] border-black pb-6">
                      <p className="font-display text-4xl text-black">{plan.isCustom ? 'Custom' : `₹${formatInr(totalPaise)}`}</p>
                      {!plan.isCustom ? <p className="mt-2 text-[12px] font-semibold text-neutral-600">GST-inclusive · {yearly ? 'billed yearly' : 'billed monthly'}</p> : null}
                    </div>
                    <ul className="mb-6 space-y-3 text-[13px] text-neutral-700">
                      <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0" />{credits} managed credits {yearly ? 'per year, released monthly' : 'per month'}</li>
                      <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0" />Credits never expire</li>
                      {plan.features.filter((feature) => !isPerCreditRateFeature(feature)).map((feature) => (
                        <li key={feature} className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0" />{feature}</li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      disabled={Boolean(busyPlanId) || current || (!plan.isCustom && plan.id !== 'free' && !razorpayConfigured)}
                      onClick={() => void checkout(plan)}
                      className={`${plan.isRecommended ? 'app-btn-ink' : 'app-btn-paper'} w-full disabled:opacity-50`}
                    >
                      {busyPlanId === plan.id ? (checkoutPhase === 'verifying' ? 'Verifying…' : 'Preparing…') : current ? 'Current plan' : plan.isCustom ? 'Contact sales' : plan.id === 'free' ? 'Included' : payments?.testAmountOverride ? 'Pay ₹1' : 'Choose plan'}
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
