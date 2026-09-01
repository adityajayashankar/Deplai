import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { listCreditPacks, listPlans } from '@/lib/billing/credits';
import {
  SALES_EMAIL,
  billingSeller,
  isRazorpayConfigured,
  paymentConfig,
  publicPaymentConfig,
} from '@/lib/billing/config';
import { CREDIT_CATALOG_VERSION, CREDIT_VALUE_PAISE, catalogEconomics } from '@/lib/billing/credit-catalog';
import { isReferralCheckoutEligible } from '@/lib/referrals/store';
import { getReferralProgramConfig } from '@/lib/referrals/config';

export async function GET() {
  const [plans, packs] = await Promise.all([listPlans(), listCreditPacks()]);
  const seller = billingSeller();
  const payments = publicPaymentConfig(paymentConfig());
  const referralProgram = getReferralProgramConfig();

  let referral: {
    eligible: boolean;
    discountPercent: number;
    headline: string;
    refereeBenefit: string;
  } | null = null;

  const user = await getAuthenticatedUser();
  if (user && referralProgram.enabled) {
    try {
      const eligibility = await isReferralCheckoutEligible(user.id);
      referral = {
        eligible: eligibility.eligible,
        discountPercent: eligibility.discountPercent,
        headline: referralProgram.headline,
        refereeBenefit: referralProgram.refereeBenefit,
      };
    } catch (error) {
      console.warn('[billing/plans] referral eligibility lookup failed', error);
    }
  }

  return NextResponse.json({
    plans: plans.map((plan) => ({
      ...plan,
      price_inr_paise: plan.pricePaise,
      yearly_price_inr_paise: plan.yearlyPricePaise,
      gst_inclusive: plan.priceIncludesTax,
      credit_grant: plan.paidCreditAmount,
      annual_credit_grant: plan.annualCreditAmount,
      provider_budget_paise: plan.providerBudgetPaise,
      annual_provider_budget_paise: plan.yearlyProviderBudgetPaise,
      annual_release_schedule: plan.annualReleaseSchedule,
      economics: plan.pricePaise > 0 ? catalogEconomics(plan.pricePaise, plan.paidCreditAmount) : null,
    })),
    packs: packs.map((pack) => ({
      ...pack,
      price_inr_paise: pack.pricePaise,
      gst_inclusive: true,
      credit_grant: pack.creditAmount,
      provider_budget_paise: pack.providerBudgetPaise,
    })),
    razorpayConfigured: isRazorpayConfigured(),
    salesEmail: SALES_EMAIL,
    chargeCurrency: 'INR',
    catalogVersion: CREDIT_CATALOG_VERSION,
    creditValueProviderUsagePaise: CREDIT_VALUE_PAISE,
    usdToInr: seller.usdToInr,
    gstPercent: seller.gstPercent,
    payments,
    referral,
  });
}
