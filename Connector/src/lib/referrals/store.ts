import { randomUUID } from 'crypto';
import { query, withTransaction } from '@/lib/db';
import { getReferralProgramConfig } from './config';
import {
  computeReferralDiscountPaise,
  isAttributionActive,
  maskEmail,
  normalizeReferralCode,
  type ReferralAttributionStatus,
} from './logic';
import { ensureReferralSchema } from './schema';
import { ensureProfileSchema } from '@/lib/profile/schema';

export type ReferralAttribution = {
  id: string;
  referredUserId: string;
  referrerUserId: string;
  referralCode: string;
  status: ReferralAttributionStatus;
  attributedAt: string;
  expiresAt: string;
  convertedAt: string | null;
  firstPaymentId: string | null;
  checkoutIntentId: string | null;
  refereeDiscountPercent: number;
  refereeDiscountPaise: number | null;
  referrerRewardPercent: number;
  referrerRewardCredits: number | null;
  referrerRewardedAt: string | null;
};

type AttributionRow = {
  id: string;
  referred_user_id: string;
  referrer_user_id: string;
  referral_code: string;
  status: ReferralAttributionStatus;
  attributed_at: Date | string;
  expires_at: Date | string;
  converted_at: Date | string | null;
  first_payment_id: string | null;
  checkout_intent_id: string | null;
  referee_discount_percent: number;
  referee_discount_paise: number | null;
  referrer_reward_percent: number;
  referrer_reward_credits: number | null;
  referrer_rewarded_at: Date | string | null;
};

