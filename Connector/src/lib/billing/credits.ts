import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction, type SqlExecutor } from '@/lib/db';
import {
  ENTERPRISE_PLAN_ID,
  FREE_PLAN_ID,
  InsufficientCreditsError,
  applyPaidGrant,
  cappedRollover,
  consumeOnLockedLedger,
  expireBonusOnLedger,
  overlayUnenforcedCredits,
  proratePaidDelta,
  utcMonthCycle,
  type LedgerSnapshot,
} from './credits-policy';
import { isBillingEnforced } from '@/lib/ai-platform/subscription-access';

export {
  ENTERPRISE_PLAN_ID,
  FREE_PLAN_ID,
  InsufficientCreditsError,
  PRO_PLAN_ID,
  STARTER_PLAN_ID,
} from './credits-policy';

export type BillingPlan = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  priceCents: number;
  yearlyPriceCents: number;
  billingCadence: 'monthly' | 'yearly';
  paidCreditAmount: number;
  bonusCreditPercent: number;
  rolloverMonthsCap: number;
  isCustom: boolean;
  isRecommended: boolean;
  bonusTermsCopy: string;
  features: string[];
  sortOrder: number;
};

export type CreditPack = {
  id: string;
  name: string;
  creditAmount: number;
  priceCents: number;
  paidTiersOnly: boolean;
};

export type CreditBalance = {
  planId: string;
  planName: string;
  paidRemaining: number;
  bonusRemaining: number;
  bonusUnlocked: boolean;
  bonusExpiresAt: string | null;
  total: number;
  cycleStart: string | null;
  cycleEnd: string | null;
};

function withReportedCreditBalance(balance: CreditBalance): CreditBalance {
  return overlayUnenforcedCredits(balance, isBillingEnforced());
}

type PlanRow = {
  id: string;
  name: string;
  display_name: string;
  description: string;
  price_cents: number;
  yearly_price_cents: number;
  billing_cadence: 'monthly' | 'yearly';
  paid_credit_amount: number;
  bonus_credit_percent: number;
  rollover_months_cap: number;
  is_custom: number | boolean;
  is_recommended: number | boolean;
  bonus_terms_copy: string;
  features_json: unknown;
  sort_order: number;
};

type LedgerRow = {
  id: string;
  user_id: string;
  plan_id: string;
  cycle_start: Date | string;
  cycle_end: Date | string;
  paid_credits_granted: number;
  paid_credits_remaining: number;
  bonus_credits_granted: number;
  bonus_credits_remaining: number;
  bonus_unlocked: number | boolean;
  bonus_percent_snapshot: number;
  bonus_expires_at: Date | string | null;
  rolled_over_from_cycle_id: string | null;
};

type SubscriptionRow = {
  id: string;
  user_id: string;
  plan_id: string;
  status: string;
  billing_cadence: 'monthly' | 'yearly';
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  razorpay_customer_id: string | null;
  razorpay_subscription_id: string | null;
  current_period_start: Date | string;
  current_period_end: Date | string;
};

type ContractRow = {
  paid_credit_amount: number;
  bonus_credit_percent: number;
  rollover_months_cap: number;
  seat_count: number;
};

type ProvisionOptions = {
  now?: Date;
  source?: string;
  cadence?: 'monthly' | 'yearly';
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  razorpayCustomerId?: string | null;
  razorpaySubscriptionId?: string | null;
};

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toMysqlDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function asBool(value: number | boolean): boolean {
  return Boolean(value);
}

function parseFeatures(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function mapPlan(row: PlanRow): BillingPlan {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    priceCents: Number(row.price_cents),
    yearlyPriceCents: Number(row.yearly_price_cents),
    billingCadence: row.billing_cadence,
    paidCreditAmount: Number(row.paid_credit_amount),
    bonusCreditPercent: Number(row.bonus_credit_percent),
    rolloverMonthsCap: Number(row.rollover_months_cap),
    isCustom: asBool(row.is_custom),
    isRecommended: asBool(row.is_recommended),
    bonusTermsCopy: row.bonus_terms_copy,
    features: parseFeatures(row.features_json),
    sortOrder: Number(row.sort_order),
  };
}

function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_TABLE_ERROR';
}

function isDuplicate(error: unknown): boolean {
  return (error as { code?: string }).code === 'ER_DUP_ENTRY';
}

