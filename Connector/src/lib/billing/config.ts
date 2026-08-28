export const SALES_EMAIL = 'founders@deplai.tech';
export const BILLING_BRAND = 'DeplAI';

export type GstSplitKind = 'intra' | 'inter';

export type BillingSeller = {
  legalName: string;
  gstin: string;
  address: string;
  stateName: string;
  stateCode: string;
  sacCode: string;
  invoicePrefix: string;
  gstPercent: number;
  usdToInr: number;
};

function envString(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function billingSeller(): BillingSeller {
  return {
    legalName: envString('BILLING_LEGAL_NAME', BILLING_BRAND),
    gstin: envString('BILLING_GSTIN'),
    address: envString('BILLING_ADDRESS'),
    stateName: envString('BILLING_STATE_NAME', 'Karnataka'),
    stateCode: envString('BILLING_STATE_CODE', '29'),
    sacCode: envString('BILLING_SAC_CODE', '998314'),
    invoicePrefix: envString('BILLING_INVOICE_PREFIX', 'DPL'),
    gstPercent: envNumber('BILLING_GST_RATE', 18),
    usdToInr: envNumber('RAZORPAY_USD_TO_INR', 83),
  };
}

export function isRazorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID?.trim() && process.env.RAZORPAY_KEY_SECRET?.trim());
}

export function publicRazorpayKeyId(): string {
  return process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID?.trim() || process.env.RAZORPAY_KEY_ID?.trim() || '';
}
