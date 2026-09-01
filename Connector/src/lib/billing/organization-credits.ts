import { randomUUID } from 'node:crypto';
import { query, withNamedLock, withTransaction, type SqlExecutor } from '@/lib/db';
import {
  CREDIT_CATALOG_VERSION,
  CREDIT_UNITS_PER_CREDIT,
  CREDIT_VALUE_PAISE,
  DEFAULT_METERING_FX_INR_PER_USD,
  creditsToUnits,
  providerCostUsdToUnits,
  unitsToCredits,
  catalogPack,
  catalogPlan,
} from './credit-catalog';
import { getOrganizationSubscription } from './credits';

export type CreditMeteringMode = 'off' | 'shadow' | 'enforce';

export type OrganizationCreditBalance = {
  organizationId: string;
  availableUnits: bigint;
  reservedUnits: bigint;
  balanceUnits: bigint;
  lifetimeGrantedUnits: bigint;
  lifetimeConsumedUnits: bigint;
  lifetimeRefundedUnits: bigint;
  debtUnits: bigint;
  status: 'ACTIVE' | 'DEBT' | 'FROZEN';
};

export type CreditValuation = {
  id: string;
  creditValuePaise: number;
  unitsPerCredit: number;
  usdToInr: number;
  pricingMaxAgeHours: number;
};

export type CreditReservation = {
  id: string;
  organizationId: string;
  requestId: string;
  attemptKey: string;
  reservedUnits: bigint;
  status: 'RESERVED' | 'SETTLED' | 'RELEASED' | 'SHADOW' | 'OFF';
  valuation: CreditValuation;
};

type WalletRow = {
  organization_id: string;
  balance_units: string | number;
  reserved_units: string | number;
  lifetime_granted_units: string | number;
  lifetime_consumed_units: string | number;
  lifetime_refunded_units: string | number;
  debt_units: string | number;
  status: OrganizationCreditBalance['status'];
};

type ValuationRow = {
  id: string;
  credit_value_paise: number | string;
  units_per_credit: number | string;
  usd_to_inr: number | string;
  pricing_max_age_hours: number | string;
};

type ReservationRow = {
  id: string;
  organization_id: string;
  request_id: string;
  attempt_key: string;
  reserved_units: string | number;
  status: CreditReservation['status'];
  valuation_version_id: string;
};

export class InsufficientOrganizationCreditsError extends Error {
  readonly code = 'insufficient_organization_credits';
  readonly status = 402;
  readonly organizationId: string;
  readonly availableUnits: bigint;
  readonly requiredUnits: bigint;
  readonly topUpPath = '/dashboard/billing?view=credits';

  constructor(input: { organizationId: string; availableUnits: bigint; requiredUnits: bigint }) {
    super('This organization does not have enough managed-LLM credits');
    this.name = 'InsufficientOrganizationCreditsError';
    this.organizationId = input.organizationId;
    this.availableUnits = input.availableUnits;
    this.requiredUnits = input.requiredUnits;
  }
}

/**
 * Organization credit metering rollout:
 * - CREDIT_METERING_MODE=off     — no wallet debits (default)
 * - CREDIT_METERING_MODE=shadow — record reservations without debiting
 * - CREDIT_METERING_MODE=enforce — reserve and debit managed-key LLM calls; HTTP 402 when insufficient
 */
export function creditMeteringMode(env: NodeJS.ProcessEnv = process.env): CreditMeteringMode {
  const mode = env.CREDIT_METERING_MODE?.trim().toLowerCase();
  if (mode === 'shadow' || mode === 'enforce' || mode === 'off') return mode;
  return 'enforce';
}

function toBigInt(value: bigint | number | string | null | undefined): bigint {
  if (typeof value === 'bigint') return value;
  if (value == null || value === '') return 0n;
  return BigInt(String(value));
}

function mapWallet(row: WalletRow): OrganizationCreditBalance {
  const balanceUnits = toBigInt(row.balance_units);
  const reservedUnits = toBigInt(row.reserved_units);
  return {
    organizationId: row.organization_id,
    balanceUnits,
    reservedUnits,
    availableUnits: balanceUnits - reservedUnits,
    lifetimeGrantedUnits: toBigInt(row.lifetime_granted_units),
    lifetimeConsumedUnits: toBigInt(row.lifetime_consumed_units),
    lifetimeRefundedUnits: toBigInt(row.lifetime_refunded_units),
    debtUnits: toBigInt(row.debt_units),
    status: row.status,
  };
}

async function ensureWallet(exec: SqlExecutor, organizationId: string) {
  await exec(
    `INSERT IGNORE INTO organization_credit_wallets (organization_id) VALUES (?)`,
    [organizationId],
  );
}