export const FALLBACK_PLANS: BillingPlan[] = [
  {
    id: FREE_PLAN_ID,
    name: FREE_PLAN_ID,
    displayName: 'Free',
    description: 'For exploring secure agentic deployment',
    priceCents: 0,
    yearlyPriceCents: 0,
    billingCadence: 'monthly',
    paidCreditAmount: 5,
    bonusCreditPercent: 0,
    rolloverMonthsCap: 0,
    isCustom: false,
    isRecommended: false,
    bonusTermsCopy:
      'The Free plan includes a small monthly allotment of paid credits. Unused paid credits do not roll over, and this plan never receives bonus credits.',
    features: ['1 project', 'Repo analysis agent', 'Basic security scan', 'Community support'],
    sortOrder: 10,
  },
  {
    id: 'starter_20',
    name: 'starter_20',
    displayName: 'Starter',
    description: 'For individuals shipping production workloads',
    priceCents: 2000,
    yearlyPriceCents: 19200,
    billingCadence: 'monthly',
    paidCreditAmount: 20,
    bonusCreditPercent: 25,
    rolloverMonthsCap: 1,
    isCustom: false,
    isRecommended: false,
    bonusTermsCopy:
      'Paid credits are granted at the start of each billing cycle. After you use every paid credit, up to 25% extra bonus credits unlock. Bonus credits expire at the end of the calendar month they were unlocked and never roll over. Unused paid credits may roll over for one additional month.',
    features: ['Unlimited projects', 'Security scanning', 'Terraform generation', 'Email support'],
    sortOrder: 20,
  },
  {
    id: 'pro_50',
    name: 'pro_50',
    displayName: 'Pro',
    description: 'For growing teams and platforms',
    priceCents: 5000,
    yearlyPriceCents: 48000,
    billingCadence: 'monthly',
    paidCreditAmount: 50,
    bonusCreditPercent: 40,
    rolloverMonthsCap: 2,
    isCustom: false,
    isRecommended: true,
    bonusTermsCopy:
      'Paid credits are granted at the start of each billing cycle. After you use every paid credit, up to 40% extra bonus credits unlock. Bonus credits expire at the end of the calendar month they were unlocked and never roll over. Unused paid credits may roll over for up to two additional months.',
    features: [
      'Everything in Starter',
      'Frontend customizations',
      'Vulnerability fixes',
      'Traffic-based cost estimation',
      'Priority support',
    ],
    sortOrder: 30,
  },
  {
    id: ENTERPRISE_PLAN_ID,
    name: ENTERPRISE_PLAN_ID,
    displayName: 'Enterprise',
    description: 'For large-scale operations',
    priceCents: 0,
    yearlyPriceCents: 0,
    billingCadence: 'monthly',
    paidCreditAmount: 0,
    bonusCreditPercent: 0,
    rolloverMonthsCap: 0,
    isCustom: true,
    isRecommended: false,
    bonusTermsCopy:
      'Enterprise credits are provisioned from your contract rather than standard plan math. Contact sales to set pooled allotments, seats, bonus terms, and rollover. Bonus credits still expire at calendar month-end after they unlock.',
    features: [
      'Everything in Pro',
      'Custom contracts',
      'Pooled credits across seats',
      '24/7 dedicated support',
      'SLA and security review',
    ],
    sortOrder: 40,
  },
];

export const FALLBACK_PACKS: CreditPack[] = [
  { id: 'pack_10', name: '10 extra credits', creditAmount: 10, priceCents: 1200, paidTiersOnly: true },
  { id: 'pack_25', name: '25 extra credits', creditAmount: 25, priceCents: 3200, paidTiersOnly: true },
  { id: 'pack_50', name: '50 extra credits', creditAmount: 50, priceCents: 7000, paidTiersOnly: true },
];

export async function listPlans(): Promise<BillingPlan[]> {
  try {
    const rows = await query<PlanRow[]>(
      `SELECT * FROM billing_plans ORDER BY sort_order ASC, name ASC`,
    );
    return rows.map(mapPlan);
  } catch (error) {
    if (isMissingTable(error)) return FALLBACK_PLANS;
    throw error;
  }
}

export async function listCreditPacks(): Promise<CreditPack[]> {
  try {
    const rows = await query<Array<{
      id: string;
      name: string;
      credit_amount: number;
      price_cents: number;
      paid_tiers_only: number | boolean;
    }>>(`SELECT * FROM credit_packs ORDER BY credit_amount ASC`);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      creditAmount: Number(row.credit_amount),
      priceCents: Number(row.price_cents),
      paidTiersOnly: asBool(row.paid_tiers_only),
    }));
  } catch (error) {
    if (isMissingTable(error)) return FALLBACK_PACKS;
    throw error;
  }
}

async function getPlan(exec: SqlExecutor, planId: string): Promise<BillingPlan> {
  const rows = await exec<PlanRow[]>(`SELECT * FROM billing_plans WHERE id = ? LIMIT 1`, [planId]);
  if (!rows[0]) throw new Error(`Unknown billing plan: ${planId}`);
  return mapPlan(rows[0]);
}

async function getContract(exec: SqlExecutor, userId: string): Promise<ContractRow | null> {
  const rows = await exec<ContractRow[]>(
    `SELECT paid_credit_amount, bonus_credit_percent, rollover_months_cap, seat_count
     FROM enterprise_contracts WHERE user_id = ? LIMIT 1`,
    [userId],
  );
  return rows[0] || null;
}

