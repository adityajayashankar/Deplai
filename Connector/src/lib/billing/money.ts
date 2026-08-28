import { type GstSplitKind } from './config';

export const GST_STATES: Array<{ code: string; name: string }> = [
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
];

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

export type MoneyQuote = {
  displayAmountCents: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  gstPercent: number;
  cgstRate: number;
  sgstRate: number;
  igstRate: number;
  taxSplit: GstSplitKind;
  usdToInr: number;
};

export function usdCentsToInrPaise(usdCents: number, usdToInr: number): number {
  if (!Number.isFinite(usdCents) || usdCents < 0) throw new Error('Invalid USD amount');
  if (!Number.isFinite(usdToInr) || usdToInr <= 0) throw new Error('Invalid USD to INR rate');
  return Math.round(usdCents * usdToInr);
}

export function gstSplit(input: {
  taxablePaise: number;
  gstPercent: number;
  sellerStateCode: string;
  buyerStateCode?: string | null;
}): Omit<MoneyQuote, 'displayAmountCents' | 'usdToInr'> {
  const gstPercent = input.gstPercent;
  const seller = normalizeStateCode(input.sellerStateCode);
  const buyer = normalizeStateCode(input.buyerStateCode);
  const intra = !buyer || buyer === seller;
  if (intra) {
    const halfRate = gstPercent / 2;
    const cgstPaise = Math.round(input.taxablePaise * (halfRate / 100));
    const sgstPaise = Math.round(input.taxablePaise * (halfRate / 100));
    return {
      taxablePaise: input.taxablePaise,
      cgstPaise,
      sgstPaise,
      igstPaise: 0,
      totalPaise: input.taxablePaise + cgstPaise + sgstPaise,
      gstPercent,
      cgstRate: halfRate,
      sgstRate: halfRate,
      igstRate: 0,
      taxSplit: 'intra',
    };
  }
  const igstPaise = Math.round(input.taxablePaise * (gstPercent / 100));
  return {
    taxablePaise: input.taxablePaise,
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise,
    totalPaise: input.taxablePaise + igstPaise,
    gstPercent,
    cgstRate: 0,
    sgstRate: 0,
    igstRate: gstPercent,
    taxSplit: 'inter',
  };
}

export function quoteInrCharge(input: {
  usdCents: number;
  usdToInr: number;
  gstPercent: number;
  sellerStateCode: string;
  buyerStateCode?: string | null;
}): MoneyQuote {
  const taxablePaise = usdCentsToInrPaise(input.usdCents, input.usdToInr);
  return {
    displayAmountCents: input.usdCents,
    usdToInr: input.usdToInr,
    ...gstSplit({
      taxablePaise,
      gstPercent: input.gstPercent,
      sellerStateCode: input.sellerStateCode,
      buyerStateCode: input.buyerStateCode,
    }),
  };
}

export function normalizeStateCode(value: string | null | undefined): string {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 2);
  return digits.padStart(2, '0').slice(-2) === '00' ? '' : digits.padStart(2, '0');
}

export function stateNameForCode(code: string | null | undefined): string {
  const normalized = normalizeStateCode(code);
  return GST_STATES.find((state) => state.code === normalized)?.name || '';
}

export function indianFinancialYear(now = new Date()): { fy: string; label: string } {
  const month = now.getUTCMonth();
  const year = now.getUTCFullYear();
  const startYear = month >= 3 ? year : year - 1;
  const yy = String(startYear).slice(-2);
  const next = String(startYear + 1).slice(-2);
  return { fy: `${yy}${next}`, label: `${yy}-${next}` };
}

export function formatInvoiceNumber(prefix: string, fyLabel: string, serial: number): string {
  return `${prefix}/${fyLabel}/${String(serial).padStart(6, '0')}`;
}

export function formatInrFromPaise(paise: number): string {
  const rupees = paise / 100;
  return rupees.toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatUsdFromCents(cents: number): string {
  const amount = cents / 100;
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function gstinLooksValid(value: string): boolean {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value.trim().toUpperCase());
}

function twoDigitWords(n: number): string {
  if (n < 20) return ONES[n];
  const ten = Math.floor(n / 10);
  const one = n % 10;
  return `${TENS[ten]}${one ? ` ${ONES[one]}` : ''}`.trim();
}

function chunkWords(n: number): string {
  if (n === 0) return '';
  if (n < 100) return twoDigitWords(n);
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  return `${ONES[hundred]} Hundred${rest ? ` ${twoDigitWords(rest)}` : ''}`;
}

export function amountInWordsInr(paise: number): string {
  const rupees = Math.floor(Math.max(0, paise) / 100);
  const leftoverPaise = Math.max(0, paise) % 100;
  if (rupees === 0 && leftoverPaise === 0) return 'INR Zero Only';

  const crore = Math.floor(rupees / 10_000_000);
  const lakh = Math.floor((rupees % 10_000_000) / 100_000);
  const thousand = Math.floor((rupees % 100_000) / 1000);
  const hundred = rupees % 1000;

  const parts: string[] = [];
  if (crore) parts.push(`${chunkWords(crore)} Crore`);
  if (lakh) parts.push(`${chunkWords(lakh)} Lakh`);
  if (thousand) parts.push(`${chunkWords(thousand)} Thousand`);
  if (hundred) parts.push(chunkWords(hundred));

  const rupeeWords = parts.filter(Boolean).join(' ') || 'Zero';
  const paiseWords = leftoverPaise ? ` and Paise ${twoDigitWords(leftoverPaise)}` : '';
  return `INR ${rupeeWords}${paiseWords} Only`;
}