async function activeValuation(exec: SqlExecutor = query): Promise<CreditValuation> {
  const rows = await exec<ValuationRow[]>(
    `SELECT id, credit_value_paise, units_per_credit, usd_to_inr, pricing_max_age_hours
     FROM credit_valuation_versions WHERE active = 1 ORDER BY effective_at DESC LIMIT 1`,
  );
  const row = rows[0];
  if (!row) {
    return {
      id: 'v2-inr-95',
      creditValuePaise: CREDIT_VALUE_PAISE,
      unitsPerCredit: CREDIT_UNITS_PER_CREDIT,
      usdToInr: DEFAULT_METERING_FX_INR_PER_USD,
      pricingMaxAgeHours: 720,
    };
  }
  return {
    id: row.id,
    creditValuePaise: Number(row.credit_value_paise),
    unitsPerCredit: Number(row.units_per_credit),
    usdToInr: Number(row.usd_to_inr),
    pricingMaxAgeHours: Number(row.pricing_max_age_hours),
  };
}

export async function getActiveCreditValuation(): Promise<CreditValuation> {
  return activeValuation();
}

export async function reconcileOrganizationSubscriptionCredits(organizationId: string): Promise<{
  reconciled: boolean;
  deltaCredits: number;
}> {
  const subscription = await getOrganizationSubscription(organizationId);
  if (!subscription?.planId || subscription.planId === 'free') {
    return { reconciled: false, deltaCredits: 0 };
  }

  const plan = catalogPlan(subscription.planId);
  if (!plan || plan.id === 'free') {
    return { reconciled: false, deltaCredits: 0 };
  }

  const expectedCredits = expectedSubscriptionGrantCredits(
    subscription.planId,
    subscription.cadence === 'yearly' ? 'yearly' : 'monthly',
  );

  const rows = await query<Array<{ granted_units: string | number }>>(
    `SELECT granted_units FROM organization_credit_grants
     WHERE organization_id = ? AND plan_id = ?
       AND source_type IN ('payment', 'subscription_release', 'sandbox')
       AND sandbox = 0`,
    [organizationId, subscription.planId],
  );

  let grantedUnits = 0n;
  for (const row of rows) {
    grantedUnits += toBigInt(row.granted_units);
  }
  const grantedCredits = unitsToCredits(grantedUnits);
  if (grantedCredits >= expectedCredits) {
    return { reconciled: false, deltaCredits: 0 };
  }

  const deltaCredits = expectedCredits - grantedCredits;
  await grantOrganizationCredits({
    organizationId,
    credits: deltaCredits,
    sourceType: 'migration',
    idempotencyKey: `catalog-v2-reconcile:${organizationId}:${subscription.planId}`,
    planId: subscription.planId,
    providerBudgetPaise: deltaCredits * CREDIT_VALUE_PAISE,
  });
  return { reconciled: true, deltaCredits };
}

export async function getOrganizationCreditBalance(organizationId: string): Promise<OrganizationCreditBalance> {
  await ensureWallet(query, organizationId);
  const rows = await query<WalletRow[]>(
    `SELECT organization_id, balance_units, reserved_units, lifetime_granted_units,
            lifetime_consumed_units, lifetime_refunded_units, debt_units, status
     FROM organization_credit_wallets WHERE organization_id = ? LIMIT 1`,
    [organizationId],
  );
  if (!rows[0]) throw new Error('Organization credit wallet is unavailable');
  return mapWallet(rows[0]);
}