function resolveGrantAmounts(plan: BillingPlan, contract: ContractRow | null): {
  paidCreditAmount: number;
  bonusPercent: number;
  rolloverMonthsCap: number;
} {
  if (plan.isCustom) {
    if (!contract) {
      return { paidCreditAmount: 0, bonusPercent: 0, rolloverMonthsCap: 0 };
    }
    // TODO: enterprise seat pooling is modeled (seat_count) but v1 grants to this account only.
    return {
      paidCreditAmount: Number(contract.paid_credit_amount),
      bonusPercent: Number(contract.bonus_credit_percent),
      rolloverMonthsCap: Number(contract.rollover_months_cap),
    };
  }
  return {
    paidCreditAmount: plan.paidCreditAmount,
    bonusPercent: plan.bonusCreditPercent,
    rolloverMonthsCap: plan.rolloverMonthsCap,
  };
}

async function insertTxn(
  exec: SqlExecutor,
  input: {
    userId: string;
    ledgerId: string;
    type: string;
    amount: number;
    balanceAfter: number;
    source: string;
  },
) {
  await exec(
    `INSERT INTO credit_transactions (id, user_id, ledger_id, type, amount, balance_after, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), input.userId, input.ledgerId, input.type, input.amount, input.balanceAfter, input.source],
  );
}

function snapshotFromLedger(row: LedgerRow, plan: BillingPlan): LedgerSnapshot {
  return {
    paidRemaining: Number(row.paid_credits_remaining),
    bonusRemaining: Number(row.bonus_credits_remaining),
    bonusUnlocked: asBool(row.bonus_unlocked),
    bonusGranted: Number(row.bonus_credits_granted),
    bonusExpiresAt: asDate(row.bonus_expires_at),
    paidCreditAmount: plan.paidCreditAmount,
    bonusPercent: Number(row.bonus_percent_snapshot) || plan.bonusCreditPercent,
    planName: plan.name,
  };
}

async function currentLedgerForUpdate(exec: SqlExecutor, userId: string, now: Date): Promise<LedgerRow | null> {
  const rows = await exec<LedgerRow[]>(
    `SELECT * FROM credit_ledgers
     WHERE user_id = ?
       AND cycle_start <= ?
       AND cycle_end >= ?
     ORDER BY cycle_start DESC
     LIMIT 1
     FOR UPDATE`,
    [userId, toMysqlDateTime(now), toMysqlDateTime(now)],
  );
  return rows[0] || null;
}

async function latestLedgerForUpdate(exec: SqlExecutor, userId: string): Promise<LedgerRow | null> {
  const rows = await exec<LedgerRow[]>(
    `SELECT * FROM credit_ledgers
     WHERE user_id = ?
     ORDER BY cycle_start DESC
     LIMIT 1
     FOR UPDATE`,
    [userId],
  );
  return rows[0] || null;
}

async function upsertSubscription(
  exec: SqlExecutor,
  input: {
    userId: string;
    planId: string;
    cadence: 'monthly' | 'yearly';
    periodStart: Date;
    periodEnd: Date;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    razorpayCustomerId?: string | null;
    razorpaySubscriptionId?: string | null;
    status?: string;
  },
) {
  const existing = await exec<SubscriptionRow[]>(
    `SELECT * FROM billing_subscriptions WHERE user_id = ? LIMIT 1 FOR UPDATE`,
    [input.userId],
  );
  if (existing[0]) {
    await exec(
      `UPDATE billing_subscriptions
       SET plan_id = ?, status = ?, billing_cadence = ?, current_period_start = ?, current_period_end = ?,
           stripe_customer_id = COALESCE(?, stripe_customer_id),
           stripe_subscription_id = COALESCE(?, stripe_subscription_id),
           razorpay_customer_id = COALESCE(?, razorpay_customer_id),
           razorpay_subscription_id = COALESCE(?, razorpay_subscription_id)
       WHERE user_id = ?`,
      [
        input.planId,
        input.status || 'active',
        input.cadence,
        toMysqlDateTime(input.periodStart),
        toMysqlDateTime(input.periodEnd),
        input.stripeCustomerId ?? null,
        input.stripeSubscriptionId ?? null,
        input.razorpayCustomerId ?? null,
        input.razorpaySubscriptionId ?? null,
        input.userId,
      ],
    );
    return existing[0].id;
  }
  const id = uuidv4();
  await exec(
    `INSERT INTO billing_subscriptions
      (id, user_id, plan_id, status, billing_cadence, stripe_customer_id, stripe_subscription_id,
       razorpay_customer_id, razorpay_subscription_id, current_period_start, current_period_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      input.planId,
      input.status || 'active',
      input.cadence,
      input.stripeCustomerId ?? null,
      input.stripeSubscriptionId ?? null,
      input.razorpayCustomerId ?? null,
      input.razorpaySubscriptionId ?? null,
      toMysqlDateTime(input.periodStart),
      toMysqlDateTime(input.periodEnd),
    ],
  );
  return id;
}

