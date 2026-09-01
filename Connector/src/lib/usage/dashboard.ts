import { SESSION_SERVICES, serviceLabel, type SessionService } from '@/lib/sessions/types';
import { formatCompactCount } from './wrapped';

export const USAGE_WINDOW_DAYS = 30;

export type TrendDirection = 'up' | 'down' | 'flat';

export type UsageDelta = {
  current: number;
  previous: number;
  percent: number | null;
  direction: TrendDirection;
  label: string;
};

export type ServiceMixRow = {
  service: SessionService;
  label: string;
  total: number;
  completed: number;
  failed: number;
  needsReview: number;
  running: number;
  successRate: number | null;
};

export type DailyActivityPoint = {
  day: string;
  label: string;
  sessions: number;
  aiRequests: number;
  credits: number;
  total: number;
};

export type ModelUsageRow = {
  providerId: string;
  modelId: string;
  requests: number;
  tokens: number;
};

export type RepoUsageRow = {
  repo: string;
  runs: number;
  failed: number;
  needsReview: number;
};

export type ForecastStatus = 'idle' | 'healthy' | 'tight' | 'overrun';

export type CycleForecast = {
  status: ForecastStatus;
  willExhaustBeforeCycleEnd: boolean;
  projectedRemainingAtCycleEnd: number | null;
};

export type UsageInsight = {
  id: string;
  tone: 'ok' | 'warn' | 'info';
  title: string;
  detail: string;
  href?: string;
  action?: string;
};

