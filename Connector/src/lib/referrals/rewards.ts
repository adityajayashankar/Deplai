import { randomUUID } from 'crypto';
import { query, withTransaction } from '@/lib/db';
import { grantOrganizationCredits } from '@/lib/billing/organization-credits';
import { ensurePersonalOrganization } from '@/lib/organizations/store';
import { computeReferrerRewardCredits } from './logic';
import { getAttributionForReferredUser, getPendingReferralAttribution } from './store';
import { ensureReferralSchema } from './schema';

export type ReferralConversionInput = {
  referredUserId: string;
  paymentId: string;
  checkoutIntentId: string;
  planId: string;
  cadence: 'monthly' | 'yearly' | null;
};

export type ReferralConversionResult = {
  processed: boolean;
  attributionId?: string;
  rewardCredits?: number;
  duplicate?: boolean;
};

export async function processReferralConversion(
  input: ReferralConversionInput,
): Promise<ReferralConversionResult> {
  await ensureReferralSchema();

  const existing = await getAttributionForReferredUser(input.referredUserId);
  if (existing?.firstPaymentId === input.paymentId && existing.status === 'converted') {
    return {
      processed: true,
      attributionId: existing.id,
      rewardCredits: existing.referrerRewardCredits ?? undefined,
      duplicate: true,
    };
  }

  const attribution = await getPendingReferralAttribution(input.referredUserId);
  if (!attribution) return { processed: false };

  const rewardCredits = computeReferrerRewardCredits({
    planId: input.planId,
    cadence: input.cadence,
    rewardPercent: attribution.referrerRewardPercent,
  });

  const referrerOrg = await ensurePersonalOrganization({ id: attribution.referrerUserId });
  const grant = await grantOrganizationCredits({
    organizationId: referrerOrg.id,
    userId: attribution.referrerUserId,
    credits: rewardCredits,
    sourceType: 'promotion',
    sourceId: `referral:${attribution.id}`,
    idempotencyKey: `referral:reward:${input.paymentId}`,
    planId: input.planId,
  });

  return withTransaction(async (exec) => {
    const locked = await exec<Array<{
      id: string;
      referrer_user_id: string;
      status: string;
    }>>(
      `SELECT id, referrer_user_id, status
       FROM referral_attributions
       WHERE referred_user_id = ?
       LIMIT 1 FOR UPDATE`,
      [input.referredUserId],
    );
    const row = locked[0];
    if (!row) return { processed: false };
    if (row.status === 'converted') {
      return {
        processed: true,
        attributionId: row.id,
        rewardCredits,
        duplicate: true,
      };
    }
    if (row.status !== 'pending') return { processed: false };

    await exec(
      `UPDATE referral_attributions
       SET status = 'converted',
           converted_at = NOW(),
           first_payment_id = ?,
           checkout_intent_id = ?,
           referrer_reward_credits = ?,
           referrer_rewarded_at = NOW()
       WHERE id = ?`,
      [input.paymentId, input.checkoutIntentId, rewardCredits, row.id],
    );
    await exec(
      `INSERT INTO referral_events (id, attribution_id, event_type, metadata_json) VALUES (?, ?, ?, ?)`,
      [
        randomUUID(),
        row.id,
        'converted',
        JSON.stringify({ paymentId: input.paymentId, planId: input.planId }),
      ],
    );
    await exec(
      `INSERT INTO referral_events (id, attribution_id, event_type, metadata_json) VALUES (?, ?, ?, ?)`,
      [
        randomUUID(),
        row.id,
        'reward_granted',
        JSON.stringify({
          paymentId: input.paymentId,
          rewardCredits,
          duplicateGrant: grant.duplicate,
        }),
      ],
    );

    return {
      processed: true,
      attributionId: row.id,
      rewardCredits,
      duplicate: grant.duplicate,
    };
  });
}