export async function grantOrganizationCredits(input: {
  organizationId: string;
  userId?: string | null;
  credits: number;
  sourceType: 'payment' | 'subscription_release' | 'promotion' | 'admin' | 'migration' | 'sandbox';
  sourceId?: string | null;
  idempotencyKey: string;
  planId?: string | null;
  creditPackId?: string | null;
  providerBudgetPaise?: number;
  sandbox?: boolean;
}): Promise<{ grantId: string; units: bigint; balance: OrganizationCreditBalance; duplicate: boolean }> {
  const units = creditsToUnits(input.credits);
  if (units <= 0n) throw new Error('Credit grant must be positive');
  const grantId = randomUUID();
  const result = await withTransaction(async (exec) => {
    await ensureWallet(exec, input.organizationId);
    const duplicate = await exec<Array<{ id: string }>>(
      `SELECT id FROM organization_credit_grants WHERE organization_id = ? AND idempotency_key = ? LIMIT 1`,
      [input.organizationId, input.idempotencyKey],
    );
    if (duplicate[0]) {
      const wallet = await exec<WalletRow[]>(
        `SELECT * FROM organization_credit_wallets WHERE organization_id = ? LIMIT 1`,
        [input.organizationId],
      );
      return { grantId: duplicate[0].id, units, balance: mapWallet(wallet[0]), duplicate: true };
    }

    await exec(
      `INSERT INTO organization_credit_grants (
         id, organization_id, granted_to_user_id, source_type, source_id, idempotency_key,
         catalog_version, plan_id, credit_pack_id, granted_units, remaining_units,
         provider_budget_paise, sandbox, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        grantId,
        input.organizationId,
        input.userId || null,
        input.sourceType,
        input.sourceId || null,
        input.idempotencyKey,
        CREDIT_CATALOG_VERSION,
        input.planId || null,
        input.creditPackId || null,
        units.toString(),
        units.toString(),
        input.providerBudgetPaise ?? Math.round(input.credits * CREDIT_VALUE_PAISE),
        input.sandbox ? 1 : 0,
      ],
    );
    await exec(
      `UPDATE organization_credit_wallets
       SET balance_units = balance_units + ?, lifetime_granted_units = lifetime_granted_units + ?,
           debt_units = GREATEST(0, debt_units - ?),
           status = CASE WHEN debt_units <= ? AND balance_units + ? >= 0 AND status = 'DEBT' THEN 'ACTIVE' ELSE status END,
           version = version + 1
       WHERE organization_id = ?`,
      [units.toString(), units.toString(), units.toString(), units.toString(), units.toString(), input.organizationId],
    );
    const walletRows = await exec<WalletRow[]>(
      `SELECT * FROM organization_credit_wallets WHERE organization_id = ? FOR UPDATE`,
      [input.organizationId],
    );
    const wallet = mapWallet(walletRows[0]);
    await exec(
      `INSERT INTO organization_credit_transactions (
         id, organization_id, actor_user_id, grant_id, type, amount_units, balance_after_units,
         reserved_after_units, idempotency_key, source, metadata_json
       ) VALUES (?, ?, ?, ?, 'GRANT', ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), input.organizationId, input.userId || null, grantId, units.toString(),
        wallet.balanceUnits.toString(), wallet.reservedUnits.toString(), `grant:${input.idempotencyKey}`,
        input.sourceType, JSON.stringify({ sourceId: input.sourceId || null, credits: input.credits, neverExpires: true }),
      ],
    );
    return { grantId, units, balance: wallet, duplicate: false };
  });
  if (!result.duplicate && input.providerBudgetPaise && input.providerBudgetPaise > 0) {
    const { provisionOpenRouterKeyForCreditGrant } = await import('./openrouter-provisioning');
    await provisionOpenRouterKeyForCreditGrant({
      organizationId: input.organizationId,
      providerBudgetPaise: input.providerBudgetPaise,
    });
  }
  return result;
}

export async function fulfillOrganizationCreditPurchase(input: {
  organizationId: string;
  userId: string;
  paymentId: string;
  planId?: string | null;
  creditPackId?: string | null;
  cadence?: 'monthly' | 'yearly' | null;
  paymentMode: 'test' | 'live';
}) {
  const sandbox = input.paymentMode === 'test';
  if (sandbox && process.env.NODE_ENV === 'production') {
    throw new Error('Test-mode payments cannot create credits in production');
  }
  if (input.creditPackId) {
    const pack = catalogPack(input.creditPackId);
    if (!pack) throw new Error('Unknown v2 credit top-up');
    return grantOrganizationCredits({
      organizationId: input.organizationId,
      userId: input.userId,
      credits: pack.credits,
      sourceType: sandbox ? 'sandbox' : 'payment',
      sourceId: input.paymentId,
      idempotencyKey: `payment:${input.paymentId}`,
      creditPackId: pack.id,
      providerBudgetPaise: pack.providerBudgetPaise,
      sandbox,
    });
  }
  const plan = catalogPlan(input.planId || '');
  if (!plan || plan.id === 'free') throw new Error('Unknown paid v2 plan');
  if (input.cadence !== 'yearly') {
    return grantOrganizationCredits({
      organizationId: input.organizationId,
      userId: input.userId,
      credits: plan.monthlyCredits,
      sourceType: sandbox ? 'sandbox' : 'payment',
      sourceId: input.paymentId,
      idempotencyKey: `payment:${input.paymentId}`,
      planId: plan.id,
      providerBudgetPaise: plan.providerBudgetPaiseMonthly,
      sandbox,
    });
  }
  const schedule = plan.annualReleaseSchedule;
  if (!schedule) throw new Error('Annual credit release schedule is missing');
  const first = await grantOrganizationCredits({
    organizationId: input.organizationId,
    userId: input.userId,
    credits: schedule.creditsPerRelease,
    sourceType: sandbox ? 'sandbox' : 'subscription_release',
    sourceId: input.paymentId,
    idempotencyKey: `annual:${input.paymentId}:1`,
    planId: plan.id,
    providerBudgetPaise: schedule.creditsPerRelease * CREDIT_VALUE_PAISE,
    sandbox,
  });
  await query(
    `INSERT INTO organization_credit_release_schedules (
       id, organization_id, user_id, source_payment_id, plan_id, units_per_release,
       provider_budget_paise_per_release, releases_total, releases_completed, next_release_at, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, DATE_ADD(NOW(), INTERVAL 1 MONTH), 'ACTIVE')
     ON DUPLICATE KEY UPDATE source_payment_id = VALUES(source_payment_id)`,
    [
      randomUUID(), input.organizationId, input.userId, input.paymentId, plan.id,
      creditsToUnits(schedule.creditsPerRelease).toString(), schedule.creditsPerRelease * CREDIT_VALUE_PAISE,
      schedule.releases,
    ],
  );
  return first;
}