async function provisionCreditsOnRenewalWithExec(
  exec: SqlExecutor,
  userId: string,
  planId: string,
  options?: ProvisionOptions,
): Promise<{ ledgerId: string; created: boolean }> {
  const now = options?.now || new Date();
  const source = options?.source || 'subscription_renewal';
  const cycle = utcMonthCycle(now);
  const plan = await getPlan(exec, planId);
  const contract = plan.isCustom ? await getContract(exec, userId) : null;

  if (plan.isCustom && !contract) {
    await upsertSubscription(exec, {
      userId,
      planId,
      cadence: options?.cadence || 'monthly',
      periodStart: cycle.start,
      periodEnd: cycle.end,
      stripeCustomerId: options?.stripeCustomerId,
      stripeSubscriptionId: options?.stripeSubscriptionId,
      razorpayCustomerId: options?.razorpayCustomerId,
      razorpaySubscriptionId: options?.razorpaySubscriptionId,
    });
    return { ledgerId: '', created: false };
  }

  const grant = resolveGrantAmounts(plan, contract);
  const existing = await exec<LedgerRow[]>(
    `SELECT * FROM credit_ledgers WHERE user_id = ? AND cycle_start = ? LIMIT 1 FOR UPDATE`,
    [userId, toMysqlDateTime(cycle.start)],
  );
  if (existing[0]) {
    if (existing[0].plan_id !== planId) {
      await applyPlanChangeWithExec(exec, {
        userId,
        nextPlanId: planId,
        now,
        cadence: options?.cadence,
        stripeCustomerId: options?.stripeCustomerId,
        stripeSubscriptionId: options?.stripeSubscriptionId,
        razorpayCustomerId: options?.razorpayCustomerId,
        razorpaySubscriptionId: options?.razorpaySubscriptionId,
      });
    }
    return { ledgerId: existing[0].id, created: false };
  }

  await upsertSubscription(exec, {
    userId,
    planId,
    cadence: options?.cadence || 'monthly',
    periodStart: cycle.start,
    periodEnd: cycle.end,
    stripeCustomerId: options?.stripeCustomerId,
    stripeSubscriptionId: options?.stripeSubscriptionId,
    razorpayCustomerId: options?.razorpayCustomerId,
    razorpaySubscriptionId: options?.razorpaySubscriptionId,
  });

  const prior = await latestLedgerForUpdate(exec, userId);
  const rolloverPaid = prior
    ? cappedRollover(Number(prior.paid_credits_remaining), grant.paidCreditAmount, grant.rolloverMonthsCap)
    : 0;
  const paid = applyPaidGrant({
    previousPaidRemaining: prior ? Number(prior.paid_credits_remaining) : 0,
    grantPaid: grant.paidCreditAmount,
    rolloverPaid,
  });

  const ledgerId = uuidv4();
  try {
    await exec(
      `INSERT INTO credit_ledgers (
         id, user_id, plan_id, cycle_start, cycle_end,
         paid_credits_granted, paid_credits_remaining,
         bonus_credits_granted, bonus_credits_remaining,
         bonus_unlocked, bonus_percent_snapshot, bonus_expires_at, rolled_over_from_cycle_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, NULL, ?)`,
      [
        ledgerId,
        userId,
        planId,
        toMysqlDateTime(cycle.start),
        toMysqlDateTime(cycle.end),
        paid.paidGranted,
        paid.paidRemaining,
        grant.bonusPercent,
        prior && rolloverPaid > 0 ? prior.id : null,
      ],
    );
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    const raced = await exec<Array<{ id: string }>>(
      `SELECT id FROM credit_ledgers WHERE user_id = ? AND cycle_start = ? LIMIT 1`,
      [userId, toMysqlDateTime(cycle.start)],
    );
    return { ledgerId: raced[0]?.id || '', created: false };
  }

  await insertTxn(exec, {
    userId,
    ledgerId,
    type: 'grant_paid',
    amount: grant.paidCreditAmount,
    balanceAfter: paid.paidRemaining,
    source,
  });
  if (rolloverPaid > 0) {
    await insertTxn(exec, {
      userId,
      ledgerId,
      type: 'rollover',
      amount: rolloverPaid,
      balanceAfter: paid.paidRemaining,
      source,
    });
  }

  return { ledgerId, created: true };
}

export async function provisionCreditsOnRenewal(
  userId: string,
  planId: string,
  options?: ProvisionOptions,
): Promise<{ ledgerId: string; created: boolean }> {
  return withTransaction((exec) => provisionCreditsOnRenewalWithExec(exec, userId, planId, options));
}

export async function ensureUserBilling(userId: string): Promise<void> {
  if (!isBillingEnforced()) return;
  try {
    const existingSub = await query<Array<{ id: string }>>(
      `SELECT id FROM billing_subscriptions WHERE user_id = ? LIMIT 1`,
      [userId],
    );
    if (existingSub[0]) return;
    const existingLedger = await query<Array<{ id: string }>>(
      `SELECT id FROM credit_ledgers WHERE user_id = ? LIMIT 1`,
      [userId],
    );
    if (existingLedger[0]) return;
    // TODO: rate-limit/cap free-tier grants per user/IP/payment-fingerprint once fraud tooling exists.
    await provisionCreditsOnRenewal(userId, FREE_PLAN_ID, { source: 'free_tier_grant' });
  } catch (error) {
    if (isMissingTable(error)) return;
    console.warn('ensureUserBilling failed', error);
  }
}

