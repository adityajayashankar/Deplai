import { createHash } from 'node:crypto';
import Razorpay from 'razorpay';
import { v4 as uuidv4 } from 'uuid';
import { query, withNamedLock } from '@/lib/db';

function getRazorpayClient(): Razorpay {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) throw new Error('Razorpay is not configured');
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

export async function refundedAmountForIntent(checkoutIntentId: string): Promise<number> {
  const rows = await query<Array<{ total: number }>>(
    `SELECT COALESCE(SUM(amount_paise), 0) AS total
     FROM billing_refunds WHERE checkout_intent_id = ? AND status <> 'failed'`,
    [checkoutIntentId],
  );
  return Number(rows[0]?.total || 0);
}

export async function createRefund(input: {
  checkoutIntentId: string;
  amountPaise?: number;
  reason: string;
  requestedByAdminId: string;
}): Promise<{ refundId: string; providerRefundId: string; amountPaise: number; status: string }> {
  return withNamedLock(`admin_refund_${input.checkoutIntentId}`, 15, async () => {
    const intents = await query<Array<{
      id: string;
      razorpay_payment_id: string | null;
      total_paise: number;
      status: string;
    }>>(
      `SELECT id, razorpay_payment_id, total_paise, status
       FROM billing_checkout_intents WHERE id = ? LIMIT 1`,
      [input.checkoutIntentId],
    );
    const intent = intents[0];
    if (!intent?.razorpay_payment_id) throw new Error('Captured payment not found');

    const client = getRazorpayClient();
    const providerPayment = await client.payments.fetch(intent.razorpay_payment_id);
    const providerAmount = Number(providerPayment.amount || 0);
    const providerRefunded = Number(providerPayment.amount_refunded || 0);
    const recordedRefunded = await refundedAmountForIntent(intent.id);
    const alreadyRefunded = Math.max(recordedRefunded, providerRefunded);
    const refundable = Math.max(0, providerAmount - alreadyRefunded);
    const amountPaise = input.amountPaise == null ? refundable : input.amountPaise;
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      throw new Error('Refund amount must be a positive integer number of paise');
    }

    if (amountPaise > refundable) {
      throw new Error(`Refund amount cannot exceed ${refundable} paise`);
    }

    const digest = createHash('sha256')
      .update(`${intent.id}:${amountPaise}:${input.reason}`)
      .digest('hex')
      .slice(0, 12);
    const receipt = `dpl_ref_${intent.id.slice(0, 12)}_${digest}`.slice(0, 40);

    const refund = await client.payments.refund(intent.razorpay_payment_id, {
      amount: amountPaise,
      notes: { reason: input.reason.slice(0, 255) },
      receipt,
    });

    const refundId = uuidv4();
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
        refundId,
        intent.id,
        String(refund.id || ''),
        Number(refund.amount || amountPaise),
        String(refund.status || 'pending').slice(0, 32),
        input.reason.slice(0, 255),
        input.requestedByAdminId,
      ],
    );

    const totalAfter = alreadyRefunded + amountPaise;
    const nextStatus = String(refund.status) === 'processed'
      ? totalAfter >= providerAmount ? 'refunded' : 'partially_refunded'
      : 'refund_pending';

    await query(`UPDATE billing_checkout_intents SET status = ? WHERE id = ?`, [nextStatus, intent.id]);

    return {
      refundId,
      providerRefundId: String(refund.id || ''),
      amountPaise: Number(refund.amount || input.amountPaise),
      status: String(refund.status || 'pending'),
    };
  });
}

export async function listRefunds(input: { limit?: number; offset?: number }) {
  const limit = Math.min(Math.max(input.limit || 50, 1), 100);
  const offset = Math.max(input.offset || 0, 0);
  const rows = await query<Array<{
    id: string;
    checkout_intent_id: string;
    provider_refund_id: string | null;
    amount_paise: number;
    status: string;
    reason: string;
    created_at: Date | string;
  }>>(
    `SELECT id, checkout_intent_id, provider_refund_id, amount_paise, status, reason, created_at
     FROM billing_refunds
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );

  const countRows = await query<Array<{ total: number }>>(`SELECT COUNT(*) AS total FROM billing_refunds`);

  return {
    total: Number(countRows[0]?.total || 0),
    refunds: rows.map((row) => ({
      id: row.id,
      checkoutIntentId: row.checkout_intent_id,
      providerRefundId: row.provider_refund_id,
      amountPaise: Number(row.amount_paise || 0),
      status: row.status,
      reason: row.reason,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}
