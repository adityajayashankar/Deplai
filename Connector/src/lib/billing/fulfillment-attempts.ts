import { v4 as uuidv4 } from 'uuid';
import { query } from '@/lib/db';
import { ensureFulfillmentSchema } from './fulfillment-schema';

export type FulfillmentSource = 'webhook' | 'client_verify' | 'admin_retry';
export type FulfillmentAttemptStatus = 'processing' | 'completed' | 'failed';

const SENSITIVE_PAYMENT_FIELDS = new Set([
  'card',
  'contact',
  'email',
  'vpa',
  'bank',
  'wallet',
  'acquirer_data',
  'razorpay_signature',
]);

export function sanitizePaymentPayload(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitizePaymentPayload(entry, depth + 1));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' && value.length > 512 ? `${value.slice(0, 512)}…` : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_PAYMENT_FIELDS.has(key.toLowerCase()))
      .map(([key, entry]) => [key, sanitizePaymentPayload(entry, depth + 1)]),
  );
}

function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_TABLE_ERROR';
}

export async function startFulfillmentAttempt(input: {
  paymentId?: string | null;
  orderId?: string | null;
  source: FulfillmentSource;
  rawPayload?: unknown;
}): Promise<string> {
  await ensureFulfillmentSchema();
  const id = uuidv4();
  const payload = input.rawPayload == null ? null : JSON.stringify(sanitizePaymentPayload(input.rawPayload));
  try {
    await query(
      `INSERT INTO billing_fulfillment_attempts
        (id, razorpay_payment_id, razorpay_order_id, source, status, raw_payload)
       VALUES (?, ?, ?, ?, 'processing', ?)`,
      [id, input.paymentId || null, input.orderId || null, input.source, payload],
    );
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  return id;
}

export async function completeFulfillmentAttempt(id: string): Promise<void> {
  try {
    await query(
      `UPDATE billing_fulfillment_attempts
       SET status = 'completed', error_message = NULL, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [id],
    );
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
}

export async function failFulfillmentAttempt(id: string, errorMessage: string): Promise<void> {
  try {
    await query(
      `UPDATE billing_fulfillment_attempts
       SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [errorMessage.slice(0, 4000), id],
    );
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
}

export type FulfillmentAttemptRow = {
  id: string;
  razorpay_payment_id: string | null;
  razorpay_order_id: string | null;
  source: string;
  status: string;
  error_message: string | null;
  raw_payload: unknown;
  attempted_at: string;
  completed_at: string | null;
};

function asIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function parseJson(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

export async function listFulfillmentAttempts(input: {
  status?: string;
  limit: number;
  offset: number;
}): Promise<{ attempts: FulfillmentAttemptRow[]; total: number; limit: number; offset: number }> {
  await ensureFulfillmentSchema();
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit) || 50));
  const offset = Math.max(0, Math.trunc(input.offset) || 0);
  const status = String(input.status || '').trim();
  const where = status ? 'WHERE status = ?' : '';
  const params = status ? [status] : [];
  try {
    const countRows = await query<Array<{ n: number | string }>>(
      `SELECT COUNT(*) AS n FROM billing_fulfillment_attempts ${where}`,
      params,
    );
    const rows = await query<Array<{
      id: string;
      razorpay_payment_id: string | null;
      razorpay_order_id: string | null;
      source: string;
      status: string;
      error_message: string | null;
      raw_payload: unknown;
      attempted_at: Date | string;
      completed_at: Date | string | null;
    }>>(
      `SELECT id, razorpay_payment_id, razorpay_order_id, source, status, error_message, raw_payload, attempted_at, completed_at
       FROM billing_fulfillment_attempts
       ${where}
       ORDER BY attempted_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return {
      attempts: rows.map((row) => ({
        id: row.id,
        razorpay_payment_id: row.razorpay_payment_id,
        razorpay_order_id: row.razorpay_order_id,
        source: row.source,
        status: row.status,
        error_message: row.error_message,
        raw_payload: parseJson(row.raw_payload),
        attempted_at: asIso(row.attempted_at) || '',
        completed_at: asIso(row.completed_at),
      })),
      total: Number(countRows[0]?.n || 0),
      limit,
      offset,
    };
  } catch (error) {
    if (isMissingTable(error)) return { attempts: [], total: 0, limit, offset };
    throw error;
  }
}