export type UsageDashboard = {
  generatedAt: string;
  windowDays: number;
  displayName: string;
  planId: string;
  planName: string;
  credits: {
    remaining: number;
    paidRemaining: number;
    bonusRemaining: number;
    bonusUnlocked: boolean;
    bonusExpiresAt: string | null;
    grantedThisCycle: number;
    consumedThisCycle: number;
    consumed: UsageDelta;
    cycleUsedPercent: number | null;
    burnPerDay: number;
    runwayDays: number | null;
    cycleStart: string | null;
    cycleEnd: string | null;
    daysLeftInCycle: number | null;
  };
  delivery: {
    sessions: UsageDelta;
    completed: number;
    successRate: number | null;
    failed: number;
    needsReview: number;
    running: number;
    openWork: number;
    avgDurationMinutes: number | null;
    changedFiles: number;
    byService: ServiceMixRow[];
  };
  efficiency: {
    completedRuns: number;
    creditsPerCompletedRun: number | null;
    usdPer1kTokens: number | null;
    filesPerCompletedRun: number | null;
  };
  forecast: CycleForecast;
  topRepos: RepoUsageRow[];
  spend: {
    aiChargeUsd: UsageDelta;
    byokSharePercent: number | null;
    platformSharePercent: number | null;
    byokRequests: number;
    platformRequests: number;
  };
  ai: {
    requests: UsageDelta;
    tokens: UsageDelta;
    topModels: ModelUsageRow[];
  };
  projects: {
    total: number;
    addedWindow: number;
  };
  activity: {
    daily: DailyActivityPoint[];
    hourCounts: number[];
    weekdayCounts: number[];
    peakHourLabel: string;
    peakWeekdayLabel: string;
  };
  insights: UsageInsight[];
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function percentDelta(current: number, previous: number): UsageDelta {
  const curr = Math.max(0, Number(current) || 0);
  const prev = Math.max(0, Number(previous) || 0);
  if (prev <= 0 && curr <= 0) {
    return { current: curr, previous: prev, percent: null, direction: 'flat', label: 'No prior window' };
  }
  if (prev <= 0) {
    return { current: curr, previous: prev, percent: null, direction: 'up', label: 'New this window' };
  }
  const percent = Math.round(((curr - prev) / prev) * 100);
  const direction: TrendDirection = percent > 0 ? 'up' : percent < 0 ? 'down' : 'flat';
  const sign = percent > 0 ? '+' : '';
  return {
    current: curr,
    previous: prev,
    percent,
    direction,
    label: `${sign}${percent}% vs prior ${USAGE_WINDOW_DAYS}d`,
  };
}

export function cycleUsedPercent(granted: number, remaining: number, consumedThisCycle?: number): number | null {
  const cap = Math.max(0, Number(granted) || 0);
  if (cap <= 0) return null;
  if (consumedThisCycle != null && Number.isFinite(consumedThisCycle)) {
    return Math.min(100, Math.round((Math.max(0, consumedThisCycle) / cap) * 100));
  }
  const used = Math.min(cap, Math.max(0, cap - Math.max(0, Number(remaining) || 0)));
  return Math.round((used / cap) * 100);
}

export function ratio(numerator: number, denominator: number, digits = 1): number | null {
  if (denominator <= 0) return null;
  const factor = 10 ** Math.max(0, digits);
  return Math.round((Math.max(0, numerator) / denominator) * factor) / factor;
}

export function usdPerThousandTokens(usd: number, tokens: number): number | null {
  if (tokens <= 0) return null;
  return Math.round((Math.max(0, usd) / tokens) * 1000 * 10_000) / 10_000;
}

export function buildCycleForecast(
  remaining: number,
  burn: number,
  daysLeftInCycle: number | null,
): CycleForecast {
  const left = Math.max(0, remaining);
  if (burn <= 0) {
    return {
      status: left > 0 ? 'healthy' : 'idle',
      willExhaustBeforeCycleEnd: false,
      projectedRemainingAtCycleEnd: daysLeftInCycle == null ? left : left,
    };
  }
  const runway = remaining / burn;
  const willExhaust = daysLeftInCycle != null && runway < daysLeftInCycle && left > 0;
  const projected = daysLeftInCycle == null ? null : Math.max(0, Math.round(left - burn * daysLeftInCycle));
  let status: ForecastStatus = 'healthy';
  if (left <= 0) status = 'overrun';
  else if (willExhaust && runway <= 7) status = 'overrun';
  else if (willExhaust || (projected != null && projected <= Math.max(1, Math.round(left * 0.15)))) status = 'tight';
  return {
    status,
    willExhaustBeforeCycleEnd: Boolean(willExhaust),
    projectedRemainingAtCycleEnd: projected,
  };
}

export function burnPerDay(consumedWindow: number, windowDays = USAGE_WINDOW_DAYS): number {
  const days = Math.max(1, windowDays);
  return Math.round((Math.max(0, consumedWindow) / days) * 10) / 10;
}

export function runwayDays(remaining: number, burn: number): number | null {
  if (burn <= 0) return remaining > 0 ? null : 0;
  return Math.max(0, Math.round(remaining / burn));
}

export function daysUntil(iso: string | null, now = new Date()): number | null {
  if (!iso) return null;
  const end = new Date(iso).getTime();
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.ceil((end - now.getTime()) / 86_400_000));
}

export function successRate(completed: number, failed: number): number | null {
  const done = Math.max(0, completed) + Math.max(0, failed);
  if (done <= 0) return null;
  return Math.round((Math.max(0, completed) / done) * 100);
}

export function formatUsd(value: number): string {
  const n = Number(value) || 0;
  if (Math.abs(n) < 0.01) return '$0.00';
  if (Math.abs(n) < 1) return `$${n.toFixed(3)}`;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function formatHourLabel(hour: number): string {
  const normalized = ((hour % 24) + 24) % 24;
  const suffix = normalized >= 12 ? 'PM' : 'AM';
  const twelve = normalized % 12 === 0 ? 12 : normalized % 12;
  return `${twelve} ${suffix}`;
}

export function peakIndex(values: number[]): number {
  let best = 0;
  let bestValue = -1;
  values.forEach((value, index) => {
    if (value > bestValue) {
      best = index;
      bestValue = value;
    }
  });
  return best;
}

export function emptyServiceMix(): ServiceMixRow[] {
  return SESSION_SERVICES.map((service) => ({
    service,
    label: serviceLabel(service),
    total: 0,
    completed: 0,
    failed: 0,
    needsReview: 0,
    running: 0,
    successRate: null,
  }));
}

export function emptyDailyActivity(now = new Date(), days = USAGE_WINDOW_DAYS): DailyActivityPoint[] {
  const points: DailyActivityPoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - i);
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    points.push({
      day: iso,
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      sessions: 0,
      aiRequests: 0,
      credits: 0,
      total: 0,
    });
  }
  return points;
}

