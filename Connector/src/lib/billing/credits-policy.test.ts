import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FREE_PLAN_ID,
  PRO_PLAN_ID,
  STARTER_PLAN_ID,
  applyPaidGrant,
  bonusGrantAmount,
  calendarMonthEndUtc,
  cappedRollover,
  consumeOnLockedLedger,
  expireBonusOnLedger,
  overlayUnenforcedCredits,
  proratePaidDelta,
  type LedgerSnapshot,
} from './credits-policy';

function starterLedger(overrides: Partial<LedgerSnapshot> = {}): LedgerSnapshot {
  return {
    paidRemaining: 20,
    bonusRemaining: 0,
    bonusUnlocked: false,
    bonusGranted: 0,
    bonusExpiresAt: null,
    paidCreditAmount: 20,
    bonusPercent: 25,
    planName: STARTER_PLAN_ID,
    ...overrides,
  };
}

function mutex() {
  let chain = Promise.resolve();
  return async <T>(work: () => T | Promise<T>): Promise<T> => {
    const run = chain.then(work, work);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
}

describe('bonusGrantAmount', () => {
  it('never grants bonus on the free tier even if a percent is supplied', () => {
    assert.equal(bonusGrantAmount(5, 25, FREE_PLAN_ID), 0);
    assert.equal(bonusGrantAmount(20, 25, FREE_PLAN_ID), 0);
  });

  it('floors percent of paid credits for paid plans', () => {
    assert.equal(bonusGrantAmount(20, 25, STARTER_PLAN_ID), 5);
    assert.equal(bonusGrantAmount(50, 40, PRO_PLAN_ID), 20);
  });
});

describe('consumeOnLockedLedger', () => {
  it('does not unlock bonus before paid credits hit exactly 0', () => {
    const result = consumeOnLockedLedger(starterLedger(), 19, new Date('2026-08-15T12:00:00.000Z'));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.next.paidRemaining, 1);
    assert.equal(result.next.bonusUnlocked, false);
    assert.equal(result.next.bonusRemaining, 0);
    assert.equal(result.bonusGrantedNow, 0);
  });

  it('unlocks bonus only after paid credits hit exactly 0', () => {
    const now = new Date('2026-08-15T12:00:00.000Z');
    const result = consumeOnLockedLedger(starterLedger(), 20, now);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.next.paidRemaining, 0);
    assert.equal(result.next.bonusUnlocked, true);
    assert.equal(result.next.bonusRemaining, 5);
    assert.equal(result.bonusGrantedNow, 5);
    assert.deepEqual(result.next.bonusExpiresAt, calendarMonthEndUtc(now));
  });

  it('draws paid credits before bonus credits in a single consume', () => {
    const result = consumeOnLockedLedger(starterLedger(), 22, new Date('2026-08-15T12:00:00.000Z'));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.next.paidRemaining, 0);
    assert.equal(result.next.bonusRemaining, 3);
    const consumeTxns = result.transactions.filter((txn) => txn.type === 'consume');
    assert.equal(consumeTxns[0]?.amount, 20);
    assert.equal(consumeTxns[1]?.amount, 2);
  });

  it('rejects when paid and bonus (including pending unlock) cannot cover the amount', () => {
    const result = consumeOnLockedLedger(starterLedger(), 26, new Date('2026-08-15T12:00:00.000Z'));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'insufficient_credits');
    assert.equal(result.paidRemaining, 20);
    assert.equal(result.bonusRemaining, 0);
  });

  it('never grants bonus on the free tier even when paid hits 0', () => {
    const result = consumeOnLockedLedger(
      starterLedger({
        paidRemaining: 5,
        paidCreditAmount: 5,
        bonusPercent: 25,
        planName: FREE_PLAN_ID,
      }),
      5,
      new Date('2026-08-15T12:00:00.000Z'),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.next.bonusUnlocked, false);
    assert.equal(result.next.bonusRemaining, 0);
    assert.equal(result.bonusGrantedNow, 0);
    assert.equal(result.transactions.some((txn) => txn.type === 'grant_bonus'), false);
  });
});

