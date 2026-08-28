import { query } from '@/lib/db';
import { ensureFulfillmentSchema } from './fulfillment-schema';

export const WEBHOOK_PROCESSING_TIMEOUT_SEC = Math.max(
  15,
  Number(process.env.BILLING_WEBHOOK_PROCESSING_TIMEOUT_SEC || 120) || 120,
);

export type WebhookEventStatus = 'processing' | 'completed' | 'failed';
export type WebhookDeliveryDecision = 'insert' | 'retry' | 'duplicate';

function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_TABLE_ERROR';
}

function isDuplicate(error: unknown): boolean {
  return (error as { code?: string }).code === 'ER_DUP_ENTRY';
}

function asDate(value: Date | string | null | undefined): Date {
  if (value instanceof Date) return value;
  const parsed = value ? new Date(value) : new Date(0);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

export function webhookDeliveryDecision(
  row: { status: string; updatedAt: Date } | null,
  now: Date,
  timeoutMs: number,
): WebhookDeliveryDecision {
  if (!row) return 'insert';
  if (row.status === 'completed') return 'duplicate';
  if (row.status === 'failed') return 'retry';
  if (row.status === 'processing') {
    return now.getTime() - row.updatedAt.getTime() >= timeoutMs ? 'retry' : 'duplicate';
  }
  return 'duplicate';
}

function affectedRows(result: unknown): number {
  return Number((result as { affectedRows?: number } | undefined)?.affectedRows || 0);
}

export async function beginWebhookDelivery(eventId: string, eventType: string): Promise<boolean> {
  await ensureFulfillmentSchema();
  try {
    await query(
      `INSERT INTO billing_webhook_events (id, event_type, status) VALUES (?, ?, 'processing')`,
      [eventId, eventType],
    );
    return true;
  } catch (error) {
    if (isMissingTable(error)) return true;
    if (!isDuplicate(error)) throw error;
  }

  const rows = await query<Array<{
    status: string | null;
    updated_at: Date | string | null;
    processed_at: Date | string | null;
  }>>(
    `SELECT status, updated_at, processed_at FROM billing_webhook_events WHERE id = ? LIMIT 1`,
    [eventId],
  );
  const existing = rows[0];
  if (!existing) return true;

  const decision = webhookDeliveryDecision(
    {
      status: existing.status || 'completed',
      updatedAt: asDate(existing.updated_at || existing.processed_at),
    },
    new Date(),
    WEBHOOK_PROCESSING_TIMEOUT_SEC * 1000,
  );
  if (decision !== 'retry') return false;

  const result = await query(
    `UPDATE billing_webhook_events
     SET status = 'processing', event_type = ?
     WHERE id = ?
       AND (
         status = 'failed'
         OR (
           status = 'processing'
           AND COALESCE(updated_at, processed_at) < DATE_SUB(NOW(), INTERVAL ? SECOND)
         )
       )`,
    [eventType, eventId, WEBHOOK_PROCESSING_TIMEOUT_SEC],
  );
  return affectedRows(result) === 1;
}

export async function completeWebhookDelivery(eventId: string): Promise<void> {
  try {
    await query(
      `UPDATE billing_webhook_events SET status = 'completed' WHERE id = ?`,
      [eventId],
    );
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
}

export async function failWebhookDelivery(eventId: string): Promise<void> {
  try {
    await query(
      `UPDATE billing_webhook_events SET status = 'failed' WHERE id = ?`,
      [eventId],
    );
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
}