export async function consumeCredits(
  userId: string,
  amount: number,
  source: string,
  options?: { now?: Date },
): Promise<{ paidRemaining: number; bonusRemaining: number; total: number; bonusUnlocked: boolean }> {
  const now = options?.now || new Date();
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('amount must be a positive integer');
  }

  if (!isBillingEnforced()) {
    const balance = await getBalance(userId, { now });
    return {
      paidRemaining: balance.paidRemaining,
      bonusRemaining: balance.bonusRemaining,
      total: balance.total,
      bonusUnlocked: balance.bonusUnlocked,
    };
  }

  return withTransaction(async (exec) => {
    let ledger = await currentLedgerForUpdate(exec, userId, now);
    if (!ledger) {
      const subs = await exec<Array<{ plan_id: string }>>(
        `SELECT plan_id FROM billing_subscriptions WHERE user_id = ? LIMIT 1`,
        [userId],
      );
      const planId = subs[0]?.plan_id || FREE_PLAN_ID;
      if (!subs[0]) {
        // TODO: rate-limit/cap free-tier grants per user/IP/payment-fingerprint once fraud tooling exists.
      }
      await provisionCreditsOnRenewalWithExec(exec, userId, planId, { now, source: 'free_tier_grant' });
      ledger = await currentLedgerForUpdate(exec, userId, now);
    }
    if (!ledger) {
      throw new InsufficientCreditsError(0, 0);
    }

    const plan = await getPlan(exec, ledger.plan_id);
    const result = consumeOnLockedLedger(snapshotFromLedger(ledger, plan), amount, now);
    if (!result.ok) {
      throw new InsufficientCreditsError(result.paidRemaining, result.bonusRemaining);
    }

    await exec(
      `UPDATE credit_ledgers
       SET paid_credits_remaining = ?,
           bonus_credits_remaining = ?,
           bonus_credits_granted = ?,
           bonus_unlocked = ?,
           bonus_expires_at = ?
       WHERE id = ?`,
      [
        result.next.paidRemaining,
        result.next.bonusRemaining,
        result.next.bonusGranted,
        result.next.bonusUnlocked ? 1 : 0,
        result.next.bonusExpiresAt ? toMysqlDateTime(result.next.bonusExpiresAt) : null,
        ledger.id,
      ],
    );

    for (const txn of result.transactions) {
      await insertTxn(exec, {
        userId,
        ledgerId: ledger.id,
        type: txn.type,
        amount: txn.amount,
        balanceAfter: txn.balanceAfter,
        source: txn.type === 'grant_bonus' ? 'bonus_unlock' : source,
      });
    }

    return {
      paidRemaining: result.next.paidRemaining,
      bonusRemaining: result.next.bonusRemaining,
      total: result.next.paidRemaining + result.next.bonusRemaining,
      bonusUnlocked: result.next.bonusUnlocked,
    };
  });
}

export async function expireBonusCredits(options?: { now?: Date }): Promise<number> {
  const now = options?.now || new Date();
  return withTransaction(async (exec) => {
    const rows = await exec<LedgerRow[]>(
      `SELECT * FROM credit_ledgers
       WHERE bonus_expires_at IS NOT NULL
         AND bonus_expires_at < ?
         AND bonus_credits_remaining > 0
       FOR UPDATE`,
      [toMysqlDateTime(now)],
    );
    let expiredCount = 0;
    for (const row of rows) {
      const plan = await getPlan(exec, row.plan_id);
      const expired = expireBonusOnLedger(snapshotFromLedger(row, plan), now);
      if (!expired) continue;
      await exec(
        `UPDATE credit_ledgers SET bonus_credits_remaining = 0 WHERE id = ?`,
        [row.id],
      );
      await insertTxn(exec, {
        userId: row.user_id,
        ledgerId: row.id,
        type: 'expire',
        amount: expired.expired,
        balanceAfter: expired.next.paidRemaining,
        source: 'bonus_month_end',
      });
      expiredCount += 1;
    }
    return expiredCount;
  });
}

