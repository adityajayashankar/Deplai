import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction, type SqlExecutor } from '@/lib/db';
import { billingSeller, type PaymentMode } from './config';
import {
  canTransitionPaymentState,
  normalizePaymentState,
  type PaymentState,
} from './payment-state';
import {
  GST_STATES,
  formatInvoiceNumber,
  gstinLooksValid,
  indianFinancialYear,
  normalizeStateCode,
  stateNameForCode,
} from './money';

export type BillingProfile = {
  legalName: string;
  gstin: string;
  address: string;
  stateCode: string;
  stateName: string;
};

export type CheckoutIntent = {
  id: string;
  userId: string;
  organizationId: string | null;
  idempotencyKey: string | null;
  receipt: string | null;
  provider: 'razorpay';
  paymentMode: PaymentMode;
  kind: 'subscription' | 'topup';
  planId: string | null;
  creditPackId: string | null;
  cadence: 'monthly' | 'yearly' | null;
  displayAmountCents: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  currency: string;
  taxSplit: 'intra' | 'inter';
  buyerGstin: string | null;
  buyerName: string | null;
  buyerAddress: string | null;
  buyerStateCode: string | null;
  buyerStateName: string | null;
  referralAttributionId: string | null;
  discountPaise: number;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  razorpaySubscriptionId: string | null;
  razorpayPlanId: string | null;
  signatureVerified: boolean;
  failureCode: string | null;
  failureDescription: string | null;
  capturedAt: string | null;
  status: PaymentState;
  createdAt: string | null;
  updatedAt: string | null;
};

export type BillingInvoice = {
  id: string;
  userId: string;
  checkoutIntentId: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  status: string;
  kind: string;
  description: string;
  hsnSac: string;
  quantity: number;
  sellerLegalName: string;
  sellerGstin: string | null;
  sellerAddress: string | null;
  sellerStateCode: string | null;
  sellerStateName: string | null;
  buyerName: string;
  buyerEmail: string;
  buyerGstin: string | null;
  buyerAddress: string | null;
  buyerStateCode: string | null;
  buyerStateName: string | null;
  placeOfSupply: string | null;
  reverseCharge: boolean;
  displayAmountCents: number;
  displayCurrency: string;
  taxablePaise: number;
  cgstRate: number;
  sgstRate: number;
  igstRate: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  currency: string;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  razorpaySubscriptionId: string | null;
  planId: string | null;
  creditPackId: string | null;
};

type IntentRow = {
  id: string;
  user_id: string;
  organization_id: string | null;
  idempotency_key: string | null;
  receipt: string | null;
  provider: 'razorpay';
  payment_mode: PaymentMode;
  kind: 'subscription' | 'topup';
  plan_id: string | null;
  credit_pack_id: string | null;
  cadence: 'monthly' | 'yearly' | null;
  display_amount_cents: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  total_paise: number;
  currency: string;
  tax_split: 'intra' | 'inter';
  buyer_gstin: string | null;
  buyer_name: string | null;
  buyer_address: string | null;
  buyer_state_code: string | null;
  buyer_state_name: string | null;
  referral_attribution_id?: string | null;
  discount_paise?: number | null;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  razorpay_subscription_id: string | null;
  razorpay_plan_id: string | null;
  signature_verified: number | boolean;
  failure_code: string | null;
  failure_description: string | null;
  captured_at: Date | string | null;
  status: string;
  created_at: Date | string | null;
  updated_at: Date | string | null;
};

type InvoiceRow = {
  id: string;
  user_id: string;
  checkout_intent_id: string | null;
  invoice_number: string;
  invoice_date: Date | string;
  status: string;
  kind: string;
  description: string;
  hsn_sac: string;
  quantity: number;
  seller_legal_name: string;
  seller_gstin: string | null;
  seller_address: string | null;
  seller_state_code: string | null;
  seller_state_name: string | null;
  buyer_name: string;
  buyer_email: string;
  buyer_gstin: string | null;
  buyer_address: string | null;
  buyer_state_code: string | null;
  buyer_state_name: string | null;
  place_of_supply: string | null;
  reverse_charge: number | boolean;
  display_amount_cents: number;
  display_currency: string;
  taxable_paise: number;
  cgst_rate: number;
  sgst_rate: number;
  igst_rate: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  total_paise: number;
  currency: string;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  razorpay_subscription_id: string | null;
  plan_id: string | null;
  credit_pack_id: string | null;
};