export async function provisionDueOrganizationCreditReleases(now = new Date()): Promise<number> {
  const due = await query<Array<{
    id: string;
    organization_id: string;
    user_id: string;
    source_payment_id: string;
    plan_id: string;
    units_per_release: string | number;
    provider_budget_paise_per_release: string | number;
    releases_total: number;
    releases_completed: number;
  }>>(
    `SELECT * FROM organization_credit_release_schedules
     WHERE status = 'ACTIVE' AND next_release_at <= ? ORDER BY next_release_at ASC LIMIT 100`,
    [now.toISOString().slice(0, 19).replace('T', ' ')],
  );
  let released = 0;
  for (const schedule of due) {
    await withNamedLock(`credit-release:${schedule.id}`, 10, async () => {
      const current = await query<typeof due>(
        `SELECT * FROM organization_credit_release_schedules WHERE id = ? AND status = 'ACTIVE' AND next_release_at <= ? LIMIT 1`,
        [schedule.id, now.toISOString().slice(0, 19).replace('T', ' ')],
      );
      const item = current[0];
      if (!item) return;
      const releaseNumber = Number(item.releases_completed) + 1;
      await grantOrganizationCredits({
        organizationId: item.organization_id,
        userId: item.user_id,
        credits: unitsToCredits(item.units_per_release),
        sourceType: 'subscription_release',
        sourceId: item.source_payment_id,
        idempotencyKey: `annual:${item.source_payment_id}:${releaseNumber}`,
        planId: item.plan_id,
        providerBudgetPaise: Number(item.provider_budget_paise_per_release),
      });
      const complete = releaseNumber >= Number(item.releases_total);
      await query(
        `UPDATE organization_credit_release_schedules
         SET releases_completed = ?, next_release_at = DATE_ADD(next_release_at, INTERVAL 1 MONTH),
             status = ? WHERE id = ?`,
        [releaseNumber, complete ? 'COMPLETED' : 'ACTIVE', item.id],
      );
      released += 1;
    });
  }
  return released;
}

export async function refundOrganizationCreditsForPayment(input: {
  organizationId: string;
  actorUserId?: string | null;
  paymentId: string;
  refundId: string;
  refundAmountPaise: number;
  paymentTotalPaise: number;
  reason?: string;
}): Promise<{ refundedUnits: bigint; debtUnits: bigint; duplicate: boolean }> {
  if (!Number.isInteger(input.refundAmountPaise) || input.refundAmountPaise <= 0) throw new Error('Invalid refund amount');
  if (!Number.isInteger(input.paymentTotalPaise) || input.paymentTotalPaise <= 0) throw new Error('Invalid payment total');
  return withTransaction(async (exec) => {
    await ensureWallet(exec, input.organizationId);
    const duplicate = await exec<Array<{ id: string }>>(
      `SELECT id FROM organization_credit_transactions WHERE organization_id = ? AND idempotency_key = ? LIMIT 1`,
      [input.organizationId, `refund:${input.refundId}`],
    );
    if (duplicate[0]) return { refundedUnits: BigInt(0), debtUnits: BigInt(0), duplicate: true };

    const grants = await exec<Array<{ id: string; granted_units: string | number; remaining_units: string | number }>>(
      `SELECT id, granted_units, remaining_units FROM organization_credit_grants
       WHERE organization_id = ? AND source_id = ? ORDER BY created_at ASC FOR UPDATE`,
      [input.organizationId, input.paymentId],
    );
    if (!grants.length) throw new Error('The payment has no linked organization credit grant');
    let refundUnits = BigInt(0);
    let shortfallUnits = BigInt(0);
    const grantIds: string[] = [];
    for (const grant of grants) {
      const target = toBigInt(grant.granted_units) * BigInt(input.refundAmountPaise) / BigInt(input.paymentTotalPaise);
      if (target <= 0) continue;
      const remaining = toBigInt(grant.remaining_units);
      const unused = remaining < target ? remaining : target;
      const shortfall = target - unused;
      await exec(`UPDATE organization_credit_grants SET remaining_units = remaining_units - ? WHERE id = ?`, [unused.toString(), grant.id]);
      refundUnits += target;
      shortfallUnits += shortfall;
      grantIds.push(grant.id);
    }
    if (refundUnits <= 0) throw new Error('Refund is too small to map to credit units');

    const walletRows = await exec<WalletRow[]>(
      `SELECT * FROM organization_credit_wallets WHERE organization_id = ? FOR UPDATE`,
      [input.organizationId],
    );
    const wallet = mapWallet(walletRows[0]);
    const balanceAfter = wallet.balanceUnits - refundUnits;
    const debtAfter = wallet.debtUnits + shortfallUnits;
    await exec(
      `UPDATE organization_credit_wallets
       SET balance_units = balance_units - ?, lifetime_refunded_units = lifetime_refunded_units + ?,
           debt_units = debt_units + ?, status = CASE WHEN ? > 0 OR balance_units - ? < 0 THEN 'DEBT' ELSE status END,
           version = version + 1 WHERE organization_id = ?`,
      [
        refundUnits.toString(), refundUnits.toString(), shortfallUnits.toString(), shortfallUnits.toString(),
        refundUnits.toString(), input.organizationId,
      ],
    );
    await exec(
      `INSERT INTO organization_credit_transactions (
         id, organization_id, actor_user_id, type, amount_units, balance_after_units, reserved_after_units,
         idempotency_key, source, metadata_json
       ) VALUES (?, ?, ?, 'REFUND', ?, ?, ?, ?, 'payment_refund', ?)`,
      [
        randomUUID(), input.organizationId, input.actorUserId || null, (-refundUnits).toString(),
        balanceAfter.toString(), wallet.reservedUnits.toString(), `refund:${input.refundId}`,
        JSON.stringify({
          paymentId: input.paymentId,
          refundAmountPaise: input.refundAmountPaise,
          reason: input.reason || null,
          grantIds,
          shortfallUnits: shortfallUnits.toString(),
        }),
      ],
    );
    if (input.refundAmountPaise >= input.paymentTotalPaise) {
      await exec(
        `UPDATE organization_credit_release_schedules SET status = 'CANCELLED'
         WHERE organization_id = ? AND source_payment_id = ? AND status = 'ACTIVE'`,
        [input.organizationId, input.paymentId],
      );
    }
    return { refundedUnits: refundUnits, debtUnits: debtAfter, duplicate: false };
  });
}

