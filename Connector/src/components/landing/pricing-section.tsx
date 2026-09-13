"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Check, Info } from "lucide-react";

const signUpHref = "/auth/signup";

type ApiPlan = {
  id: string;
  displayName: string;
  description: string;
  pricePaise: number;
  yearlyPricePaise: number;
  paidCreditAmount: number;
  bonusCreditPercent: number;
  isCustom: boolean;
  isAvailable: boolean;
  availabilityMessage: string | null;
  isRecommended: boolean;
  bonusTermsCopy: string;
  features: string[];
};

const FALLBACK_PLANS: ApiPlan[] = [
  {
    id: "free",
    displayName: "Free",
    description: "For exploring secure agentic deployment",
    pricePaise: 0,
    yearlyPricePaise: 0,
    paidCreditAmount: 0,
    bonusCreditPercent: 0,
    isCustom: false,
    isAvailable: true,
    availabilityMessage: null,
    isRecommended: false,
    bonusTermsCopy: "Free organizations receive no managed credits. BYOK remains available.",
    features: ["1 project", "BYOK model access", "Basic security scan", "Community support"],
  },
  {
    id: "starter_20",
    displayName: "Starter",
    description: "Go from repo connect to approved AWS deploy without stitching scanners, agents, and Terraform yourself",
    pricePaise: 49_900,
    yearlyPricePaise: 539_900,
    paidCreditAmount: 25,
    bonusCreditPercent: 0,
    isCustom: false,
    isAvailable: true,
    availabilityMessage: null,
    isRecommended: false,
    bonusTermsCopy: "Managed-LLM credits never expire. Annual credits are released monthly.",
    features: [
      "Security Agent: SAST, dependency scans, and AI remediation",
      "Terraform generation with plan review before every apply",
      "DeplAI-managed LLMs — no vendor API keys required",
      "Unlimited projects and deployment pipelines",
      "Organization workspace to share with collaborators",
      "Email support when something blocks your release",
    ],
  },
  {
    id: "pro_50",
    displayName: "Pro",
    description: "For teams that need design iteration, fix velocity, and deploy confidence in one place",
    pricePaise: 99_900,
    yearlyPricePaise: 1_079_900,
    paidCreditAmount: 62.5,
    bonusCreditPercent: 0,
    isCustom: false,
    isAvailable: true,
    availabilityMessage: null,
    isRecommended: true,
    bonusTermsCopy: "Managed-LLM credits never expire. Annual credits are released monthly.",
    features: [
      "Everything in Starter",
      "UI/UX customizer for safe, frontend-only design changes",
      "Guided vulnerability fixes with human review gates",
      "Traffic-aware AWS cost estimates before infrastructure applies",
      "Priority support for production incidents",
      "Organization roles, teams, and shared billing context",
    ],
  },
  {
    id: "enterprise",
    displayName: "Enterprise",
    description: "For organizations that need governance, procurement fit, and predictable capacity at scale",
    pricePaise: 0,
    yearlyPricePaise: 0,
    paidCreditAmount: 0,
    bonusCreditPercent: 0,
    isCustom: true,
    isAvailable: false,
    availabilityMessage: "Enterprise subscriptions are coming soon.",
    isRecommended: false,
    bonusTermsCopy: "Credits and seats are provisioned from your contract. We align allotments to how your teams actually ship.",
    features: [
      "Everything in Pro",
      "Pooled credits across seats and business units",
      "Custom contracts, GST invoicing, and procurement workflows",
      "Security policies, audit logs, and deployment evidence gates",
      "Dedicated support channel with agreed response times",
      "Onboarding and architecture review with the DeplAI team",
    ],
  },
];