type InsightInput = {
  planId: string;
  credits: UsageDashboard['credits'];
  delivery: UsageDashboard['delivery'];
  spend: UsageDashboard['spend'];
  ai: UsageDashboard['ai'];
  projects: UsageDashboard['projects'];
  efficiency: UsageDashboard['efficiency'];
  forecast: UsageDashboard['forecast'];
};

export function buildUsageInsights(input: InsightInput): UsageInsight[] {
  const insights: UsageInsight[] = [];
  const { credits, delivery, spend, ai, projects, efficiency, forecast } = input;
  const hasCreditHistory = credits.grantedThisCycle > 0 || credits.consumed.current > 0 || credits.consumedThisCycle > 0;

  if (credits.remaining <= 0 && hasCreditHistory) {
    insights.push({
      id: 'credits-empty',
      tone: 'warn',
      title: 'No credits left this cycle',
      detail: 'Scans, remediation, and agent runs that bill credits will block until you top up or the next cycle grants land.',
      href: '/dashboard/credits',
      action: 'Top up credits',
    });
  } else if (forecast.willExhaustBeforeCycleEnd && credits.runwayDays != null) {
    insights.push({
      id: 'credits-overrun',
      tone: 'warn',
      title: 'Burn will empty credits before renewal',
      detail: `At ${credits.burnPerDay} credit${credits.burnPerDay === 1 ? '' : 's'}/day you have about ${credits.runwayDays} day${credits.runwayDays === 1 ? '' : 's'} left, but ${credits.daysLeftInCycle ?? 0} day${credits.daysLeftInCycle === 1 ? '' : 's'} remain in this cycle.`,
      href: '/dashboard/credits',
      action: 'Buy a pack',
    });
  } else if (credits.runwayDays != null && credits.runwayDays <= 7 && credits.burnPerDay > 0) {
    insights.push({
      id: 'credits-runway',
      tone: 'warn',
      title: `About ${credits.runwayDays} day${credits.runwayDays === 1 ? '' : 's'} of credits left`,
      detail: `You are burning ${credits.burnPerDay} credit${credits.burnPerDay === 1 ? '' : 's'}/day. Top up before a deploy or security run stalls.`,
      href: '/dashboard/credits',
      action: 'Buy a pack',
    });
  } else if (credits.cycleUsedPercent != null && credits.cycleUsedPercent >= 80) {
    insights.push({
      id: 'credits-cycle',
      tone: 'warn',
      title: `${credits.cycleUsedPercent}% of this cycle’s credits are used`,
      detail: credits.daysLeftInCycle != null
        ? `${credits.daysLeftInCycle} day${credits.daysLeftInCycle === 1 ? '' : 's'} left in the billing cycle.`
        : 'Most of this cycle’s allotment is already spent.',
      href: '/dashboard/credits',
      action: 'Review credits',
    });
  }

  if (delivery.needsReview > 0) {
    insights.push({
      id: 'needs-review',
      tone: 'warn',
      title: `${delivery.needsReview} run${delivery.needsReview === 1 ? '' : 's'} waiting on you`,
      detail: 'Plan confirmation, remediation approval, or UI/UX review is blocking a live pipeline.',
      href: '/dashboard/sessions',
      action: 'Open sessions',
    });
  } else if (delivery.running > 0) {
    insights.push({
      id: 'running',
      tone: 'info',
      title: `${delivery.running} run${delivery.running === 1 ? '' : 's'} in flight`,
      detail: 'Open Sessions if a job looks stuck. Failed runs keep their full log even after the socket drops.',
      href: '/dashboard/sessions',
      action: 'Watch sessions',
    });
  }

  if (delivery.successRate != null && delivery.sessions.current >= 3 && delivery.successRate < 70) {
    insights.push({
      id: 'reliability',
      tone: 'warn',
      title: `Success rate is ${delivery.successRate}%`,
      detail: `${delivery.failed} failed run${delivery.failed === 1 ? '' : 's'} in the last ${USAGE_WINDOW_DAYS} days. Failed sessions keep their full log even after the socket drops.`,
      href: '/dashboard/sessions',
      action: 'Inspect failures',
    });
  }

  if (efficiency.creditsPerCompletedRun != null && efficiency.creditsPerCompletedRun >= 3 && efficiency.completedRuns >= 3) {
    insights.push({
      id: 'expensive-runs',
      tone: 'info',
      title: `Each finished run used ${efficiency.creditsPerCompletedRun} credits`,
      detail: 'Retries and failed applies still consume. Check Sessions for loops before you buy another pack.',
      href: '/dashboard/sessions',
      action: 'Review runs',
    });
  }

  if (spend.byokSharePercent != null && spend.byokSharePercent >= 60) {
    insights.push({
      id: 'byok',
      tone: 'ok',
      title: `${spend.byokSharePercent}% of AI calls used your keys`,
      detail: 'BYOK keeps model spend on your provider bill. Platform credits are mostly covering orchestration.',
      href: '/dashboard/ai',
      action: 'Manage keys',
    });
  } else if (spend.platformSharePercent != null && spend.platformSharePercent >= 80 && ai.requests.current >= 10) {
    insights.push({
      id: 'platform-spend',
      tone: 'info',
      title: 'Most AI traffic is on platform credits',
      detail: 'Attach a provider key if you want token-heavy work billed to your own account.',
      href: '/dashboard/byok',
      action: 'Set up BYOK',
    });
  }

  if (ai.tokens.percent != null && ai.tokens.percent >= 40 && ai.tokens.current > 0) {
    insights.push({
      id: 'tokens-up',
      tone: 'info',
      title: `Token use ${ai.tokens.label}`,
      detail: `${formatCompactCount(ai.tokens.current)} tokens in the last ${USAGE_WINDOW_DAYS} days. Check model mix if this was not intentional.`,
      href: '/dashboard/ai/usage',
      action: 'AI usage',
    });
  }

  if (credits.bonusRemaining > 0 && credits.bonusExpiresAt) {
    const bonusDays = daysUntil(credits.bonusExpiresAt);
    if (bonusDays != null && bonusDays <= 7) {
      insights.push({
        id: 'bonus-expiry',
        tone: 'info',
        title: `Bonus credits expire in ${bonusDays} day${bonusDays === 1 ? '' : 's'}`,
        detail: `${credits.bonusRemaining} bonus credit${credits.bonusRemaining === 1 ? '' : 's'} vanish at month end. They only unlock after paid credits hit zero.`,
        href: '/dashboard/credits',
        action: 'Use them',
      });
    }
  }

  const deploy = delivery.byService.find((row) => row.service === 'deploy');
  if (deploy && deploy.total === 0 && projects.total > 0) {
    insights.push({
      id: 'no-deploys',
      tone: 'info',
      title: 'No deploys in the last 30 days',
      detail: 'You have projects on DeplAI but nothing shipped through Terraform apply in this window.',
      href: '/dashboard/deploy',
      action: 'Open Deploy',
    });
  }

  const security = delivery.byService.find((row) => row.service === 'security_agent');
  if (security && security.total === 0 && projects.total > 0) {
    insights.push({
      id: 'no-scans',
      tone: 'info',
      title: 'No security runs in the last 30 days',
      detail: 'A scan is the cheapest way to know whether a repo is safe to generate IaC from.',
      href: '/dashboard/projects',
      action: 'Scan a project',
    });
  }

  if (input.planId === 'free' && credits.remaining > 0 && credits.remaining <= 2) {
    insights.push({
      id: 'free-plan',
      tone: 'info',
      title: 'Free plan is almost through this month',
      detail: 'Free includes 5 credits per cycle. Starter adds a paid allotment and top-up packs.',
      href: '/dashboard/billing',
      action: 'Compare plans',
    });
  }

  if (insights.length === 0) {
    insights.push({
      id: 'steady',
      tone: 'ok',
      title: 'Usage looks steady',
      detail: delivery.sessions.current > 0
        ? 'Credits, reliability, and AI spend are inside a healthy band for the last 30 days.'
        : 'Run a scan, UI/UX pass, or deploy and this page fills with operational KPIs.',
      href: delivery.sessions.current > 0 ? '/dashboard/sessions' : '/dashboard/projects',
      action: delivery.sessions.current > 0 ? 'View sessions' : 'Open projects',
    });
  }

  return insights.slice(0, 4);
}