export async function reserveOrganizationCredits(input: {
  organizationId: string;
  userId: string;
  projectId?: string | null;
  requestId: string;
  attemptKey: string;
  providerId: string;
  modelId: string;
  maximumProviderCostUsd: number;
  ttlMinutes?: number;
}): Promise<CreditReservation> {
  const mode = creditMeteringMode();
  const valuation = await activeValuation();
  const requiredUnits = providerCostUsdToUnits(input.maximumProviderCostUsd, valuation.usdToInr);
  if (mode === 'off') {
    return {
      id: `off:${input.attemptKey}`,
      organizationId: input.organizationId,
      requestId: input.requestId,
      attemptKey: input.attemptKey,
      reservedUnits: requiredUnits,
      status: 'OFF',
      valuation,
    };
  }

  return withTransaction(async (exec) => {
    await ensureWallet(exec, input.organizationId);
    const existing = await exec<ReservationRow[]>(
      `SELECT * FROM organization_credit_reservations
       WHERE organization_id = ? AND attempt_key = ? LIMIT 1`,
      [input.organizationId, input.attemptKey],
    );
    if (existing[0]) {
      return {
        id: existing[0].id,
        organizationId: existing[0].organization_id,
        requestId: existing[0].request_id,
        attemptKey: existing[0].attempt_key,
        reservedUnits: toBigInt(existing[0].reserved_units),
        status: existing[0].status,
        valuation,
      };
    }

    const walletRows = await exec<WalletRow[]>(
      `SELECT * FROM organization_credit_wallets WHERE organization_id = ? FOR UPDATE`,
      [input.organizationId],
    );
    const wallet = mapWallet(walletRows[0]);
    if (mode === 'enforce' && (wallet.status !== 'ACTIVE' || wallet.availableUnits < requiredUnits)) {
      throw new InsufficientOrganizationCreditsError({
        organizationId: input.organizationId,
        availableUnits: wallet.availableUnits,
        requiredUnits,
      });
    }

    const id = randomUUID();
    const status = mode === 'shadow' ? 'SHADOW' : 'RESERVED';
    await exec(
      `INSERT INTO organization_credit_reservations (
         id, organization_id, user_id, project_id, request_id, attempt_key, provider_id, model_id,
         status, reserved_units, valuation_version_id, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
      [
        id, input.organizationId, input.userId, input.projectId || null, input.requestId,
        input.attemptKey, input.providerId, input.modelId, status, requiredUnits.toString(),
        valuation.id, input.ttlMinutes || 30,
      ],
    );
    if (status === 'RESERVED') {
      await exec(
        `UPDATE organization_credit_wallets SET reserved_units = reserved_units + ?, version = version + 1
         WHERE organization_id = ?`,
        [requiredUnits.toString(), input.organizationId],
      );
    }
    const reservedAfter = status === 'RESERVED' ? wallet.reservedUnits + requiredUnits : wallet.reservedUnits;
    await exec(
      `INSERT INTO organization_credit_transactions (
         id, organization_id, actor_user_id, reservation_id, type, amount_units, balance_after_units,
         reserved_after_units, idempotency_key, source, provider_id, model_id, project_id,
         valuation_version_id, metadata_json
       ) VALUES (?, ?, ?, ?, 'RESERVATION', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), input.organizationId, input.userId, id, wallet.balanceUnits.toString(),
        reservedAfter.toString(), `reserve:${input.attemptKey}`, mode, input.providerId, input.modelId,
        input.projectId || null, valuation.id,
        JSON.stringify({ maximumProviderCostUsd: input.maximumProviderCostUsd, requiredUnits: requiredUnits.toString() }),
      ],
    );
    return {
      id, organizationId: input.organizationId, requestId: input.requestId,
      attemptKey: input.attemptKey, reservedUnits: requiredUnits, status, valuation,
    };
  });
}