function formatInrFromPaise(paise: number) {
  const amount = paise / 100;
  return amount.toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function PricingSection() {
  const [isAnnual, setIsAnnual] = useState(true);
  const [plans, setPlans] = useState<ApiPlan[]>(FALLBACK_PLANS);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const response = await fetch("/api/billing/plans", { cache: "no-store" }).catch(() => null);
      if (!response?.ok || cancelled) return;
      const payload = await response.json() as { plans?: ApiPlan[] };
      if (Array.isArray(payload.plans) && payload.plans.length > 0) {
        setPlans(payload.plans);
      }
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
            Clear, GST-inclusive INR pricing. Managed credits are shared by your organization and never expire.
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
              Save ~10%
            </span>
          )}
        </div>

        <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-px bg-foreground/10">
          {plans.map((plan, idx) => {
            const monthlyPaise = plan.pricePaise;
            const yearlyMonthlyPaise = plan.yearlyPricePaise > 0
              ? plan.yearlyPricePaise / 12
              : monthlyPaise;
            const unavailable = !plan.isAvailable;
            const displayPaise = unavailable || plan.isCustom ? null : isAnnual ? yearlyMonthlyPaise : monthlyPaise;
            const cta = unavailable ? "Coming soon" : plan.id === "free" ? "Start free" : "Start trial";
            const actionClassName = `w-full py-4 flex items-center justify-center gap-2 text-sm font-medium transition-all group ${
              plan.isRecommended
                ? "bg-foreground text-primary-foreground hover:bg-foreground/90"
                : "border border-foreground/20 text-foreground hover:border-foreground hover:bg-foreground/5"
            }`;

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
                  {displayPaise !== null ? (
                    <div>
                      <div className="flex items-baseline gap-2">
                        <span className="font-display text-5xl text-foreground">
                          ₹{formatInrFromPaise(displayPaise)}
                        </span>
                        <span className="text-muted-foreground">/month</span>
                      </div>
                      {isAnnual && monthlyPaise > 0 && (
                        <p className="text-sm text-muted-foreground mt-2">
                          billed ₹{formatInrFromPaise(plan.yearlyPricePaise)}/year · 10% off
                        </p>
                      )}
                    </div>
                  ) : (
                    <span className="font-display text-4xl text-foreground">{unavailable ? "Coming soon" : "Custom"}</span>
                  )}
                </div>

                <ul className="space-y-4 mb-10">
                  {unavailable ? (
                    <li className="flex items-start gap-3">
                      <Check className="w-4 h-4 text-foreground mt-0.5 shrink-0" />
                      <span className="text-sm text-muted-foreground">{plan.availabilityMessage || "This plan is coming soon."}</span>
                    </li>
                  ) : (
                    <>
                      <li className="flex items-start gap-3">
                        <Check className="w-4 h-4 text-foreground mt-0.5 shrink-0" />
                        <span className="text-sm text-muted-foreground">Includes {plan.paidCreditAmount} managed credits/month</span>
                      </li>
                      <li className="flex items-start gap-3">
                        <Check className="w-4 h-4 text-foreground mt-0.5 shrink-0" />
                        <span className="text-sm text-muted-foreground flex-1">
                          {plan.bonusCreditPercent > 0 ? `Up to ${plan.bonusCreditPercent}% free bonus credits` : "No bonus credits"}
                        </span>
                        <span className="group relative shrink-0">
                          <Info className="w-3.5 h-3.5 text-muted-foreground" aria-label="Bonus credit terms" />
                          <span className="pointer-events-none absolute right-0 top-5 z-20 hidden w-64 border border-foreground/15 bg-background p-3 text-[11px] leading-relaxed text-muted-foreground group-hover:block">
                            {plan.bonusTermsCopy}
                          </span>
                        </span>
                      </li>
                    </>
                  )}
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-3">
                      <Check className="w-4 h-4 text-foreground mt-0.5 shrink-0" />
                      <span className="text-sm text-muted-foreground">{feature}</span>
                    </li>
                  ))}
                </ul>

                {unavailable ? (
                  <span aria-disabled="true" className={`${actionClassName} cursor-not-allowed opacity-50`}>{cta}</span>
                ) : (
                  <a href={signUpHref} className={actionClassName}>
                    {cta}
                    <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                  </a>
                )}
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