export async function provisionDueCycles(options?: { now?: Date }): Promise<number> {
  const now = options?.now || new Date();
  try {
    const subs = await query<Array<{ user_id: string; plan_id: string; razorpay_subscription_id?: string | null }>>(
      `SELECT user_id, plan_id, razorpay_subscription_id FROM billing_subscriptions WHERE status = 'active'`,
    );
    let created = 0;
    for (const sub of subs) {
      if (sub.razorpay_subscription_id) continue;
      const result = await provisionCreditsOnRenewal(sub.user_id, sub.plan_id, {
        now,
        source: 'cycle_cron',
      });
      if (result.created) created += 1;
    }
    return created;
  } catch (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
}

export async function getBalance(userId: string, options?: { now?: Date }): Promise<CreditBalance> {
  const now = options?.now || new Date();
  try {
    await ensureUserBilling(userId);
    const rows = await query<LedgerRow[]>(
      `SELECT * FROM credit_ledgers
       WHERE user_id = ?
         AND cycle_start <= ?
         AND cycle_end >= ?
       ORDER BY cycle_start DESC
       LIMIT 1`,
      [userId, toMysqlDateTime(now), toMysqlDateTime(now)],
    );
    const ledger = rows[0];
    if (!ledger) {
      const sub = await getSubscription(userId);
      return withReportedCreditBalance({
        planId: sub?.planId || FREE_PLAN_ID,
        planName: sub?.planId || FREE_PLAN_ID,
        paidRemaining: 0,
        bonusRemaining: 0,
        bonusUnlocked: false,
        bonusExpiresAt: null,
        total: 0,
        cycleStart: null,
        cycleEnd: null,
      });
    }
    const planRows = await query<PlanRow[]>(`SELECT * FROM billing_plans WHERE id = ? LIMIT 1`, [ledger.plan_id]);
    const expires = asDate(ledger.bonus_expires_at);
    return withReportedCreditBalance({
      planId: ledger.plan_id,
      planName: planRows[0]?.name || ledger.plan_id,
      paidRemaining: Number(ledger.paid_credits_remaining),
      bonusRemaining: Number(ledger.bonus_credits_remaining),
      bonusUnlocked: asBool(ledger.bonus_unlocked),
      bonusExpiresAt: expires ? expires.toISOString() : null,
      total: Number(ledger.paid_credits_remaining) + Number(ledger.bonus_credits_remaining),
      cycleStart: asDate(ledger.cycle_start)?.toISOString() || null,
      cycleEnd: asDate(ledger.cycle_end)?.toISOString() || null,
    });
  } catch (error) {
    if (isMissingTable(error)) {
      return withReportedCreditBalance({
        planId: FREE_PLAN_ID,
        planName: FREE_PLAN_ID,
        paidRemaining: 0,
        bonusRemaining: 0,
        bonusUnlocked: false,
        bonusExpiresAt: null,
        total: 0,
        cycleStart: null,
        cycleEnd: null,
      });
    }
    throw error;
  }
}

async function grantPaidCreditsWithExec(
  exec: SqlExecutor,
  userId: string,
  creditAmount: number,
  options?: { now?: Date; source?: string },
): Promise<{ paidRemaining: number; bonusRemaining: number; total: number }> {
  const now = options?.now || new Date();
  const amount = Math.round(Number(creditAmount));
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('Credit amount must be a positive integer');
  }

  let ledger = await currentLedgerForUpdate(exec, userId, now);
  if (!ledger) {
    const subs = await exec<Array<{ plan_id: string }>>(
      `SELECT plan_id FROM billing_subscriptions WHERE user_id = ? LIMIT 1`,
      [userId],
    );
    await provisionCreditsOnRenewalWithExec(exec, userId, subs[0]?.plan_id || FREE_PLAN_ID, {
      now,
      source: 'free_tier_grant',
    });
    ledger = await currentLedgerForUpdate(exec, userId, now);
  }
  if (!ledger) throw new Error('No credit ledger for user');

  const nextPaid = Number(ledger.paid_credits_remaining) + amount;
  await exec(
    `UPDATE credit_ledgers
     SET paid_credits_remaining = ?, paid_credits_granted = paid_credits_granted + ?
     WHERE id = ?`,
    [nextPaid, amount, ledger.id],
  );
  await insertTxn(exec, {
    userId,
    ledgerId: ledger.id,
    type: 'grant_paid',
    amount,
    balanceAfter: nextPaid + Number(ledger.bonus_credits_remaining),
    source: (options?.source || 'grant_paid').slice(0, 64),
  });
  return {
    paidRemaining: nextPaid,
    bonusRemaining: Number(ledger.bonus_credits_remaining),
    total: nextPaid + Number(ledger.bonus_credits_remaining),
  };
}

export async function grantPaidCredits(
  userId: string,
  creditAmount: number,
  options?: { now?: Date; source?: string },
): Promise<{ paidRemaining: number; bonusRemaining: number; total: number }> {
  return withTransaction((exec) => grantPaidCreditsWithExec(exec, userId, creditAmount, options));
}