async function consumeGrantLots(exec: SqlExecutor, organizationId: string, units: bigint) {
  let remaining = units;
  const lots = await exec<Array<{ id: string; remaining_units: string | number }>>(
    `SELECT id, remaining_units FROM organization_credit_grants
     WHERE organization_id = ? AND remaining_units > 0 AND expires_at IS NULL
     ORDER BY created_at ASC, id ASC FOR UPDATE`,
    [organizationId],
  );
  for (const lot of lots) {
    if (remaining <= 0n) break;
    const lotRemaining = toBigInt(lot.remaining_units);
    const debit = lotRemaining < remaining ? lotRemaining : remaining;
    await exec(
      `UPDATE organization_credit_grants SET remaining_units = remaining_units - ? WHERE id = ?`,
      [debit.toString(), lot.id],
    );
    remaining -= debit;
  }
  return remaining;
}

export async function settleOrganizationCreditReservation(input: {
  reservation: CreditReservation;
  actualProviderCostUsd: number;
}): Promise<bigint> {
  if (input.reservation.status === 'OFF') return 0n;
  const settledUnits = providerCostUsdToUnits(input.actualProviderCostUsd, input.reservation.valuation.usdToInr);
  return withTransaction(async (exec) => {
    const rows = await exec<ReservationRow[]>(
      `SELECT * FROM organization_credit_reservations WHERE id = ? FOR UPDATE`,
      [input.reservation.id],
    );
    const row = rows[0];
    if (!row) throw new Error('Credit reservation was not found');
    if (row.status === 'SETTLED') {
      const settled = await exec<Array<{ settled_units: string | number }>>(
        `SELECT settled_units FROM organization_credit_reservations WHERE id = ?`,
        [row.id],
      );
      return toBigInt(settled[0]?.settled_units);
    }
    if (row.status === 'RELEASED') throw new Error('Credit reservation was already released');

    const shadow = row.status === 'SHADOW';
    const reservedUnits = toBigInt(row.reserved_units);
    if (!shadow) {
      const walletRows = await exec<WalletRow[]>(
        `SELECT * FROM organization_credit_wallets WHERE organization_id = ? FOR UPDATE`,
        [row.organization_id],
      );
      const wallet = mapWallet(walletRows[0]);
      const unreservedAfterRelease = wallet.balanceUnits - (wallet.reservedUnits - reservedUnits);
      const resultingBalance = wallet.balanceUnits - settledUnits;
      const debt = resultingBalance < 0n || unreservedAfterRelease < settledUnits;
      await exec(
        `UPDATE organization_credit_wallets
         SET balance_units = balance_units - ?, reserved_units = GREATEST(0, reserved_units - ?),
             lifetime_consumed_units = lifetime_consumed_units + ?,
             status = CASE WHEN balance_units - ? < 0 THEN 'DEBT' ELSE status END,
             version = version + 1
         WHERE organization_id = ?`,
        [settledUnits.toString(), reservedUnits.toString(), settledUnits.toString(), settledUnits.toString(), row.organization_id],
      );
      const unmatched = await consumeGrantLots(exec, row.organization_id, settledUnits);
      const balanceAfter = wallet.balanceUnits - settledUnits;
      const reservedAfter = wallet.reservedUnits > reservedUnits ? wallet.reservedUnits - reservedUnits : 0n;
      await exec(
        `INSERT INTO organization_credit_transactions (
           id, organization_id, actor_user_id, reservation_id, type, amount_units, balance_after_units,
           reserved_after_units, idempotency_key, source, provider_id, model_id, project_id,
           valuation_version_id, provider_cost_usd, provider_cost_inr, metadata_json
         ) SELECT ?, organization_id, user_id, id, 'CONSUMPTION', ?, ?, ?, ?, 'managed_llm',
                  provider_id, model_id, project_id, valuation_version_id, ?, ?, ?
           FROM organization_credit_reservations WHERE id = ?`,
        [
          randomUUID(), (-settledUnits).toString(), balanceAfter.toString(), reservedAfter.toString(),
          `settle:${row.attempt_key}`, input.actualProviderCostUsd,
          input.actualProviderCostUsd * input.reservation.valuation.usdToInr,
          JSON.stringify({ reservedUnits: reservedUnits.toString(), unmatchedUnits: unmatched.toString(), debt }), row.id,
        ],
      );
    }
    await exec(
      `UPDATE organization_credit_reservations
       SET status = 'SETTLED', settled_units = ?, provider_cost_usd = ?, provider_cost_inr = ?, settled_at = NOW()
       WHERE id = ?`,
      [
        settledUnits.toString(), input.actualProviderCostUsd,
        input.actualProviderCostUsd * input.reservation.valuation.usdToInr, row.id,
      ],
    );
    return shadow ? 0n : settledUnits;
  });
}

