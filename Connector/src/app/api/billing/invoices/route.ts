import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getBillingProfile, gstStates, listInvoices, saveBillingProfile } from '@/lib/billing/invoices';

export async function GET() {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const [invoices, profile] = await Promise.all([
    listInvoices(auth.user.id),
    getBillingProfile(auth.user.id),
  ]);
  return NextResponse.json({
    invoices: invoices.map((invoice) => ({
      id: invoice.id,
      invoice_number: invoice.invoiceNumber,
      invoice_date: invoice.invoiceDate,
      description: invoice.description,
      status: invoice.status,
      total_paise: invoice.totalPaise,
      currency: invoice.currency,
      display_amount_cents: invoice.displayAmountCents,
    })),
    profile,
    states: gstStates(),
  });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => ({})) as {
    legalName?: string;
    gstin?: string;
    address?: string;
    stateCode?: string;
    stateName?: string;
  };
  try {
    const profile = await saveBillingProfile(auth.user.id, body);
    return NextResponse.json({ profile });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not save billing profile';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