export async function grantTopUpCredits(
  userId: string,
  creditPackId: string,
  options?: { now?: Date; allowFreeTier?: boolean },
): Promise<{ paidRemaining: number; bonusRemaining: number; total: number }> {
  const now = options?.now || new Date();
  return withTransaction(async (exec) => {
    const packs = await exec<Array<{
      id: string;
      credit_amount: number;
      paid_tiers_only: number | boolean;
    }>>(`SELECT id, credit_amount, paid_tiers_only FROM credit_packs WHERE id = ? LIMIT 1`, [creditPackId]);
    const pack = packs[0];
    if (!pack) throw new Error('Unknown credit pack');

    const planRows = await exec<Array<{ plan_id: string }>>(
      `SELECT plan_id FROM billing_subscriptions WHERE user_id = ? LIMIT 1`,
      [userId],
    );
    let ledger = await currentLedgerForUpdate(exec, userId, now);
    const planId = ledger?.plan_id || planRows[0]?.plan_id || FREE_PLAN_ID;
    const plan = await getPlan(exec, planId);
    if (asBool(pack.paid_tiers_only) && plan.name === FREE_PLAN_ID && !options?.allowFreeTier) {
      throw new Error('Top-up packs are available on paid plans only');
    }

    return grantPaidCreditsWithExec(exec, userId, Number(pack.credit_amount), {
      now,
      source: `topup:${pack.id}`,
    });
  });
}

export async function purchaseTopUp(
  userId: string,
  creditPackId: string,
  options?: { now?: Date; allowFreeTier?: boolean; paymentConfirmed?: boolean },
): Promise<{ paidRemaining: number; bonusRemaining: number; total: number }> {
  if (!options?.paymentConfirmed) {
    throw new Error('Top-up credits are granted only after payment confirmation');
  }
  return grantTopUpCredits(userId, creditPackId, options);
}

export async function adminCreditGrant(input: {
  userId: string;
  paidCredits: number;
  bonusPercent?: number;
  rolloverMonthsCap?: number;
  seatCount?: number;
  notes?: string;
  now?: Date;
}): Promise<{ ledgerId: string }> {
  const now = input.now || new Date();
  const cycle = utcMonthCycle(now);
  return withTransaction(async (exec) => {
    await exec(
      `INSERT INTO enterprise_contracts
        (id, user_id, paid_credit_amount, bonus_credit_percent, rollover_months_cap, seat_count, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         paid_credit_amount = VALUES(paid_credit_amount),
         bonus_credit_percent = VALUES(bonus_credit_percent),
         rollover_months_cap = VALUES(rollover_months_cap),
         seat_count = VALUES(seat_count),
         notes = VALUES(notes)`,
      [
        uuidv4(),
        input.userId,
        input.paidCredits,
        input.bonusPercent ?? 0,
        input.rolloverMonthsCap ?? 0,
        input.seatCount ?? 1,
        input.notes ?? null,
      ],
    );
    await upsertSubscription(exec, {
      userId: input.userId,
      planId: ENTERPRISE_PLAN_ID,
      cadence: 'monthly',
      periodStart: cycle.start,
      periodEnd: cycle.end,
    });

    const existing = await currentLedgerForUpdate(exec, input.userId, now);
    if (existing) {
      await exec(
        `UPDATE credit_ledgers
         SET plan_id = ?,
             paid_credits_granted = ?,
             paid_credits_remaining = ?,
             bonus_percent_snapshot = ?
         WHERE id = ?`,
        [ENTERPRISE_PLAN_ID, input.paidCredits, input.paidCredits, input.bonusPercent ?? 0, existing.id],
      );
      await insertTxn(exec, {
        userId: input.userId,
        ledgerId: existing.id,
        type: 'grant_paid',
        amount: input.paidCredits,
        balanceAfter: input.paidCredits + Number(existing.bonus_credits_remaining),
        source: 'admin_adjustment',
      });
      return { ledgerId: existing.id };
    }

    const created = await provisionCreditsOnRenewalWithExec(exec, input.userId, ENTERPRISE_PLAN_ID, {
      now,
      source: 'admin_adjustment',
    });
    return { ledgerId: created.ledgerId };
  });
}