export async function releaseOrganizationCreditReservation(reservation: CreditReservation): Promise<void> {
  if (reservation.status === 'OFF') return;
  await withTransaction(async (exec) => {
    const rows = await exec<ReservationRow[]>(
      `SELECT * FROM organization_credit_reservations WHERE id = ? FOR UPDATE`,
      [reservation.id],
    );
    const row = rows[0];
    if (!row || row.status === 'RELEASED' || row.status === 'SETTLED') return;
    const units = toBigInt(row.reserved_units);
    if (row.status === 'RESERVED') {
      await exec(
        `UPDATE organization_credit_wallets SET reserved_units = GREATEST(0, reserved_units - ?), version = version + 1
         WHERE organization_id = ?`,
        [units.toString(), row.organization_id],
      );
    }
    await exec(
      `UPDATE organization_credit_reservations SET status = 'RELEASED', settled_at = NOW() WHERE id = ?`,
      [row.id],
    );
  });
}

export async function releaseAbandonedOrganizationCreditReservations(): Promise<number> {
  const rows = await query<ReservationRow[]>(
    `SELECT * FROM organization_credit_reservations
     WHERE status = 'RESERVED' AND expires_at < NOW() ORDER BY expires_at ASC LIMIT 500`,
  );
  const valuation = await activeValuation();
  let released = 0;
  for (const row of rows) {
    await releaseOrganizationCreditReservation({
      id: row.id,
      organizationId: row.organization_id,
      requestId: row.request_id,
      attemptKey: row.attempt_key,
      reservedUnits: toBigInt(row.reserved_units),
      status: row.status,
      valuation: row.valuation_version_id === valuation.id ? valuation : { ...valuation, id: row.valuation_version_id },
    });
    released += 1;
  }
  return released;
}

export async function listOrganizationCreditTransactions(input: {
  organizationId: string;
  cursor?: string | null;
  limit?: number;
}) {
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit || 30)));
  const params: unknown[] = [input.organizationId];
  let cursorSql = '';
  if (input.cursor) {
    const [createdAt, id] = Buffer.from(input.cursor, 'base64url').toString('utf8').split('|');
    if (createdAt && id) {
      cursorSql = 'AND (created_at < ? OR (created_at = ? AND id < ?))';
      params.push(createdAt, createdAt, id);
    }
  }
  const rows = await query<Array<Record<string, unknown> & { id: string; created_at: Date | string; amount_units: string | number; balance_after_units: string | number; reserved_after_units: string | number }>>(
    `SELECT id, actor_user_id, type, amount_units, balance_after_units, reserved_after_units,
            source, provider_id, model_id, project_id, provider_cost_usd, provider_cost_inr,
            metadata_json, created_at
     FROM organization_credit_transactions
     WHERE organization_id = ? ${cursorSql}
     ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
    params,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const next = hasMore ? page[page.length - 1] : null;
  return {
    items: page.map((row) => ({
      ...row,
      amount_units: String(row.amount_units),
      amount_credits: unitsToCredits(row.amount_units),
      balance_after_units: String(row.balance_after_units),
      balance_after_credits: unitsToCredits(row.balance_after_units),
      reserved_after_units: String(row.reserved_after_units),
      reserved_after_credits: unitsToCredits(row.reserved_after_units),
    })),
    nextCursor: next
      ? Buffer.from(`${new Date(next.created_at).toISOString().slice(0, 19).replace('T', ' ')}|${next.id}`).toString('base64url')
      : null,
  };
}

export function expectedSubscriptionGrantCredits(
  planId: string,
  cadence: 'monthly' | 'yearly' = 'monthly',
): number {
  const plan = catalogPlan(planId);
  if (!plan || plan.id === 'free') return 0;
  if (cadence === 'yearly') {
    return plan.annualReleaseSchedule?.creditsPerRelease ?? plan.monthlyCredits;
  }
  return plan.monthlyCredits;
}

export async function adminOrganizationCreditGrant(input: {
  organizationId: string;
  userId?: string | null;
  credits: number;
  notes?: string | null;
}): Promise<{ grantId: string; balance: OrganizationCreditBalance }> {
  const result = await grantOrganizationCredits({
    organizationId: input.organizationId,
    userId: input.userId,
    credits: input.credits,
    sourceType: 'admin',
    sourceId: input.notes || null,
    idempotencyKey: `admin:${input.organizationId}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    providerBudgetPaise: input.credits * CREDIT_VALUE_PAISE,
  });
  return { grantId: result.grantId, balance: result.balance };
}