describe('bonus expiry', () => {
  it('expires at calendar month-end UTC regardless of unlock date', () => {
    const unlockEarly = new Date('2026-08-02T01:00:00.000Z');
    const unlockLate = new Date('2026-08-31T22:00:00.000Z');
    const early = consumeOnLockedLedger(starterLedger(), 20, unlockEarly);
    const late = consumeOnLockedLedger(starterLedger(), 20, unlockLate);
    assert.equal(early.ok && late.ok, true);
    if (!early.ok || !late.ok) return;
    const monthEnd = new Date(Date.UTC(2026, 7, 31, 23, 59, 59, 999));
    assert.deepEqual(early.next.bonusExpiresAt, monthEnd);
    assert.deepEqual(late.next.bonusExpiresAt, monthEnd);
    assert.deepEqual(calendarMonthEndUtc(unlockEarly), monthEnd);
  });

  it('zeros remaining bonus after the month boundary', () => {
    const unlocked = consumeOnLockedLedger(starterLedger(), 20, new Date('2026-08-15T12:00:00.000Z'));
    assert.equal(unlocked.ok, true);
    if (!unlocked.ok) return;
    const before = expireBonusOnLedger(unlocked.next, new Date('2026-08-31T23:59:59.999Z'));
    assert.equal(before, null);
    const after = expireBonusOnLedger(unlocked.next, new Date('2026-09-01T00:00:00.000Z'));
    assert.ok(after);
    assert.equal(after?.expired, 5);
    assert.equal(after?.next.bonusRemaining, 0);
    assert.equal(after?.next.paidRemaining, 0);
  });
});

describe('rollover', () => {
  it('caps unused paid credits and never includes bonus', () => {
    assert.equal(cappedRollover(15, 20, 1), 15);
    assert.equal(cappedRollover(50, 20, 1), 20);
    assert.equal(cappedRollover(50, 20, 2), 40);
    assert.equal(cappedRollover(15, 20, 0), 0);
    const granted = applyPaidGrant({ previousPaidRemaining: 12, grantPaid: 20, rolloverPaid: 12 });
    assert.equal(granted.paidRemaining, 32);
    assert.equal(granted.paidGranted, 32);
  });
});

describe('proration', () => {
  it('grants the remaining-cycle fraction on upgrade and withholds it on downgrade', () => {
    const cycleStart = new Date('2026-08-01T00:00:00.000Z');
    const cycleEnd = new Date('2026-08-31T23:59:59.999Z');
    const mid = new Date(cycleStart.getTime() + (cycleEnd.getTime() - cycleStart.getTime()) * 0.5);
    const upgrade = proratePaidDelta({
      previousPaidAmount: 20,
      nextPaidAmount: 50,
      cycleStart,
      cycleEnd,
      now: mid,
    });
    const downgrade = proratePaidDelta({
      previousPaidAmount: 50,
      nextPaidAmount: 20,
      cycleStart,
      cycleEnd,
      now: mid,
    });
    assert.equal(upgrade, 15);
    assert.equal(downgrade, -15);
  });
});

describe('concurrent consumption', () => {
  it('enforces paid-before-bonus when overlapping requests share a row lock / mutex', async () => {
    const lock = mutex();
    let ledger = starterLedger({ paidRemaining: 10, paidCreditAmount: 10, bonusPercent: 20 });
    const now = new Date('2026-08-15T12:00:00.000Z');
    const results = await Promise.all(
      Array.from({ length: 12 }, () => lock(() => {
        const result = consumeOnLockedLedger(ledger, 1, now);
        if (result.ok) ledger = result.next;
        return result;
      })),
    );
    const accepted = results.filter((result) => result.ok);
    const rejected = results.filter((result) => !result.ok);
    assert.equal(accepted.length, 12);
    assert.equal(rejected.length, 0);
    assert.equal(ledger.paidRemaining, 0);
    assert.equal(ledger.bonusUnlocked, true);
    assert.equal(ledger.bonusRemaining, 0);
  });

  it('would overdraw without serialization, which is why consume uses SELECT FOR UPDATE', () => {
    const snapshot = starterLedger({ paidRemaining: 1, bonusRemaining: 0 });
    const first = consumeOnLockedLedger(snapshot, 1, new Date('2026-08-15T12:00:00.000Z'));
    const second = consumeOnLockedLedger(snapshot, 1, new Date('2026-08-15T12:00:00.000Z'));
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
  });
});

describe('overlayUnenforcedCredits', () => {
  it('reports zero remaining while billing is not enforced', () => {
    const overlay = overlayUnenforcedCredits(
      { paidRemaining: 5, bonusRemaining: 2, total: 7, planName: FREE_PLAN_ID },
      false,
    );
    assert.equal(overlay.paidRemaining, 0);
    assert.equal(overlay.bonusRemaining, 0);
    assert.equal(overlay.total, 0);
    assert.equal(overlay.planName, FREE_PLAN_ID);
  });

  it('leaves the ledger untouched when billing is enforced', () => {
    const overlay = overlayUnenforcedCredits(
      { paidRemaining: 20, bonusRemaining: 5, total: 25 },
      true,
    );
    assert.equal(overlay.paidRemaining, 20);
    assert.equal(overlay.bonusRemaining, 5);
    assert.equal(overlay.total, 25);
  });
});