export function weekdayLabel(index: number): string {
  return WEEKDAYS[index] || WEEKDAYS[0];
}

export function emptyUsageDashboard(input?: Partial<Pick<UsageDashboard, 'displayName' | 'planId' | 'planName'>>): UsageDashboard {
  const credits = {
    remaining: 0,
    paidRemaining: 0,
    bonusRemaining: 0,
    bonusUnlocked: false,
    bonusExpiresAt: null,
    grantedThisCycle: 0,
    consumedThisCycle: 0,
    consumed: percentDelta(0, 0),
    cycleUsedPercent: null,
    burnPerDay: 0,
    runwayDays: null,
    cycleStart: null,
    cycleEnd: null,
    daysLeftInCycle: null,
  };
  const delivery = {
    sessions: percentDelta(0, 0),
    completed: 0,
    successRate: null,
    failed: 0,
    needsReview: 0,
    running: 0,
    openWork: 0,
    avgDurationMinutes: null,
    changedFiles: 0,
    byService: emptyServiceMix(),
  };
  const spend = {
    aiChargeUsd: percentDelta(0, 0),
    byokSharePercent: null,
    platformSharePercent: null,
    byokRequests: 0,
    platformRequests: 0,
  };
  const ai = {
    requests: percentDelta(0, 0),
    tokens: percentDelta(0, 0),
    topModels: [] as ModelUsageRow[],
  };
  const projects = { total: 0, addedWindow: 0 };
  const efficiency = {
    completedRuns: 0,
    creditsPerCompletedRun: null,
    usdPer1kTokens: null,
    filesPerCompletedRun: null,
  };
  const forecast = buildCycleForecast(0, 0, null);
  return {
    generatedAt: new Date().toISOString(),
    windowDays: USAGE_WINDOW_DAYS,
    displayName: input?.displayName || 'DeplAI user',
    planId: input?.planId || 'free',
    planName: input?.planName || 'free',
    credits,
    delivery,
    spend,
    efficiency,
    forecast,
    topRepos: [],
    ai,
    projects,
    activity: {
      daily: emptyDailyActivity(),
      hourCounts: Array.from({ length: 24 }, () => 0),
      weekdayCounts: Array.from({ length: 7 }, () => 0),
      peakHourLabel: 'Anytime',
      peakWeekdayLabel: 'Any day',
    },
    insights: buildUsageInsights({
      planId: input?.planId || 'free',
      credits,
      delivery,
      spend,
      ai,
      projects,
      efficiency,
      forecast,
    }),
  };
}