function mapAttribution(row: AttributionRow): ReferralAttribution {
  return {
    id: row.id,
    referredUserId: row.referred_user_id,
    referrerUserId: row.referrer_user_id,
    referralCode: row.referral_code,
    status: row.status,
    attributedAt: new Date(row.attributed_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    convertedAt: row.converted_at ? new Date(row.converted_at).toISOString() : null,
    firstPaymentId: row.first_payment_id,
    checkoutIntentId: row.checkout_intent_id,
    refereeDiscountPercent: Number(row.referee_discount_percent),
    refereeDiscountPaise: row.referee_discount_paise == null ? null : Number(row.referee_discount_paise),
    referrerRewardPercent: Number(row.referrer_reward_percent),
    referrerRewardCredits: row.referrer_reward_credits == null ? null : Number(row.referrer_reward_credits),
    referrerRewardedAt: row.referrer_rewarded_at ? new Date(row.referrer_rewarded_at).toISOString() : null,
  };
}

async function logReferralEvent(
  attributionId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
  exec: typeof query = query,
): Promise<void> {
  await exec(
    `INSERT INTO referral_events (id, attribution_id, event_type, metadata_json) VALUES (?, ?, ?, ?)`,
    [randomUUID(), attributionId, eventType, JSON.stringify(metadata)],
  );
}

export async function resolveReferrerByCode(code: string): Promise<{
  referrerUserId: string;
  referralCode: string;
  displayName: string;
} | null> {
  await ensureReferralSchema();
  await ensureProfileSchema();
  const normalized = normalizeReferralCode(code);
  if (!normalized) return null;
  const rows = await query<Array<{ user_id: string; referral_code: string; display_name: string | null }>>(
    `SELECT up.user_id, up.referral_code, up.display_name
     FROM user_profiles up
     WHERE up.referral_code = ?
     LIMIT 1`,
    [normalized],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    referrerUserId: row.user_id,
    referralCode: row.referral_code,
    displayName: row.display_name?.trim() || 'A DeplAI user',
  };
}

export async function countReferrerSlotsUsed(referrerUserId: string): Promise<number> {
  await ensureReferralSchema();
  const rows = await query<Array<{ n: number }>>(
    `SELECT COUNT(*) AS n
     FROM referral_attributions
     WHERE referrer_user_id = ?
       AND status IN ('pending', 'converted')`,
    [referrerUserId],
  );
  return Number(rows[0]?.n || 0);
}

export async function getRefereeClaimState(userId: string): Promise<{
  hasClaimed: boolean;
  status: ReferralAttributionStatus | null;
  canClaimMore: boolean;
  message: string | null;
}> {
  await ensureReferralSchema();
  await expireStaleAttributions(userId);
  const attribution = await getAttributionForReferredUser(userId);
  if (!attribution) {
    if (await userHasPaidSubscription(userId)) {
      return {
        hasClaimed: false,
        status: null,
        canClaimMore: false,
        message: 'Referral codes only apply before your first paid plan purchase.',
      };
    }
    return { hasClaimed: false, status: null, canClaimMore: true, message: null };
  }
  if (attribution.status === 'pending' && isAttributionActive(attribution.status, new Date(attribution.expiresAt))) {
    return {
      hasClaimed: true,
      status: 'pending',
      canClaimMore: false,
      message: 'You already have a referral code applied to your account.',
    };
  }
  if (attribution.status === 'converted') {
    return {
      hasClaimed: true,
      status: 'converted',
      canClaimMore: false,
      message: 'You have already used a referral code on this account.',
    };
  }
  return {
    hasClaimed: true,
    status: attribution.status,
    canClaimMore: false,
    message: 'This account is no longer eligible for a referral code.',
  };
}

export async function validateReferralCodeForUser(
  code: string,
  currentUserId?: string | null,
): Promise<
  | {
    ok: true;
    referralCode: string;
    referrerName: string;
    discountPercent: number;
    referrerSlotsRemaining: number;
  }
  | { ok: false; error: string; code: string }
> {
  const config = getReferralProgramConfig();
  if (!config.enabled) {
    return { ok: false, error: 'Referrals are not available right now.', code: 'disabled' };
  }
  const normalized = normalizeReferralCode(code);
  if (!normalized) {
    return { ok: false, error: 'Enter a valid referral code.', code: 'invalid_format' };
  }
  const referrer = await resolveReferrerByCode(normalized);
  if (!referrer) {
    return { ok: false, error: 'This referral code is not valid.', code: 'invalid' };
  }
  if (currentUserId && referrer.referrerUserId === currentUserId) {
    return { ok: false, error: 'You cannot use your own referral code.', code: 'self_referral' };
  }
  const slotsUsed = await countReferrerSlotsUsed(referrer.referrerUserId);
  const slotsRemaining = Math.max(0, config.maxReferralsPerReferrer - slotsUsed);
  if (slotsRemaining <= 0) {
    return {
      ok: false,
      error: 'This referrer has reached the maximum number of referrals.',
      code: 'referrer_full',
    };
  }
  if (currentUserId) {
    const claim = await getRefereeClaimState(currentUserId);
    if (!claim.canClaimMore && claim.message) {
      return {
        ok: false,
        error: claim.message,
        code: claim.hasClaimed ? 'already_claimed' : 'not_eligible',
      };
    }
  }
  return {
    ok: true,
    referralCode: referrer.referralCode,
    referrerName: referrer.displayName,
    discountPercent: config.refereeDiscountPercent,
    referrerSlotsRemaining: slotsRemaining,
  };
}

export async function getAttributionForReferredUser(userId: string): Promise<ReferralAttribution | null> {
  await ensureReferralSchema();
  const rows = await query<AttributionRow[]>(
    `SELECT * FROM referral_attributions WHERE referred_user_id = ? LIMIT 1`,
    [userId],
  );
  return rows[0] ? mapAttribution(rows[0]) : null;
}

export async function expireStaleAttributions(userId: string): Promise<void> {
  await ensureReferralSchema();
  await query(
    `UPDATE referral_attributions
     SET status = 'expired'
     WHERE referred_user_id = ?
       AND status = 'pending'
       AND expires_at <= NOW()`,
    [userId],
  );
}

export async function getPendingReferralAttribution(userId: string): Promise<ReferralAttribution | null> {
  await ensureReferralSchema();
  await expireStaleAttributions(userId);
  const attribution = await getAttributionForReferredUser(userId);
  if (!attribution) return null;
  if (!isAttributionActive(attribution.status, new Date(attribution.expiresAt))) return null;
  return attribution;
}

export async function userHasPaidSubscription(userId: string): Promise<boolean> {
  const rows = await query<Array<{ n: number }>>(
    `SELECT COUNT(*) AS n
     FROM billing_invoices bi
     INNER JOIN billing_checkout_intents ci ON ci.id = bi.checkout_intent_id
     WHERE bi.user_id = ?
       AND bi.status = 'paid'
       AND ci.kind = 'subscription'
       AND ci.plan_id IS NOT NULL
       AND ci.plan_id <> 'free'`,
    [userId],
  );
  return Number(rows[0]?.n || 0) > 0;
}

export async function isReferralCheckoutEligible(userId: string): Promise<{
  eligible: boolean;
  attribution: ReferralAttribution | null;
  discountPercent: number;
}> {
  const config = getReferralProgramConfig();
  if (!config.enabled) return { eligible: false, attribution: null, discountPercent: 0 };
  if (await userHasPaidSubscription(userId)) {
    return { eligible: false, attribution: null, discountPercent: 0 };
  }
  const attribution = await getPendingReferralAttribution(userId);
  if (!attribution) return { eligible: false, attribution: null, discountPercent: 0 };
  return {
    eligible: true,
    attribution,
    discountPercent: attribution.refereeDiscountPercent,
  };
}

export async function createReferralAttribution(input: {
  referredUserId: string;
  referralCode: string;
}): Promise<ReferralAttribution | null> {
  await ensureReferralSchema();
  const config = getReferralProgramConfig();
  if (!config.enabled) return null;

  const normalized = normalizeReferralCode(input.referralCode);
  if (!normalized) return null;

  const referrer = await resolveReferrerByCode(normalized);
  if (!referrer) return null;
  if (referrer.referrerUserId === input.referredUserId) return null;

  const slotsUsed = await countReferrerSlotsUsed(referrer.referrerUserId);
  if (slotsUsed >= config.maxReferralsPerReferrer) return null;

  const claim = await getRefereeClaimState(input.referredUserId);
  if (!claim.canClaimMore) return null;

  const existing = await getAttributionForReferredUser(input.referredUserId);
  if (existing) {
    if (existing.status === 'pending' && isAttributionActive(existing.status, new Date(existing.expiresAt))) {
      return existing;
    }
    return null;
  }

  const id = randomUUID();
  const expiresAt = new Date(Date.now() + config.attributionWindowDays * 24 * 60 * 60 * 1000);

  try {
    await query(
      `INSERT INTO referral_attributions (
         id, referred_user_id, referrer_user_id, referral_code, status, expires_at,
         referee_discount_percent, referrer_reward_percent
       ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        id,
        input.referredUserId,
        referrer.referrerUserId,
        referrer.referralCode,
        expiresAt,
        config.refereeDiscountPercent,
        config.referrerRewardPercent,
      ],
    );
    await logReferralEvent(id, 'attributed', {
      referralCode: referrer.referralCode,
      referrerUserId: referrer.referrerUserId,
    });
    return await getAttributionForReferredUser(input.referredUserId);
  } catch (error) {
    const err = error as { code?: string };
    if (err.code === 'ER_DUP_ENTRY') {
      return getAttributionForReferredUser(input.referredUserId);
    }
    throw error;
  }
}

export async function applyReferralCodeForUser(
  userId: string,
  rawCode: string,
): Promise<
  | { ok: true; attribution: ReferralAttribution }
  | { ok: false; error: string; code: string }
> {
  const validation = await validateReferralCodeForUser(rawCode, userId);
  if (!validation.ok) {
    return { ok: false, error: validation.error, code: validation.code };
  }
  const attribution = await createReferralAttribution({
    referredUserId: userId,
    referralCode: validation.referralCode,
  });
  if (!attribution) {
    return {
      ok: false,
      error: 'Unable to apply this referral code right now.',
      code: 'apply_failed',
    };
  }
  return { ok: true, attribution };
}

export async function recordReferralDiscountApplied(input: {
  attributionId: string;
  checkoutIntentId: string;
  discountPaise: number;
}): Promise<void> {
  await ensureReferralSchema();
  await query(
    `UPDATE referral_attributions
     SET checkout_intent_id = ?, referee_discount_paise = ?
     WHERE id = ? AND status = 'pending'`,
    [input.checkoutIntentId, input.discountPaise, input.attributionId],
  );
  await logReferralEvent(input.attributionId, 'discount_applied', {
    checkoutIntentId: input.checkoutIntentId,
    discountPaise: input.discountPaise,
  });
}

export async function getReferrerDashboard(userId: string): Promise<{
  referralCode: string;
  stats: { pending: number; converted: number; creditsEarned: number };
  slots: { used: number; max: number; remaining: number; canShareMore: boolean };
  referrals: Array<{
    maskedEmail: string;
    status: ReferralAttributionStatus;
    attributedAt: string;
    convertedAt: string | null;
    rewardCredits: number | null;
  }>;
}> {
  await ensureReferralSchema();
  const config = getReferralProgramConfig();
  const profileRows = await query<Array<{ referral_code: string }>>(
    `SELECT referral_code FROM user_profiles WHERE user_id = ? LIMIT 1`,
    [userId],
  );
  const referralCode = profileRows[0]?.referral_code || '';
  const rows = await query<Array<AttributionRow & { contact_email: string | null; email: string }>>(
    `SELECT ra.*, COALESCE(up.contact_email, u.email) AS email, up.contact_email
     FROM referral_attributions ra
     INNER JOIN users u ON u.id = ra.referred_user_id
     LEFT JOIN user_profiles up ON up.user_id = ra.referred_user_id
     WHERE ra.referrer_user_id = ?
     ORDER BY ra.attributed_at DESC
     LIMIT 100`,
    [userId],
  );

  let pending = 0;
  let converted = 0;
  let creditsEarned = 0;
  const referrals = rows.map((row) => {
    if (row.status === 'pending') pending += 1;
    if (row.status === 'converted') converted += 1;
    const reward = row.referrer_reward_credits == null ? null : Number(row.referrer_reward_credits);
    if (reward) creditsEarned += reward;
    return {
      maskedEmail: maskEmail(row.email || ''),
      status: row.status,
      attributedAt: new Date(row.attributed_at).toISOString(),
      convertedAt: row.converted_at ? new Date(row.converted_at).toISOString() : null,
      rewardCredits: reward,
    };
  });

  const slotsUsed = await countReferrerSlotsUsed(userId);

  return {
    referralCode,
    stats: { pending, converted, creditsEarned },
    slots: {
      used: slotsUsed,
      max: config.maxReferralsPerReferrer,
      remaining: Math.max(0, config.maxReferralsPerReferrer - slotsUsed),
      canShareMore: slotsUsed < config.maxReferralsPerReferrer,
    },
    referrals,
  };
}

export async function previewReferralDiscount(userId: string, totalPaise: number): Promise<{
  eligible: boolean;
  discountPaise: number;
  discountPercent: number;
  discountedTotalPaise: number;
}> {
  const eligibility = await isReferralCheckoutEligible(userId);
  if (!eligibility.eligible || !eligibility.attribution) {
    return {
      eligible: false,
      discountPaise: 0,
      discountPercent: 0,
      discountedTotalPaise: totalPaise,
    };
  }
  const discountPaise = computeReferralDiscountPaise(totalPaise, eligibility.discountPercent);
  const discountedTotalPaise = Math.max(100, totalPaise - discountPaise);
  return {
    eligible: true,
    discountPaise,
    discountPercent: eligibility.discountPercent,
    discountedTotalPaise,
  };
}