function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_TABLE_ERROR';
}

function isDuplicate(error: unknown): boolean {
  return (error as { code?: string }).code === 'ER_DUP_ENTRY';
}

function asDateOnly(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function asIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function mapIntent(row: IntentRow): CheckoutIntent {
  return {
    id: row.id,
    userId: row.user_id,
    organizationId: row.organization_id,
    idempotencyKey: row.idempotency_key,
    receipt: row.receipt,
    provider: row.provider || 'razorpay',
    paymentMode: row.payment_mode || 'test',
    kind: row.kind,
    planId: row.plan_id,
    creditPackId: row.credit_pack_id,
    cadence: row.cadence,
    displayAmountCents: Number(row.display_amount_cents),
    taxablePaise: Number(row.taxable_paise),
    cgstPaise: Number(row.cgst_paise),
    sgstPaise: Number(row.sgst_paise),
    igstPaise: Number(row.igst_paise),
    totalPaise: Number(row.total_paise),
    currency: row.currency,
    taxSplit: row.tax_split,
    buyerGstin: row.buyer_gstin,
    buyerName: row.buyer_name,
    buyerAddress: row.buyer_address,
    buyerStateCode: row.buyer_state_code,
    buyerStateName: row.buyer_state_name,
    referralAttributionId: row.referral_attribution_id ?? null,
    discountPaise: Number(row.discount_paise ?? 0),
    razorpayOrderId: row.razorpay_order_id,
    razorpayPaymentId: row.razorpay_payment_id,
    razorpaySubscriptionId: row.razorpay_subscription_id,
    razorpayPlanId: row.razorpay_plan_id,
    signatureVerified: Boolean(row.signature_verified),
    failureCode: row.failure_code,
    failureDescription: row.failure_description,
    capturedAt: asIso(row.captured_at),
    status: normalizePaymentState(row.status),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function mapInvoice(row: InvoiceRow): BillingInvoice {
  return {
    id: row.id,
    userId: row.user_id,
    checkoutIntentId: row.checkout_intent_id,
    invoiceNumber: row.invoice_number,
    invoiceDate: asDateOnly(row.invoice_date),
    status: row.status,
    kind: row.kind,
    description: row.description,
    hsnSac: row.hsn_sac,
    quantity: Number(row.quantity),
    sellerLegalName: row.seller_legal_name,
    sellerGstin: row.seller_gstin,
    sellerAddress: row.seller_address,
    sellerStateCode: row.seller_state_code,
    sellerStateName: row.seller_state_name,
    buyerName: row.buyer_name,
    buyerEmail: row.buyer_email,
    buyerGstin: row.buyer_gstin,
    buyerAddress: row.buyer_address,
    buyerStateCode: row.buyer_state_code,
    buyerStateName: row.buyer_state_name,
    placeOfSupply: row.place_of_supply,
    reverseCharge: Boolean(row.reverse_charge),
    displayAmountCents: Number(row.display_amount_cents),
    displayCurrency: row.display_currency,
    taxablePaise: Number(row.taxable_paise),
    cgstRate: Number(row.cgst_rate),
    sgstRate: Number(row.sgst_rate),
    igstRate: Number(row.igst_rate),
    cgstPaise: Number(row.cgst_paise),
    sgstPaise: Number(row.sgst_paise),
    igstPaise: Number(row.igst_paise),
    totalPaise: Number(row.total_paise),
    currency: row.currency,
    razorpayOrderId: row.razorpay_order_id,
    razorpayPaymentId: row.razorpay_payment_id,
    razorpaySubscriptionId: row.razorpay_subscription_id,
    planId: row.plan_id,
    creditPackId: row.credit_pack_id,
  };
}

export function gstStates(): Array<{ code: string; name: string }> {
  return GST_STATES;
}

export async function getBillingProfile(userId: string): Promise<BillingProfile> {
  try {
    const rows = await query<Array<{
      legal_name: string | null;
      gstin: string | null;
      address: string | null;
      state_code: string | null;
      state_name: string | null;
    }>>(`SELECT legal_name, gstin, address, state_code, state_name FROM billing_profiles WHERE user_id = ? LIMIT 1`, [userId]);
    const row = rows[0];
    const stateCode = normalizeStateCode(row?.state_code);
    return {
      legalName: row?.legal_name?.trim() || '',
      gstin: row?.gstin?.trim().toUpperCase() || '',
      address: row?.address?.trim() || '',
      stateCode,
      stateName: row?.state_name?.trim() || stateNameForCode(stateCode),
    };
  } catch (error) {
    if (isMissingTable(error)) {
      return { legalName: '', gstin: '', address: '', stateCode: '', stateName: '' };
    }
    throw error;
  }
}

export async function saveBillingProfile(userId: string, input: Partial<BillingProfile>): Promise<BillingProfile> {
  const gstin = String(input.gstin || '').trim().toUpperCase();
  if (gstin && !gstinLooksValid(gstin)) {
    throw new Error('GSTIN must be a 15-character Indian GST identification number');
  }
  const stateCode = normalizeStateCode(input.stateCode || gstin.slice(0, 2));
  const stateName = input.stateName?.trim() || stateNameForCode(stateCode);
  const legalName = String(input.legalName || '').trim();
  const address = String(input.address || '').trim();
  await query(
    `INSERT INTO billing_profiles (user_id, legal_name, gstin, address, state_code, state_name)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       legal_name = VALUES(legal_name),
       gstin = VALUES(gstin),
       address = VALUES(address),
       state_code = VALUES(state_code),
       state_name = VALUES(state_name)`,
    [userId, legalName || null, gstin || null, address || null, stateCode || null, stateName || null],
  );
  return getBillingProfile(userId);
}

export async function createCheckoutIntent(input: Omit<CheckoutIntent,
  | 'razorpayOrderId'
  | 'razorpayPaymentId'
  | 'razorpaySubscriptionId'
  | 'razorpayPlanId'
  | 'signatureVerified'
  | 'failureCode'
  | 'failureDescription'
  | 'capturedAt'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
  | 'referralAttributionId'
  | 'discountPaise'
> & {
  status?: PaymentState;
  referralAttributionId?: string | null;
  discountPaise?: number;
}): Promise<CheckoutIntent> {
  await query(
    `INSERT INTO billing_checkout_intents (
       id, user_id, organization_id, idempotency_key, receipt, provider, payment_mode,
       kind, plan_id, credit_pack_id, cadence, display_amount_cents,
       taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, currency, tax_split,
       buyer_gstin, buyer_name, buyer_address, buyer_state_code, buyer_state_name,
       referral_attribution_id, discount_paise, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.userId,
      input.organizationId,
      input.idempotencyKey,
      input.receipt,
      input.provider,
      input.paymentMode,
      input.kind,
      input.planId,
      input.creditPackId,
      input.cadence,
      input.displayAmountCents,
      input.taxablePaise,
      input.cgstPaise,
      input.sgstPaise,
      input.igstPaise,
      input.totalPaise,
      input.currency,
      input.taxSplit,
      input.buyerGstin,
      input.buyerName,
      input.buyerAddress,
      input.buyerStateCode,
      input.buyerStateName,
      input.referralAttributionId ?? null,
      input.discountPaise ?? 0,
      input.status || 'created',
    ],
  );
  const created = await getCheckoutIntent(input.id);
  if (!created) throw new Error('Failed to create checkout intent');
  return created;
}

export async function attachRazorpayIds(intentId: string, ids: {
  orderId?: string | null;
  paymentId?: string | null;
  subscriptionId?: string | null;
  planId?: string | null;
}): Promise<void> {
  await query(
    `UPDATE billing_checkout_intents
     SET razorpay_order_id = COALESCE(?, razorpay_order_id),
         razorpay_payment_id = COALESCE(?, razorpay_payment_id),
         razorpay_subscription_id = COALESCE(?, razorpay_subscription_id),
         razorpay_plan_id = COALESCE(?, razorpay_plan_id),
         status = CASE WHEN status = 'created' AND ? IS NOT NULL THEN 'pending' ELSE status END
     WHERE id = ?`,
    [
      ids.orderId ?? null,
      ids.paymentId ?? null,
      ids.subscriptionId ?? null,
      ids.planId ?? null,
      ids.orderId ?? null,
      intentId,
    ],
  );
}

export async function getCheckoutIntent(id: string): Promise<CheckoutIntent | null> {
  const rows = await query<IntentRow[]>(`SELECT * FROM billing_checkout_intents WHERE id = ? LIMIT 1`, [id]);
  return rows[0] ? mapIntent(rows[0]) : null;
}

export async function findCheckoutIntentByIdempotency(
  userId: string,
  idempotencyKey: string,
): Promise<CheckoutIntent | null> {
  const rows = await query<IntentRow[]>(
    `SELECT * FROM billing_checkout_intents
     WHERE user_id = ? AND idempotency_key = ?
     LIMIT 1`,
    [userId, idempotencyKey],
  );
  return rows[0] ? mapIntent(rows[0]) : null;
}

export async function findCheckoutIntentByPaymentId(paymentId: string): Promise<CheckoutIntent | null> {
  const rows = await query<IntentRow[]>(
    `SELECT * FROM billing_checkout_intents WHERE razorpay_payment_id = ? LIMIT 1`,
    [paymentId],
  );
  return rows[0] ? mapIntent(rows[0]) : null;
}

export async function findCheckoutIntent(input: {
  orderId?: string | null;
  subscriptionId?: string | null;
}): Promise<CheckoutIntent | null> {
  if (input.orderId) {
    const rows = await query<IntentRow[]>(
      `SELECT * FROM billing_checkout_intents WHERE razorpay_order_id = ? ORDER BY created_at DESC LIMIT 1`,
      [input.orderId],
    );
    if (rows[0]) return mapIntent(rows[0]);
  }
  if (input.subscriptionId) {
    const rows = await query<IntentRow[]>(
      `SELECT * FROM billing_checkout_intents WHERE razorpay_subscription_id = ? ORDER BY created_at DESC LIMIT 1`,
      [input.subscriptionId],
    );
    if (rows[0]) return mapIntent(rows[0]);
  }
  return null;
}

export async function transitionCheckoutIntentState(
  intentId: string,
  next: PaymentState,
  details: {
    paymentId?: string | null;
    signatureVerified?: boolean;
    failureCode?: string | null;
    failureDescription?: string | null;
  } = {},
): Promise<CheckoutIntent | null> {
  return withTransaction(async (exec) => {
    const rows = await exec<IntentRow[]>(
      `SELECT * FROM billing_checkout_intents WHERE id = ? LIMIT 1 FOR UPDATE`,
      [intentId],
    );
    const row = rows[0];
    if (!row) return null;
    if (!canTransitionPaymentState(row.status, next)) return mapIntent(row);

    await exec(
      `UPDATE billing_checkout_intents
       SET status = ?,
           razorpay_payment_id = COALESCE(?, razorpay_payment_id),
           signature_verified = CASE WHEN ? = 1 THEN 1 ELSE signature_verified END,
           failure_code = ?,
           failure_description = ?,
           captured_at = CASE WHEN ? = 'captured' THEN COALESCE(captured_at, NOW()) ELSE captured_at END
       WHERE id = ?`,
      [
        next,
        details.paymentId || null,
        details.signatureVerified ? 1 : 0,
        details.failureCode || null,
        details.failureDescription?.slice(0, 255) || null,
        next,
        intentId,
      ],
    );
    const updated = await exec<IntentRow[]>(
      `SELECT * FROM billing_checkout_intents WHERE id = ? LIMIT 1`,
      [intentId],
    );
    return updated[0] ? mapIntent(updated[0]) : null;
  });
}

export async function markIntentPaid(intentId: string): Promise<void> {
  await transitionCheckoutIntentState(intentId, 'captured');
}

export async function updateInvoiceStatusByPaymentId(
  paymentId: string,
  status: string,
): Promise<boolean> {
  const result = await query<{ affectedRows?: number }>(
    `UPDATE billing_invoices SET status = ? WHERE razorpay_payment_id = ?`,
    [status, paymentId],
  );
  return Number(result?.affectedRows || 0) > 0;
}

export async function findInvoiceByPaymentId(paymentId: string): Promise<BillingInvoice | null> {
  try {
    const rows = await query<InvoiceRow[]>(
      `SELECT * FROM billing_invoices WHERE razorpay_payment_id = ? LIMIT 1`,
      [paymentId],
    );
    return rows[0] ? mapInvoice(rows[0]) : null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

export async function findInvoiceByIntentId(intentId: string): Promise<BillingInvoice | null> {
  try {
    const rows = await query<InvoiceRow[]>(
      `SELECT * FROM billing_invoices WHERE checkout_intent_id = ? LIMIT 1`,
      [intentId],
    );
    return rows[0] ? mapInvoice(rows[0]) : null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

export async function listInvoices(userId: string): Promise<BillingInvoice[]> {
  try {
    const rows = await query<InvoiceRow[]>(
      `SELECT * FROM billing_invoices WHERE user_id = ? ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map(mapInvoice);
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

export async function getInvoiceForUser(invoiceId: string, userId: string): Promise<BillingInvoice | null> {
  const rows = await query<InvoiceRow[]>(
    `SELECT * FROM billing_invoices WHERE id = ? AND user_id = ? LIMIT 1`,
    [invoiceId, userId],
  );
  return rows[0] ? mapInvoice(rows[0]) : null;
}

export async function createPaidInvoice(input: {
  userId: string;
  buyerEmail: string;
  intent: CheckoutIntent;
  description: string;
  paymentId: string;
  orderId?: string | null;
  subscriptionId?: string | null;
}): Promise<BillingInvoice> {
  const existing = await findInvoiceByPaymentId(input.paymentId);
  if (existing) return existing;

  const seller = billingSeller();
  const now = new Date();
  const fy = indianFinancialYear(now);
  const buyerStateCode = normalizeStateCode(input.intent.buyerStateCode);
  const buyerStateName = input.intent.buyerStateName || stateNameForCode(buyerStateCode);
  const placeOfSupply = buyerStateName
    ? `${buyerStateCode} ${buyerStateName}`.trim()
    : `${seller.stateCode} ${seller.stateName}`.trim();
  const halfRate = seller.gstPercent / 2;
  const cgstRate = input.intent.taxSplit === 'intra' ? halfRate : 0;
  const sgstRate = input.intent.taxSplit === 'intra' ? halfRate : 0;
  const igstRate = input.intent.taxSplit === 'inter' ? seller.gstPercent : 0;

  try {
    return await withTransaction(async (exec) => {
      const locked = await exec<InvoiceRow[]>(
        `SELECT * FROM billing_invoices WHERE razorpay_payment_id = ? LIMIT 1 FOR UPDATE`,
        [input.paymentId],
      );
      if (locked[0]) return mapInvoice(locked[0]);

      const serial = await nextInvoiceSerial(exec, fy.fy);
      const invoiceNumber = formatInvoiceNumber(seller.invoicePrefix, fy.label, serial);
      const id = uuidv4();
      await exec(
        `INSERT INTO billing_invoices (
           id, user_id, checkout_intent_id, invoice_number, invoice_date, status, kind, description, hsn_sac, quantity,
           seller_legal_name, seller_gstin, seller_address, seller_state_code, seller_state_name,
           buyer_name, buyer_email, buyer_gstin, buyer_address, buyer_state_code, buyer_state_name,
           place_of_supply, reverse_charge, display_amount_cents, display_currency,
           taxable_paise, cgst_rate, sgst_rate, igst_rate, cgst_paise, sgst_paise, igst_paise,
           total_paise, currency, razorpay_order_id, razorpay_payment_id, razorpay_subscription_id,
           plan_id, credit_pack_id
          ) VALUES (
           ?, ?, ?, ?, ?, 'paid', ?, ?, ?, 1,
           ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?,
           ?, 0, ?, 'INR',
           ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?
         )`,
        [
          id,
          input.userId,
          input.intent.id,
          invoiceNumber,
          asDateOnly(now),
          input.intent.kind,
          input.description,
          seller.sacCode,
          seller.legalName,
          seller.gstin || null,
          seller.address || null,
          seller.stateCode || null,
          seller.stateName || null,
          input.intent.buyerName || seller.legalName,
          input.buyerEmail,
          input.intent.buyerGstin,
          input.intent.buyerAddress,
          buyerStateCode || null,
          buyerStateName || null,
          placeOfSupply || null,
          input.intent.displayAmountCents,
          input.intent.taxablePaise,
          cgstRate,
          sgstRate,
          igstRate,
          input.intent.cgstPaise,
          input.intent.sgstPaise,
          input.intent.igstPaise,
          input.intent.totalPaise,
          input.intent.currency,
          input.orderId || input.intent.razorpayOrderId,
          input.paymentId,
          input.subscriptionId || input.intent.razorpaySubscriptionId,
          input.intent.planId,
          input.intent.creditPackId,
        ],
      );
      const rows = await exec<InvoiceRow[]>(`SELECT * FROM billing_invoices WHERE id = ? LIMIT 1`, [id]);
      if (!rows[0]) throw new Error('Invoice insert did not return a row');
      return mapInvoice(rows[0]);
    });
  } catch (error) {
    if (isDuplicate(error)) {
      const again = await findInvoiceByPaymentId(input.paymentId);
      if (again) return again;
    }
    throw error;
  }
}

async function nextInvoiceSerial(exec: SqlExecutor, fy: string): Promise<number> {
  await exec(
    `INSERT INTO billing_invoice_sequences (fy, last_number) VALUES (?, 0)
     ON DUPLICATE KEY UPDATE fy = fy`,
    [fy],
  );
  const rows = await exec<Array<{ last_number: number }>>(
    `SELECT last_number FROM billing_invoice_sequences WHERE fy = ? LIMIT 1 FOR UPDATE`,
    [fy],
  );
  const next = Number(rows[0]?.last_number || 0) + 1;
  await exec(`UPDATE billing_invoice_sequences SET last_number = ? WHERE fy = ?`, [next, fy]);
  return next;
}

export async function cachedRazorpayPlanId(localKey: string): Promise<string | null> {
  try {
    const rows = await query<Array<{ razorpay_plan_id: string }>>(
      `SELECT razorpay_plan_id FROM billing_razorpay_plans WHERE local_key = ? LIMIT 1`,
      [localKey],
    );
    return rows[0]?.razorpay_plan_id || null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

export async function storeRazorpayPlan(localKey: string, razorpayPlanId: string, amountPaise: number, period: string): Promise<void> {
  await query(
    `INSERT INTO billing_razorpay_plans (local_key, razorpay_plan_id, amount_paise, currency, period)
     VALUES (?, ?, ?, 'INR', ?)
     ON DUPLICATE KEY UPDATE razorpay_plan_id = VALUES(razorpay_plan_id), amount_paise = VALUES(amount_paise)`,
    [localKey, razorpayPlanId, amountPaise, period],
  );
}
