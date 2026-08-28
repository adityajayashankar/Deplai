import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCycleForecast,
  buildUsageInsights,
  burnPerDay,
  cycleUsedPercent,
  daysUntil,
  emptyServiceMix,
  emptyUsageDashboard,
  formatUsd,
  percentDelta,
  ratio,
  runwayDays,
  successRate,
  usdPerThousandTokens,
  type UsageDashboard,
} from './dashboard';
import { emptyWrappedRaw } from './wrapped';

function insightInput(overrides?: {
  planId?: string;
  credits?: Partial<UsageDashboard['credits']>;
  delivery?: Partial<UsageDashboard['delivery']>;
  spend?: Partial<UsageDashboard['spend']>;
  ai?: Partial<UsageDashboard['ai']>;
  projects?: Partial<UsageDashboard['projects']>;
  efficiency?: Partial<UsageDashboard['efficiency']>;
  forecast?: Partial<UsageDashboard['forecast']>;
}) {
  const empty = emptyUsageDashboard();
  const credits = { ...empty.credits, ...overrides?.credits };
  const delivery = { ...empty.delivery, ...overrides?.delivery };
  const spend = { ...empty.spend, ...overrides?.spend };
  const ai = { ...empty.ai, ...overrides?.ai };
  const projects = { ...empty.projects, ...overrides?.projects };
  const efficiency = { ...empty.efficiency, ...overrides?.efficiency };
  const forecast = { ...empty.forecast, ...overrides?.forecast };
  return {
    planId: overrides?.planId || 'free',
    credits,
    delivery,
    spend,
    ai,
    projects,
    efficiency,
    forecast,
  };
}

describe('usage dashboard KPIs', () => {
  it('computes percent deltas for operators comparing windows', () => {
    assert.equal(percentDelta(12, 8).percent, 50);
    assert.equal(percentDelta(12, 8).direction, 'up');
    assert.equal(percentDelta(6, 8).percent, -25);
    assert.equal(percentDelta(0, 0).direction, 'flat');
    assert.equal(percentDelta(4, 0).label, 'New this window');
  });

  it('turns remaining credits and burn into runway', () => {
    assert.equal(burnPerDay(30, 30), 1);
    assert.equal(runwayDays(14, 2), 7);
    assert.equal(runwayDays(10, 0), null);
    assert.equal(runwayDays(0, 2), 0);
  });

  it('shows how much of a billing cycle is already spent', () => {
    assert.equal(cycleUsedPercent(20, 5), 75);
    assert.equal(cycleUsedPercent(20, 25, 3), 15);
    assert.equal(cycleUsedPercent(0, 0), null);
    assert.equal(successRate(8, 2), 80);
    assert.equal(successRate(0, 0), null);
    assert.equal(formatUsd(0), '$0.00');
    assert.equal(formatUsd(12.5), '$12.50');
  });

  it('measures efficiency a startup can act on', () => {
    assert.equal(ratio(18, 6, 1), 3);
    assert.equal(ratio(10, 0), null);
    assert.equal(usdPerThousandTokens(2, 100_000), 0.02);
    assert.equal(usdPerThousandTokens(0, 0), null);
  });

  it('forecasts whether current burn lasts the cycle', () => {
    const overrun = buildCycleForecast(2, 0.6, 10);
    assert.equal(overrun.willExhaustBeforeCycleEnd, true);
    assert.equal(overrun.status, 'overrun');
    assert.equal(overrun.projectedRemainingAtCycleEnd, 0);

    const healthy = buildCycleForecast(40, 0.5, 12);
    assert.equal(healthy.willExhaustBeforeCycleEnd, false);
    assert.equal(healthy.status, 'healthy');
    assert.equal(healthy.projectedRemainingAtCycleEnd, 34);

    const idle = buildCycleForecast(0, 0, 20);
    assert.equal(idle.status, 'idle');
  });

  it('counts whole days until cycle end', () => {
    const now = new Date('2026-08-27T04:00:00.000Z');
    assert.equal(daysUntil('2026-08-31T00:00:00.000Z', now), 4);
  });

  it('does not treat a brand-new wallet as out of credits', () => {
    const ids = emptyUsageDashboard().insights.map((item) => item.id);
    assert.deepEqual(ids, ['steady']);
  });

  it('warns when credits and reliability need action', () => {
    const mix = emptyServiceMix();
    const credits = {
      remaining: 2,
      paidRemaining: 2,
      bonusRemaining: 0,
      bonusUnlocked: false,
      bonusExpiresAt: null,
      grantedThisCycle: 5,
      consumedThisCycle: 3,
      consumed: percentDelta(18, 4),
      cycleUsedPercent: 60,
      burnPerDay: 0.6,
      runwayDays: 3,
      cycleStart: null,
      cycleEnd: null,
      daysLeftInCycle: 10,
    };
    const insights = buildUsageInsights(insightInput({
      planId: 'free',
      credits,
      delivery: {
        sessions: percentDelta(10, 4),
        completed: 4,
        successRate: 50,
        failed: 4,
        needsReview: 2,
        running: 0,
        openWork: 2,
        avgDurationMinutes: 12,
        changedFiles: 9,
        byService: mix,
      },
      spend: {
        aiChargeUsd: percentDelta(4, 2),
        byokSharePercent: 10,
        platformSharePercent: 90,
        byokRequests: 1,
        platformRequests: 9,
      },
      ai: {
        requests: percentDelta(20, 10),
        tokens: percentDelta(80_000, 40_000),
        topModels: [],
      },
      projects: { total: 3, addedWindow: 1 },
      efficiency: {
        completedRuns: 4,
        creditsPerCompletedRun: 4.5,
        usdPer1kTokens: 0.05,
        filesPerCompletedRun: 2.3,
      },
      forecast: buildCycleForecast(2, 0.6, 10),
    }));
    const ids = insights.map((item) => item.id);
    assert.ok(ids.includes('credits-overrun') || ids.includes('credits-runway'));
    assert.ok(ids.includes('needs-review'));
    assert.ok(ids.includes('reliability'));
    assert.equal(ids.length, 4);
  });

  it('flags expensive finished runs when retries are eating credits', () => {
    const insights = buildUsageInsights(insightInput({
      credits: {
        remaining: 12,
        grantedThisCycle: 20,
        consumedThisCycle: 8,
        consumed: percentDelta(12, 12),
        burnPerDay: 0.4,
        runwayDays: 30,
        daysLeftInCycle: 20,
      },
      delivery: {
        sessions: percentDelta(6, 6),
        completed: 4,
        successRate: 100,
        failed: 0,
      },
      efficiency: {
        completedRuns: 4,
        creditsPerCompletedRun: 3.2,
        usdPer1kTokens: 0.01,
        filesPerCompletedRun: 1,
      },
      forecast: buildCycleForecast(12, 0.4, 20),
    }));
    assert.ok(insights.some((item) => item.id === 'expensive-runs'));
  });

  it('keeps the empty wrapped mapper intact for the year-in-review card', () => {
    const raw = emptyWrappedRaw({ year: 2026 });
    assert.equal(raw.projectsThisYear, 0);
    assert.equal(raw.heatmapCounts.length, 28);
  });
});
