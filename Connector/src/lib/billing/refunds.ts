import { v4 as uuidv4 } from 'uuid';
import { query } from '@/lib/db';

export type BillingRefund = {
  id: string;
  checkoutIntentId: string;
  providerRefundId: string | null;
  amountPaise: number;
  status: string;
  reason: string;
  requestedByAdminId: string;
};

export async function recordRefund(input: {
  checkoutIntentId: string;
  providerRefundId: string | null;
  amountPaise: number;
  status: string;
  reason: string;
  requestedByAdminId: string;
}): Promise<string> {
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new Error('Refund amount must be a positive number of paise');
  }
  const id = uuidv4();
  await query(
    `INSERT INTO billing_refunds
      (id, checkout_intent_id, provider_refund_id, amount_paise, status, reason, requested_by_admin_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       amount_paise = VALUES(amount_paise),
       status = VALUES(status),
       reason = VALUES(reason),
       updated_at = CURRENT_TIMESTAMP`,
    [
      id,
      input.checkoutIntentId,
      input.providerRefundId,
      input.amountPaise,
      input.status.slice(0, 32),
      input.reason.slice(0, 255),
      input.requestedByAdminId.slice(0, 255),
    ],
  );
  return id;
}

export async function refundedAmountForIntent(checkoutIntentId: string): Promise<number> {
  const rows = await query<Array<{ total: number | string | null }>>(
    `SELECT COALESCE(SUM(amount_paise), 0) AS total
     FROM billing_refunds
     WHERE checkout_intent_id = ? AND status <> 'failed'`,
    [checkoutIntentId],
  );
  return Number(rows[0]?.total || 0);
}

export async function updateRefundStatus(providerRefundId: string, status: string): Promise<void> {
  await query(
    `UPDATE billing_refunds SET status = ? WHERE provider_refund_id = ?`,
    [status.slice(0, 32), providerRefundId],
  );
}