async function applyPlanChangeWithExec(
  exec: SqlExecutor,
  input: {
    userId: string;
    nextPlanId: string;
    now?: Date;
    cadence?: 'monthly' | 'yearly';
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    razorpayCustomerId?: string | null;
    razorpaySubscriptionId?: string | null;
  },
): Promise<{ paidRemaining: number; bonusRemaining: number; proratedDelta: number }> {
  const now = input.now || new Date();
  const nextPlan = await getPlan(exec, input.nextPlanId);
  const contract = nextPlan.isCustom ? await getContract(exec, input.userId) : null;
  const nextGrant = resolveGrantAmounts(nextPlan, contract);
  let ledger = await currentLedgerForUpdate(exec, input.userId, now);
  if (!ledger) {
    return { paidRemaining: 0, bonusRemaining: 0, proratedDelta: 0 };
  }
  if (ledger.plan_id === input.nextPlanId) {
    return {
      paidRemaining: Number(ledger.paid_credits_remaining),
      bonusRemaining: Number(ledger.bonus_credits_remaining),
      proratedDelta: 0,
    };
  }

  const currentPlan = await getPlan(exec, ledger.plan_id);
  const cycleStart = asDate(ledger.cycle_start) || utcMonthCycle(now).start;
  const cycleEnd = asDate(ledger.cycle_end) || utcMonthCycle(now).end;
  const previousPaidAmount = currentPlan.isCustom
    ? Number(ledger.paid_credits_granted)
    : currentPlan.paidCreditAmount;
  const delta = proratePaidDelta({
    previousPaidAmount,
    nextPaidAmount: nextGrant.paidCreditAmount,
    cycleStart,
    cycleEnd,
    now,
  });

  const paidRemaining = Math.max(0, Number(ledger.paid_credits_remaining) + delta);
  const bonusPercentSnapshot = asBool(ledger.bonus_unlocked)
    ? Number(ledger.bonus_percent_snapshot)
    : nextGrant.bonusPercent;

  await exec(
    `UPDATE credit_ledgers
     SET plan_id = ?, paid_credits_remaining = ?, bonus_percent_snapshot = ?
     WHERE id = ?`,
    [input.nextPlanId, paidRemaining, bonusPercentSnapshot, ledger.id],
  );
  await upsertSubscription(exec, {
    userId: input.userId,
    planId: input.nextPlanId,
    cadence: input.cadence || 'monthly',
    periodStart: cycleStart,
    periodEnd: cycleEnd,
    stripeCustomerId: input.stripeCustomerId,
    stripeSubscriptionId: input.stripeSubscriptionId,
    razorpayCustomerId: input.razorpayCustomerId,
    razorpaySubscriptionId: input.razorpaySubscriptionId,
  });

  if (delta !== 0) {
    await insertTxn(exec, {
      userId: input.userId,
      ledgerId: ledger.id,
      type: delta > 0 ? 'grant_paid' : 'refund',
      amount: Math.abs(delta),
      balanceAfter: paidRemaining + Number(ledger.bonus_credits_remaining),
      source: 'plan_proration',
    });
  }

  return {
    paidRemaining,
    bonusRemaining: Number(ledger.bonus_credits_remaining),
    proratedDelta: delta,
  };
}

export async function applyPlanChange(input: {
  userId: string;
  nextPlanId: string;
  now?: Date;
  cadence?: 'monthly' | 'yearly';
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  razorpayCustomerId?: string | null;
  razorpaySubscriptionId?: string | null;
}): Promise<{ paidRemaining: number; bonusRemaining: number; proratedDelta: number }> {
  const now = input.now || new Date();
  return withTransaction(async (exec) => {
    const ledger = await currentLedgerForUpdate(exec, input.userId, now);
    if (!ledger) {
      await provisionCreditsOnRenewalWithExec(exec, input.userId, input.nextPlanId, {
        now,
        cadence: input.cadence,
        stripeCustomerId: input.stripeCustomerId,
        stripeSubscriptionId: input.stripeSubscriptionId,
        razorpayCustomerId: input.razorpayCustomerId,
        razorpaySubscriptionId: input.razorpaySubscriptionId,
      });
      const created = await currentLedgerForUpdate(exec, input.userId, now);
      if (!created) return { paidRemaining: 0, bonusRemaining: 0, proratedDelta: 0 };
      if (created.plan_id === input.nextPlanId) {
        return {
          paidRemaining: Number(created.paid_credits_remaining),
          bonusRemaining: Number(created.bonus_credits_remaining),
          proratedDelta: 0,
        };
      }
    }
    return applyPlanChangeWithExec(exec, input);
  });
}

export async function getSubscription(userId: string): Promise<{
  planId: string;
  status: string;
  cadence: string;
  razorpayCustomerId: string | null;
  razorpaySubscriptionId: string | null;
} | null> {
  try {
    const rows = await query<SubscriptionRow[]>(
      `SELECT * FROM billing_subscriptions WHERE user_id = ? LIMIT 1`,
      [userId],
    );
    if (!rows[0]) return null;
    return {
      planId: rows[0].plan_id,
      status: rows[0].status,
      cadence: rows[0].billing_cadence,
      razorpayCustomerId: rows[0].razorpay_customer_id ?? null,
      razorpaySubscriptionId: rows[0].razorpay_subscription_id ?? null,
    };
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

export async function findUserIdByRazorpaySubscription(subscriptionId: string): Promise<string | null> {
  try {
    const rows = await query<Array<{ user_id: string }>>(
      `SELECT user_id FROM billing_subscriptions WHERE razorpay_subscription_id = ? LIMIT 1`,
      [subscriptionId],
    );
    return rows[0]?.user_id || null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

export async function findUserIdByStripeCustomer(customerId: string): Promise<string | null> {
  const rows = await query<Array<{ user_id: string }>>(
    `SELECT user_id FROM billing_subscriptions WHERE stripe_customer_id = ? LIMIT 1`,
    [customerId],
  );
  return rows[0]?.user_id || null;
}

export async function findUserIdByStripeSubscription(subscriptionId: string): Promise<string | null> {
  const rows = await query<Array<{ user_id: string }>>(
    `SELECT user_id FROM billing_subscriptions WHERE stripe_subscription_id = ? LIMIT 1`,
    [subscriptionId],
  );
  return rows[0]?.user_id || null;
}
