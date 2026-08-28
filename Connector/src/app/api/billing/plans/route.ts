import { NextResponse } from 'next/server';
import { listCreditPacks, listPlans } from '@/lib/billing/credits';
import { SALES_EMAIL, billingSeller, isRazorpayConfigured } from '@/lib/billing/config';

export async function GET() {
  const [plans, packs] = await Promise.all([listPlans(), listCreditPacks()]);
  const seller = billingSeller();
  return NextResponse.json({
    plans,
    packs,
    razorpayConfigured: isRazorpayConfigured(),
    salesEmail: SALES_EMAIL,
    chargeCurrency: 'INR',
    usdToInr: seller.usdToInr,
    gstPercent: seller.gstPercent,
  });
}
