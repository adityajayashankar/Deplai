export const FREE_PLAN_ID = 'free';
export const STARTER_PLAN_ID = 'starter_20';
export const PRO_PLAN_ID = 'pro_50';
export const ENTERPRISE_PLAN_ID = 'enterprise';

export type CreditTxnType =
  | 'grant_paid'
  | 'grant_bonus'
  | 'consume'
  | 'expire'
  | 'rollover'
  | 'refund';

export class InsufficientCreditsError extends Error {
  readonly code = 'insufficient_credits' as const;

  constructor(
    public paidRemaining: number,
    public bonusRemaining: number,
  ) {
    super('Insufficient credits');
    this.name = 'InsufficientCreditsError';
  }
}

export type LedgerSnapshot = {
  paidRemaining: number;
  bonusRemaining: number;
  bonusUnlocked: boolean;
  bonusGranted: number;
  bonusExpiresAt: Date | null;
  paidCreditAmount: number;
  bonusPercent: number;
  planName: string;
};

export type LedgerTxn = {
  type: CreditTxnType;
  amount: number;
  balanceAfter: number;
};

export type ConsumeOk = {
  ok: true;
  next: LedgerSnapshot;
  bonusGrantedNow: number;
  transactions: LedgerTxn[];
};

export type ConsumeErr = {
  ok: false;
  code: 'insufficient_credits';
  paidRemaining: number;
  bonusRemaining: number;
};

export function bonusGrantAmount(paidCreditAmount: number, bonusPercent: number, planName: string): number {
  if (planName === FREE_PLAN_ID) return 0;
  if (bonusPercent <= 0 || paidCreditAmount <= 0) return 0;
  return Math.floor((paidCreditAmount * bonusPercent) / 100);
}

export function calendarMonthEndUtc(from: Date): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

export function utcMonthCycle(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  return { start, end };
}

export function cappedRollover(unusedPaid: number, monthlyPaid: number, rolloverMonthsCap: number): number {
  if (rolloverMonthsCap <= 0 || unusedPaid <= 0 || monthlyPaid <= 0) return 0;
  return Math.min(unusedPaid, monthlyPaid * rolloverMonthsCap);
}

export function proratePaidDelta(input: {
  previousPaidAmount: number;
  nextPaidAmount: number;
  cycleStart: Date;
  cycleEnd: Date;
  now: Date;
}): number {
  const total = input.cycleEnd.getTime() - input.cycleStart.getTime();
  if (total <= 0) return 0;
  const remaining = Math.max(0, input.cycleEnd.getTime() - input.now.getTime());
  return Math.round((input.nextPaidAmount - input.previousPaidAmount) * (remaining / total));
}

function totalOf(ledger: Pick<LedgerSnapshot, 'paidRemaining' | 'bonusRemaining'>): number {
  return ledger.paidRemaining + ledger.bonusRemaining;
}

function projectedAvailable(ledger: LedgerSnapshot, amount: number): number {
  let available = ledger.paidRemaining + ledger.bonusRemaining;
  const wouldUnlock =
    !ledger.bonusUnlocked
    && ledger.planName !== FREE_PLAN_ID
    && bonusGrantAmount(ledger.paidCreditAmount, ledger.bonusPercent, ledger.planName) > 0
    && (ledger.paidRemaining === 0 || amount >= ledger.paidRemaining);

  if (wouldUnlock) {
    available += bonusGrantAmount(ledger.paidCreditAmount, ledger.bonusPercent, ledger.planName);
  }
  return available;
}

export function consumeOnLockedLedger(
  ledger: LedgerSnapshot,
  amount: number,
  now: Date,
): ConsumeOk | ConsumeErr {
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ok: true,
      next: ledger,
      bonusGrantedNow: 0,
      transactions: [],
    };
  }

  if (projectedAvailable(ledger, amount) < amount) {
    return {
      ok: false,
      code: 'insufficient_credits',
      paidRemaining: ledger.paidRemaining,
      bonusRemaining: ledger.bonusRemaining,
    };
  }

  const next: LedgerSnapshot = { ...ledger };
  const transactions: LedgerTxn[] = [];
  let remaining = amount;
  let bonusGrantedNow = 0;

  if (remaining > 0 && next.paidRemaining > 0) {
    const takePaid = Math.min(next.paidRemaining, remaining);
    next.paidRemaining -= takePaid;
    remaining -= takePaid;
    transactions.push({
      type: 'consume',
      amount: takePaid,
      balanceAfter: totalOf(next),
    });
  }

  if (next.paidRemaining === 0 && !next.bonusUnlocked && next.planName !== FREE_PLAN_ID) {
    const grant = bonusGrantAmount(next.paidCreditAmount, next.bonusPercent, next.planName);
    next.bonusUnlocked = true;
    if (grant > 0) {
      next.bonusGranted += grant;
      next.bonusRemaining += grant;
      next.bonusExpiresAt = calendarMonthEndUtc(now);
      bonusGrantedNow = grant;
      transactions.push({
        type: 'grant_bonus',
        amount: grant,
        balanceAfter: totalOf(next),
      });
    }
  }

  if (remaining > 0) {
    const takeBonus = Math.min(next.bonusRemaining, remaining);
    next.bonusRemaining -= takeBonus;
    remaining -= takeBonus;
    transactions.push({
      type: 'consume',
      amount: takeBonus,
      balanceAfter: totalOf(next),
    });
  }

  if (remaining > 0) {
    return {
      ok: false,
      code: 'insufficient_credits',
      paidRemaining: ledger.paidRemaining,
      bonusRemaining: ledger.bonusRemaining,
    };
  }

  return { ok: true, next, bonusGrantedNow, transactions };
}

export function expireBonusOnLedger(ledger: LedgerSnapshot, now: Date): { next: LedgerSnapshot; expired: number } | null {
  if (!ledger.bonusExpiresAt || ledger.bonusExpiresAt >= now || ledger.bonusRemaining <= 0) {
    return null;
  }
  const expired = ledger.bonusRemaining;
  const next = { ...ledger, bonusRemaining: 0 };
  return { next, expired };
}

export function applyPaidGrant(input: {
  previousPaidRemaining: number;
  grantPaid: number;
  rolloverPaid: number;
}): { paidGranted: number; paidRemaining: number } {
  const paidGranted = input.grantPaid + input.rolloverPaid;
  return {
    paidGranted,
    paidRemaining: input.grantPaid + input.rolloverPaid,
  };
}

export function overlayUnenforcedCredits<T extends {
  paidRemaining: number;
  bonusRemaining: number;
  total: number;
}>(balance: T, enforced: boolean): T {
  if (enforced) return balance;
  return {
    ...balance,
    paidRemaining: 0,
    bonusRemaining: 0,
    total: 0,
  };
}