export async function debitOrganizationCredits(input: {
  organizationId: string;
  userId?: string | null;
  credits: number;
  source: string;
  idempotencyKey: string;
}): Promise<{ available: number; debited: number }> {
  const mode = creditMeteringMode();
  const units = creditsToUnits(input.credits);
  if (units <= 0n) throw new Error('Debit must be positive');

  if (mode === 'off') {
    const balance = await getOrganizationCreditBalance(input.organizationId);
    return { available: unitsToCredits(balance.availableUnits), debited: 0 };
  }

  return withTransaction(async (exec) => {
    const duplicate = await exec<Array<{ id: string }>>(
      `SELECT id FROM organization_credit_transactions
       WHERE organization_id = ? AND idempotency_key = ? LIMIT 1`,
      [input.organizationId, input.idempotencyKey],
    );
    if (duplicate[0]) {
      const wallet = await exec<WalletRow[]>(
        `SELECT * FROM organization_credit_wallets WHERE organization_id = ? LIMIT 1`,
        [input.organizationId],
      );
      return {
        available: unitsToCredits(mapWallet(wallet[0]).availableUnits),
        debited: unitsToCredits(units),
      };
    }

    await ensureWallet(exec, input.organizationId);
    const walletRows = await exec<WalletRow[]>(
      `SELECT * FROM organization_credit_wallets WHERE organization_id = ? FOR UPDATE`,
      [input.organizationId],
    );
    const wallet = mapWallet(walletRows[0]);
    if (mode === 'enforce' && (wallet.status !== 'ACTIVE' || wallet.availableUnits < units)) {
      throw new InsufficientOrganizationCreditsError({
        organizationId: input.organizationId,
        availableUnits: wallet.availableUnits,
        requiredUnits: units,
      });
    }

    if (mode === 'enforce') {
      await exec(
        `UPDATE organization_credit_wallets
         SET balance_units = balance_units - ?, lifetime_consumed_units = lifetime_consumed_units + ?,
             status = CASE WHEN balance_units - ? < 0 THEN 'DEBT' ELSE status END,
             version = version + 1
         WHERE organization_id = ?`,
        [units.toString(), units.toString(), units.toString(), input.organizationId],
      );
      await consumeGrantLots(exec, input.organizationId, units);
    }

    const balanceAfter = mode === 'enforce' ? wallet.balanceUnits - units : wallet.balanceUnits;
    await exec(
      `INSERT INTO organization_credit_transactions (
         id, organization_id, actor_user_id, type, amount_units, balance_after_units,
         reserved_after_units, idempotency_key, source, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), input.organizationId, input.userId || null,
        mode === 'shadow' ? 'SHADOW_CONSUMPTION' : 'CONSUMPTION',
        mode === 'enforce' ? (-units).toString() : '0',
        balanceAfter.toString(), wallet.reservedUnits.toString(),
        input.idempotencyKey, input.source,
        JSON.stringify({ credits: input.credits, mode }),
      ],
    );

    return {
      available: unitsToCredits(balanceAfter - wallet.reservedUnits),
      debited: mode === 'enforce' ? unitsToCredits(units) : 0,
    };
  });
}

export function publicCreditBalance(balance: OrganizationCreditBalance) {
  return {
    organization_id: balance.organizationId,
    available_units: balance.availableUnits.toString(),
    reserved_units: balance.reservedUnits.toString(),
    balance_units: balance.balanceUnits.toString(),
    available: unitsToCredits(balance.availableUnits),
    reserved: unitsToCredits(balance.reservedUnits),
    total: unitsToCredits(balance.balanceUnits),
    lifetime_granted: unitsToCredits(balance.lifetimeGrantedUnits),
    lifetime_consumed: unitsToCredits(balance.lifetimeConsumedUnits),
    lifetime_refunded: unitsToCredits(balance.lifetimeRefundedUnits),
    debt: unitsToCredits(balance.debtUnits),
    status: balance.status,
    never_expires: true,
    credit_value_provider_usage_paise: CREDIT_VALUE_PAISE,
  };
}
