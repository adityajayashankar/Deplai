"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Check, Info } from "lucide-react";

const signUpHref = "/auth/signup";
const SALES_EMAIL = "founders@deplai.tech";

type ApiPlan = {
  id: string;
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

const FALLBACK_PLANS: ApiPlan[] = [
  {
    id: "free",
    displayName: "Free",
    description: "For exploring secure agentic deployment",
    priceCents: 0,
    yearlyPriceCents: 0,
    paidCreditAmount: 5,
    bonusCreditPercent: 0,
    isCustom: false,
    isRecommended: false,
    bonusTermsCopy: "The Free plan includes a small monthly allotment of paid credits. Unused paid credits do not roll over, and this plan never receives bonus credits.",
    features: ["1 project", "Repo analysis agent", "Basic security scan", "Community support"],
  },
  {
    id: "starter_20",
    displayName: "Starter",
    description: "For individuals shipping production workloads",
    priceCents: 2000,
    yearlyPriceCents: 19200,
    paidCreditAmount: 20,
    bonusCreditPercent: 25,
    isCustom: false,
    isRecommended: false,
    bonusTermsCopy: "Paid credits are granted at the start of each billing cycle. After you use every paid credit, up to 25% extra bonus credits unlock. Bonus credits expire at the end of the calendar month they were unlocked and never roll over.",
    features: ["Unlimited projects", "Security scanning", "Terraform generation", "Email support"],
  },
  {
    id: "pro_50",
    displayName: "Pro",
    description: "For growing teams and platforms",
    priceCents: 5000,
    yearlyPriceCents: 48000,
    paidCreditAmount: 50,
    bonusCreditPercent: 40,
    isCustom: false,
    isRecommended: true,
    bonusTermsCopy: "Paid credits are granted at the start of each billing cycle. After you use every paid credit, up to 40% extra bonus credits unlock. Bonus credits expire at the end of the calendar month they were unlocked and never roll over.",
    features: ["Everything in Starter", "Frontend customizations", "Vulnerability fixes", "Priority support"],
  },
  {
    id: "enterprise",
    displayName: "Enterprise",
    description: "For large-scale operations",
    priceCents: 0,
    yearlyPriceCents: 0,
    paidCreditAmount: 0,
    bonusCreditPercent: 0,
    isCustom: true,
    isRecommended: false,
    bonusTermsCopy: "Enterprise credits are provisioned from your contract. Contact sales to set allotments, seats, bonus terms, and rollover.",
    features: ["Everything in Pro", "Custom contracts", "24/7 dedicated support", "SLA and security review"],
  },
];

function formatUsdFromCents(cents: number) {
  const amount = cents / 100;
  return amount.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function PricingSection() {
  const [isAnnual, setIsAnnual] = useState(true);
  const [plans, setPlans] = useState<ApiPlan[]>(FALLBACK_PLANS);
  const [salesEmail, setSalesEmail] = useState(SALES_EMAIL);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const response = await fetch("/api/billing/plans", { cache: "no-store" }).catch(() => null);
      if (!response?.ok || cancelled) return;
      const payload = await response.json() as { plans?: ApiPlan[]; salesEmail?: string };
      if (Array.isArray(payload.plans) && payload.plans.length > 0) {
        setPlans(payload.plans);
      }
      if (payload.salesEmail) setSalesEmail(payload.salesEmail);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section id="pricing" className="relative py-32 lg:py-40 border-t border-foreground/10">
      <div className="max-w-7xl mx-auto px-6 lg:px-12">
        <div className="max-w-3xl mb-20">
          <span className="font-mono text-xs tracking-widest text-muted-foreground uppercase block mb-6">
            Pricing
          </span>
          <h2 className="font-display text-5xl md:text-6xl lg:text-7xl tracking-tight text-foreground mb-6">
            Simple, transparent
            <br />
            <span className="text-stroke">pricing</span>
          </h2>
          <p className="text-lg text-muted-foreground max-w-xl">
            Paid credits convert 1:1 from your subscription. Bonus credits unlock after paid credits are used and expire at calendar month-end.
          </p>
        </div>

        <div className="flex items-center gap-4 mb-16">
          <span
            className={`text-sm transition-colors ${
              !isAnnual ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            Monthly
          </span>
          <button
            onClick={() => setIsAnnual(!isAnnual)}
            className="relative w-14 h-7 bg-foreground/10 rounded-full p-1 transition-colors hover:bg-foreground/20"
          >
            <div
              className={`w-5 h-5 bg-foreground rounded-full transition-transform duration-300 ${
                isAnnual ? "translate-x-7" : "translate-x-0"
              }`}
            />
          </button>
          <span
            className={`text-sm transition-colors ${
              isAnnual ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            Annual
          </span>
          {isAnnual && (
            <span className="ml-2 px-2 py-1 bg-foreground text-primary-foreground text-xs font-mono">
              Save 20%
            </span>
          )}
        </div>

        <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-px bg-foreground/10">
          {plans.map((plan, idx) => {
            const monthlyCents = plan.priceCents;
            const yearlyMonthlyCents = plan.yearlyPriceCents > 0
              ? Math.round(plan.yearlyPriceCents / 12)
              : monthlyCents;
            const displayCents = plan.isCustom ? null : isAnnual ? yearlyMonthlyCents : monthlyCents;
            const href = plan.isCustom ? `mailto:${salesEmail}` : signUpHref;
            const cta = plan.isCustom ? "Contact sales" : plan.id === "free" ? "Start free" : "Start trial";

            return (
              <div
                key={plan.id}
                className={`relative p-8 lg:p-10 bg-background ${
                  plan.isRecommended ? "xl:-my-4 xl:py-12 border-2 border-foreground" : ""
                }`}
              >
                {plan.isRecommended && (
                  <span className="absolute -top-3 left-8 px-3 py-1 bg-foreground text-primary-foreground text-xs font-mono uppercase tracking-widest">
                    Recommended
                  </span>
                )}

                <div className="mb-8">
                  <span className="font-mono text-xs text-muted-foreground">
                    {String(idx + 1).padStart(2, "0")}
                  </span>
                  <h3 className="font-display text-3xl text-foreground mt-2">{plan.displayName}</h3>
                  <p className="text-sm text-muted-foreground mt-2">{plan.description}</p>
                </div>

                <div className="mb-8 pb-8 border-b border-foreground/10">
                  {displayCents !== null ? (
                    <div>
                      <div className="flex items-baseline gap-2">
                        <span className="font-display text-5xl text-foreground">
                          ${formatUsdFromCents(displayCents)}
                        </span>
                        <span className="text-muted-foreground">/month</span>
                      </div>
                      {isAnnual && monthlyCents > 0 && (
                        <p className="text-sm text-muted-foreground mt-2">
                          billed ${formatUsdFromCents(plan.yearlyPriceCents)}/year · 20% off
                        </p>
                      )}
                    </div>
                  ) : (
                    <span className="font-display text-4xl text-foreground">Custom</span>
                  )}
                </div>

                <ul className="space-y-4 mb-10">
                  <li className="flex items-start gap-3">
                    <Check className="w-4 h-4 text-foreground mt-0.5 shrink-0" />
                    <span className="text-sm text-muted-foreground">
                      Includes ${plan.paidCreditAmount}/month paid credits
                    </span>
                  </li>
                  <li className="flex items-start gap-3">
                    <Check className="w-4 h-4 text-foreground mt-0.5 shrink-0" />
                    <span className="text-sm text-muted-foreground flex-1">
                      {plan.bonusCreditPercent > 0
                        ? `Up to ${plan.bonusCreditPercent}% free bonus credits`
                        : "No bonus credits"}
                    </span>
                    <span className="group relative shrink-0">
                      <Info className="w-3.5 h-3.5 text-muted-foreground" aria-label="Bonus credit terms" />
                      <span className="pointer-events-none absolute right-0 top-5 z-20 hidden w-64 border border-foreground/15 bg-background p-3 text-[11px] leading-relaxed text-muted-foreground group-hover:block">
                        {plan.bonusTermsCopy}
                      </span>
                    </span>
                  </li>
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-3">
                      <Check className="w-4 h-4 text-foreground mt-0.5 shrink-0" />
                      <span className="text-sm text-muted-foreground">{feature}</span>
                    </li>
                  ))}
                </ul>

                <a
                  href={href}
                  className={`w-full py-4 flex items-center justify-center gap-2 text-sm font-medium transition-all group ${
                    plan.isRecommended
                      ? "bg-foreground text-primary-foreground hover:bg-foreground/90"
                      : "border border-foreground/20 text-foreground hover:border-foreground hover:bg-foreground/5"
                  }`}
                >
                  {cta}
                  <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                </a>
              </div>
            );
          })}
        </div>

        <p className="mt-12 text-center text-sm text-muted-foreground">
          All plans include automatic updates, HTTPS, and DDoS protection.
        </p>
      </div>
    </section>
  );
}
