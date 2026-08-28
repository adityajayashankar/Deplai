import { query } from '@/lib/db';
import type { SessionData } from '@/lib/session';
import { getBalance } from '@/lib/billing/credits';
import { summarizeUsage } from '@/lib/ai-platform/metering';
import { SESSION_SERVICES, type SessionService, isSessionService } from '@/lib/sessions/types';
import {
  buildUsageInsights,
  burnPerDay,
  buildCycleForecast,
  cycleUsedPercent,
  daysUntil,
  emptyDailyActivity,
  emptyServiceMix,
  formatHourLabel,
  peakIndex,
  percentDelta,
  ratio,
  runwayDays,
  successRate,
  usdPerThousandTokens,
  weekdayLabel,
  USAGE_WINDOW_DAYS,
  type DailyActivityPoint,
  type ModelUsageRow,
  type RepoUsageRow,
  type ServiceMixRow,
  type UsageDashboard,
} from './dashboard';
import {
  buildWrappedView,
  emptyWrappedRaw,
  type WrappedLanguage,
  type WrappedRaw,
  type WrappedView,
} from './wrapped';

type CountRow = { n: number };
type BucketRow = { bucket: number; n: number };
type DayRow = { day: string | Date; n: number };
type LanguageRow = { languages: unknown };

function asCount(rows: CountRow[] | undefined): number {
  return Number(rows?.[0]?.n || 0);
}

async function countOrZero(sql: string, params: unknown[]): Promise<number> {
  try {
    const rows = await query<CountRow[]>(sql, params);
    return asCount(rows);
  } catch {
    return 0;
  }
}

async function bucketsOrEmpty(sql: string, params: unknown[], size: number): Promise<number[]> {
  const counts = Array.from({ length: size }, () => 0);
  try {
    const rows = await query<BucketRow[]>(sql, params);
    for (const row of rows) {
      const index = Number(row.bucket);
      if (Number.isInteger(index) && index >= 0 && index < size) {
        counts[index] += Number(row.n || 0);
      }
    }
  } catch {
    /* table may not exist yet */
  }
  return counts;
}

function parseLanguages(value: unknown): WrappedLanguage[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  return Object.entries(parsed as Record<string, unknown>)
    .map(([name, bytes]) => ({ name, bytes: Number(bytes) || 0 }))
    .filter((item) => item.name && item.bytes > 0);
}

function mergeCounts(target: number[], extra: number[]): void {
  extra.forEach((value, index) => {
    if (index < target.length) target[index] += value;
  });
}

function dayKey(value: string | Date): string {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function loadWrappedRaw(user: NonNullable<SessionData['user']>): Promise<WrappedRaw> {
  const year = new Date().getFullYear();
  const lastYear = year - 1;
  const raw = emptyWrappedRaw({
    year,
    displayName: user.name || user.login || 'DeplAI user',
    avatarUrl: user.avatarUrl || '',
  });

  try {
    const rows = await query<Array<{ display_name: string | null }>>(
      `SELECT display_name FROM user_profiles WHERE user_id = ? LIMIT 1`,
      [user.id],
    );
    if (rows[0]?.display_name?.trim()) raw.displayName = rows[0].display_name.trim();
  } catch {
    /* profile table is optional here */
  }

  const [projectsThisYear, projectsLastYear, chatMessagesThisYear, aiRequestsThisYear, aiTokensThisYear, creditsConsumedThisYear] = await Promise.all([
    countOrZero(`SELECT COUNT(*) AS n FROM projects WHERE user_id = ? AND YEAR(created_at) = ?`, [user.id, year]),
    countOrZero(`SELECT COUNT(*) AS n FROM projects WHERE user_id = ? AND YEAR(created_at) = ?`, [user.id, lastYear]),
    countOrZero(
      `SELECT COUNT(*) AS n
       FROM chat_messages m
       INNER JOIN chat_sessions s ON s.id = m.session_id
       WHERE s.user_id = ? AND YEAR(m.created_at) = ?`,
      [user.id, year],
    ),
    countOrZero(`SELECT COUNT(*) AS n FROM ai_usage WHERE user_id = ? AND YEAR(created_at) = ?`, [user.id, year]),
    countOrZero(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n
       FROM ai_usage WHERE user_id = ? AND YEAR(created_at) = ?`,
      [user.id, year],
    ),
    countOrZero(
      `SELECT COALESCE(SUM(amount), 0) AS n
       FROM credit_transactions
       WHERE user_id = ? AND type = 'consume' AND YEAR(created_at) = ?`,
      [user.id, year],
    ),
  ]);

  raw.projectsThisYear = projectsThisYear;
  raw.projectsLastYear = projectsLastYear;
  raw.chatMessagesThisYear = chatMessagesThisYear;
  raw.aiRequestsThisYear = aiRequestsThisYear;
  raw.aiTokensThisYear = aiTokensThisYear;
  raw.creditsConsumedThisYear = creditsConsumedThisYear;

  try {
    const languageRows = await query<LanguageRow[]>(
      `SELECT r.languages
       FROM github_repositories r
       INNER JOIN github_installations i ON i.id = r.installation_id
       WHERE i.user_id = ?`,
      [user.id],
    );
    const totals = new Map<string, number>();
    for (const row of languageRows) {
      for (const language of parseLanguages(row.languages)) {
        totals.set(language.name, (totals.get(language.name) || 0) + language.bytes);
      }
    }
    raw.languages = [...totals.entries()].map(([name, bytes]) => ({ name, bytes }));
  } catch {
    raw.languages = [];
  }

  const [projectHours, chatHours, aiHours, projectDays, chatDays, aiDays] = await Promise.all([
    bucketsOrEmpty(`SELECT HOUR(created_at) AS bucket, COUNT(*) AS n FROM projects WHERE user_id = ? AND YEAR(created_at) = ? GROUP BY HOUR(created_at)`, [user.id, year], 24),
    bucketsOrEmpty(
      `SELECT HOUR(m.created_at) AS bucket, COUNT(*) AS n
       FROM chat_messages m INNER JOIN chat_sessions s ON s.id = m.session_id
       WHERE s.user_id = ? AND YEAR(m.created_at) = ?
       GROUP BY HOUR(m.created_at)`,
      [user.id, year],
      24,
    ),
    bucketsOrEmpty(`SELECT HOUR(created_at) AS bucket, COUNT(*) AS n FROM ai_usage WHERE user_id = ? AND YEAR(created_at) = ? GROUP BY HOUR(created_at)`, [user.id, year], 24),
    bucketsOrEmpty(`SELECT (DAYOFWEEK(created_at) - 1) AS bucket, COUNT(*) AS n FROM projects WHERE user_id = ? AND YEAR(created_at) = ? GROUP BY DAYOFWEEK(created_at)`, [user.id, year], 7),
    bucketsOrEmpty(
      `SELECT (DAYOFWEEK(m.created_at) - 1) AS bucket, COUNT(*) AS n
       FROM chat_messages m INNER JOIN chat_sessions s ON s.id = m.session_id
       WHERE s.user_id = ? AND YEAR(m.created_at) = ?
       GROUP BY DAYOFWEEK(m.created_at)`,
      [user.id, year],
      7,
    ),
    bucketsOrEmpty(`SELECT (DAYOFWEEK(created_at) - 1) AS bucket, COUNT(*) AS n FROM ai_usage WHERE user_id = ? AND YEAR(created_at) = ? GROUP BY DAYOFWEEK(created_at)`, [user.id, year], 7),
  ]);
  mergeCounts(raw.hourCounts, projectHours);
  mergeCounts(raw.hourCounts, chatHours);
  mergeCounts(raw.hourCounts, aiHours);
  mergeCounts(raw.weekdayCounts, projectDays);
  mergeCounts(raw.weekdayCounts, chatDays);
  mergeCounts(raw.weekdayCounts, aiDays);

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 27);
  const indexByDay = new Map<string, number>();
  for (let i = 0; i < 28; i += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    indexByDay.set(localDayKey(day), i);
  }

  const heatmapQueries = [
    `SELECT DATE(created_at) AS day, COUNT(*) AS n FROM projects WHERE user_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 27 DAY) GROUP BY DATE(created_at)`,
    `SELECT DATE(m.created_at) AS day, COUNT(*) AS n
     FROM chat_messages m INNER JOIN chat_sessions s ON s.id = m.session_id
     WHERE s.user_id = ? AND m.created_at >= DATE_SUB(CURDATE(), INTERVAL 27 DAY)
     GROUP BY DATE(m.created_at)`,
    `SELECT DATE(created_at) AS day, COUNT(*) AS n FROM ai_usage WHERE user_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 27 DAY) GROUP BY DATE(created_at)`,
  ];
  for (const sql of heatmapQueries) {
    try {
      const rows = await query<DayRow[]>(sql, [user.id]);
      for (const row of rows) {
        const index = indexByDay.get(dayKey(row.day));
        if (index != null) raw.heatmapCounts[index] += Number(row.n || 0);
      }
    } catch {
      /* ignore missing tables */
    }
  }
  return raw;
}

export async function loadWrappedView(user: NonNullable<SessionData['user']>): Promise<WrappedView> {
  return buildWrappedView(await loadWrappedRaw(user));
}

type MixRow = { service: string; status: string; n: number; avg_min: number | null; files: number };
type LedgerGrantRow = {
  paid_credits_granted: number;
  bonus_credits_granted: number;
};
type RepoRow = { repo: string | null; n: number; failed: number; needs_review: number };

async function sumOrZero(sql: string, params: unknown[]): Promise<number> {
  return countOrZero(sql, params);
}

function applyDaily(
  points: DailyActivityPoint[],
  day: string | Date,
  field: 'sessions' | 'aiRequests' | 'credits',
  amount: number,
) {
  const key = dayKey(day);
  const point = points.find((item) => item.day === key);
  if (!point) return;
  point[field] += amount;
  point.total = point.sessions + point.aiRequests + point.credits;
}

export async function loadUsageDashboard(user: NonNullable<SessionData['user']>): Promise<{
  dashboard: UsageDashboard;
  wrapped: WrappedView;
}> {
  const raw = await loadWrappedRaw(user);
  const wrapped = buildWrappedView(raw);
  const userId = user.id;
  const mix = emptyServiceMix();
  const daily = emptyDailyActivity();

  const [balance, aiSummary] = await Promise.all([
    getBalance(userId).catch(() => null),
    summarizeUsage(userId).catch(() => null),
  ]);

  const [
    consumedWindow,
    consumedPrevious,
    consumedCycle,
    sessionsWindow,
    sessionsPrevious,
    projectsTotal,
    projectsWindow,
    sessionMix,
    avgDuration,
    changedFiles,
    hourSessions,
    weekdaySessions,
    hourAi,
    weekdayAi,
    hourCredits,
    weekdayCredits,
    aiChargePrevious,
    tokensPrevious,
    requestsPrevious,
    grantedThisCycle,
    topRepoRows,
  ] = await Promise.all([
    sumOrZero(
      `SELECT COALESCE(SUM(amount), 0) AS n FROM credit_transactions
       WHERE user_id = ? AND type = 'consume' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [userId, USAGE_WINDOW_DAYS],
    ),
    sumOrZero(
      `SELECT COALESCE(SUM(amount), 0) AS n FROM credit_transactions
       WHERE user_id = ? AND type = 'consume'
         AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [userId, USAGE_WINDOW_DAYS * 2, USAGE_WINDOW_DAYS],
    ),
    sumOrZero(
      `SELECT COALESCE(SUM(t.amount), 0) AS n
       FROM credit_transactions t
       INNER JOIN credit_ledgers l ON l.id = t.ledger_id
       WHERE t.user_id = ? AND t.type = 'consume'
         AND l.cycle_start <= NOW() AND l.cycle_end >= NOW()`,
      [userId],
    ),
    sumOrZero(
      `SELECT COUNT(*) AS n FROM workspace_sessions
       WHERE user_id = ? AND started_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [userId, USAGE_WINDOW_DAYS],
    ),
    sumOrZero(
      `SELECT COUNT(*) AS n FROM workspace_sessions
       WHERE user_id = ? AND started_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         AND started_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [userId, USAGE_WINDOW_DAYS * 2, USAGE_WINDOW_DAYS],
    ),
    sumOrZero(`SELECT COUNT(*) AS n FROM projects WHERE user_id = ?`, [userId]),
    sumOrZero(
      `SELECT COUNT(*) AS n FROM projects WHERE user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [userId, USAGE_WINDOW_DAYS],
    ),
    (async (): Promise<MixRow[]> => {
      try {
        return await query<MixRow[]>(
          `SELECT service, status, COUNT(*) AS n,
                  AVG(CASE WHEN completed_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, started_at, completed_at) END) AS avg_min,
                  COALESCE(SUM(changed_files_count), 0) AS files
           FROM workspace_sessions
           WHERE user_id = ? AND started_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
           GROUP BY service, status`,
          [userId, USAGE_WINDOW_DAYS],
        );
      } catch {
        return [];
      }
    })(),
    (async (): Promise<number | null> => {
      try {
        const rows = await query<Array<{ avg_min: number | null }>>(
          `SELECT AVG(TIMESTAMPDIFF(MINUTE, started_at, completed_at)) AS avg_min
           FROM workspace_sessions
           WHERE user_id = ? AND completed_at IS NOT NULL
             AND started_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
          [userId, USAGE_WINDOW_DAYS],
        );
        const value = Number(rows[0]?.avg_min);
        return Number.isFinite(value) ? Math.round(value) : null;
      } catch {
        return null;
      }
    })(),
    sumOrZero(
      `SELECT COALESCE(SUM(changed_files_count), 0) AS n FROM workspace_sessions
       WHERE user_id = ? AND started_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [userId, USAGE_WINDOW_DAYS],
    ),
    bucketsOrEmpty(
      `SELECT HOUR(started_at) AS bucket, COUNT(*) AS n FROM workspace_sessions
       WHERE user_id = ? AND started_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       GROUP BY HOUR(started_at)`,
      [userId, USAGE_WINDOW_DAYS],
      24,
    ),
    bucketsOrEmpty(
      `SELECT (DAYOFWEEK(started_at) - 1) AS bucket, COUNT(*) AS n FROM workspace_sessions
       WHERE user_id = ? AND started_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       GROUP BY DAYOFWEEK(started_at)`,
      [userId, USAGE_WINDOW_DAYS],
      7,
    ),
    bucketsOrEmpty(
      `SELECT HOUR(created_at) AS bucket, COUNT(*) AS n FROM ai_usage
       WHERE user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       GROUP BY HOUR(created_at)`,
      [userId, USAGE_WINDOW_DAYS],
      24,
    ),
    bucketsOrEmpty(
      `SELECT (DAYOFWEEK(created_at) - 1) AS bucket, COUNT(*) AS n FROM ai_usage
       WHERE user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       GROUP BY DAYOFWEEK(created_at)`,
      [userId, USAGE_WINDOW_DAYS],
      7,
    ),
    bucketsOrEmpty(
      `SELECT HOUR(created_at) AS bucket, COUNT(*) AS n FROM credit_transactions
       WHERE user_id = ? AND type = 'consume' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       GROUP BY HOUR(created_at)`,
      [userId, USAGE_WINDOW_DAYS],
      24,
    ),
    bucketsOrEmpty(
      `SELECT (DAYOFWEEK(created_at) - 1) AS bucket, COUNT(*) AS n FROM credit_transactions
       WHERE user_id = ? AND type = 'consume' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       GROUP BY DAYOFWEEK(created_at)`,
      [userId, USAGE_WINDOW_DAYS],
      7,
    ),
    sumOrZero(
      `SELECT COALESCE(SUM(customer_charge_usd), 0) AS n FROM ai_costs
       WHERE user_id = ?
         AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [userId, USAGE_WINDOW_DAYS * 2, USAGE_WINDOW_DAYS],
    ),
    sumOrZero(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM ai_usage
       WHERE user_id = ?
         AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [userId, USAGE_WINDOW_DAYS * 2, USAGE_WINDOW_DAYS],
    ),
    sumOrZero(
      `SELECT COUNT(*) AS n FROM ai_usage
       WHERE user_id = ?
         AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [userId, USAGE_WINDOW_DAYS * 2, USAGE_WINDOW_DAYS],
    ),
    (async (): Promise<number> => {
      try {
        const grantRows = await query<LedgerGrantRow[]>(
          `SELECT paid_credits_granted, bonus_credits_granted
           FROM credit_ledgers
           WHERE user_id = ? AND cycle_start <= NOW() AND cycle_end >= NOW()
           ORDER BY cycle_start DESC LIMIT 1`,
          [userId],
        );
        const ledger = grantRows[0];
        if (!ledger) return 0;
        return Number(ledger.paid_credits_granted || 0) + Number(ledger.bonus_credits_granted || 0);
      } catch {
        return 0;
      }
    })(),
    (async (): Promise<RepoRow[]> => {
      try {
        return await query<RepoRow[]>(
          `SELECT CASE WHEN repo IS NULL OR repo = '' THEN '(no repo)' ELSE repo END AS repo,
                  COUNT(*) AS n,
                  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                  SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END) AS needs_review
           FROM workspace_sessions
           WHERE user_id = ? AND started_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
           GROUP BY CASE WHEN repo IS NULL OR repo = '' THEN '(no repo)' ELSE repo END
           ORDER BY n DESC
           LIMIT 6`,
          [userId, USAGE_WINDOW_DAYS],
        );
      } catch {
        return [];
      }
    })(),
  ]);

  const mixByService = new Map<SessionService, ServiceMixRow>(
    mix.map((row) => [row.service, { ...row }]),
  );
  let completed = 0;
  let failed = 0;
  let needsReview = 0;
  let running = 0;
  for (const row of sessionMix) {
    if (!isSessionService(row.service)) continue;
    const target = mixByService.get(row.service);
    if (!target) continue;
    const count = Number(row.n || 0);
    target.total += count;
    if (row.status === 'completed') {
      target.completed += count;
      completed += count;
    } else if (row.status === 'failed') {
      target.failed += count;
      failed += count;
    } else if (row.status === 'needs_review') {
      target.needsReview += count;
      needsReview += count;
    } else if (row.status === 'running' || row.status === 'queued') {
      target.running += count;
      running += count;
    }
  }
  const byService = SESSION_SERVICES.map((service) => {
    const row = mixByService.get(service)!;
    return { ...row, successRate: successRate(row.completed, row.failed) };
  });

  const dailyQueries: Array<{ sql: string; field: 'sessions' | 'aiRequests' | 'credits' }> = [
    {
      field: 'sessions',
      sql: `SELECT DATE(started_at) AS day, COUNT(*) AS n FROM workspace_sessions
            WHERE user_id = ? AND started_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            GROUP BY DATE(started_at)`,
    },
    {
      field: 'aiRequests',
      sql: `SELECT DATE(created_at) AS day, COUNT(*) AS n FROM ai_usage
            WHERE user_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            GROUP BY DATE(created_at)`,
    },
    {
      field: 'credits',
      sql: `SELECT DATE(created_at) AS day, COALESCE(SUM(amount), 0) AS n FROM credit_transactions
            WHERE user_id = ? AND type = 'consume' AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            GROUP BY DATE(created_at)`,
    },
  ];
  for (const item of dailyQueries) {
    try {
      const rows = await query<DayRow[]>(item.sql, [userId, USAGE_WINDOW_DAYS - 1]);
      for (const row of rows) applyDaily(daily, row.day, item.field, Number(row.n || 0));
    } catch {
      /* optional tables */
    }
  }

  const remaining = Number(balance?.total || 0);
  const burn = burnPerDay(consumedWindow);
  const consumed = percentDelta(consumedWindow, consumedPrevious);
  const daysLeft = daysUntil(balance?.cycleEnd || null);
  const hourCounts = Array.from({ length: 24 }, (_, index) => (
    (hourSessions[index] || 0) + (hourAi[index] || 0) + (hourCredits[index] || 0)
  ));
  const weekdayCounts = Array.from({ length: 7 }, (_, index) => (
    (weekdaySessions[index] || 0) + (weekdayAi[index] || 0) + (weekdayCredits[index] || 0)
  ));
  const hourTotal = hourCounts.reduce((sum, value) => sum + value, 0);
  const dayTotal = weekdayCounts.reduce((sum, value) => sum + value, 0);

  const byokRequests = Number(
    (aiSummary?.byCredentialSource || []).find((row) => row.credential_source === 'byok')?.requests || 0,
  );
  const platformRequests = Number(
    (aiSummary?.byCredentialSource || []).reduce((sum, row) => (
      row.credential_source === 'byok' ? sum : sum + Number(row.requests || 0)
    ), 0),
  );
  const aiRequestTotal = byokRequests + platformRequests;
  const aiChargeCurrent = Number(aiSummary?.costs?.customer_charge_usd || 0);
  const tokensCurrent = Number(aiSummary?.usage?.input_tokens || 0) + Number(aiSummary?.usage?.output_tokens || 0);
  const requestsCurrent = Number(aiSummary?.usage?.requests || 0);

  const topModels: ModelUsageRow[] = (aiSummary?.byModel || []).slice(0, 6).map((row) => ({
    providerId: row.provider_id,
    modelId: row.model_id,
    requests: Number(row.requests || 0),
    tokens: Number(row.tokens || 0),
  }));

  const topRepos: RepoUsageRow[] = topRepoRows.map((row) => ({
    repo: String(row.repo || '(no repo)'),
    runs: Number(row.n || 0),
    failed: Number(row.failed || 0),
    needsReview: Number(row.needs_review || 0),
  }));

  const credits = {
    remaining,
    paidRemaining: Number(balance?.paidRemaining || 0),
    bonusRemaining: Number(balance?.bonusRemaining || 0),
    bonusUnlocked: Boolean(balance?.bonusUnlocked),
    bonusExpiresAt: balance?.bonusExpiresAt || null,
    grantedThisCycle,
    consumedThisCycle: consumedCycle,
    consumed,
    cycleUsedPercent: cycleUsedPercent(grantedThisCycle, remaining, consumedCycle),
    burnPerDay: burn,
    runwayDays: runwayDays(remaining, burn),
    cycleStart: balance?.cycleStart || null,
    cycleEnd: balance?.cycleEnd || null,
    daysLeftInCycle: daysLeft,
  };

  const delivery = {
    sessions: percentDelta(sessionsWindow, sessionsPrevious),
    completed,
    successRate: successRate(completed, failed),
    failed,
    needsReview,
    running,
    openWork: running + needsReview,
    avgDurationMinutes: avgDuration,
    changedFiles,
    byService,
  };

  const efficiency = {
    completedRuns: completed,
    creditsPerCompletedRun: ratio(consumedWindow, completed, 1),
    usdPer1kTokens: usdPerThousandTokens(aiChargeCurrent, tokensCurrent),
    filesPerCompletedRun: ratio(changedFiles, completed, 1),
  };

  const forecast = buildCycleForecast(remaining, burn, daysLeft);

  const spend = {
    aiChargeUsd: percentDelta(aiChargeCurrent, aiChargePrevious),
    byokSharePercent: aiRequestTotal > 0 ? Math.round((byokRequests / aiRequestTotal) * 100) : null,
    platformSharePercent: aiRequestTotal > 0 ? Math.round((platformRequests / aiRequestTotal) * 100) : null,
    byokRequests,
    platformRequests,
  };

  const ai = {
    requests: percentDelta(requestsCurrent, requestsPrevious),
    tokens: percentDelta(tokensCurrent, tokensPrevious),
    topModels,
  };

  const projects = {
    total: projectsTotal,
    addedWindow: projectsWindow,
  };

  const dashboard: UsageDashboard = {
    generatedAt: new Date().toISOString(),
    windowDays: USAGE_WINDOW_DAYS,
    displayName: raw.displayName,
    planId: balance?.planId || 'free',
    planName: balance?.planName || 'free',
    credits,
    delivery,
    spend,
    efficiency,
    forecast,
    topRepos,
    ai,
    projects,
    activity: {
      daily,
      hourCounts,
      weekdayCounts,
      peakHourLabel: hourTotal > 0 ? formatHourLabel(peakIndex(hourCounts)) : 'Anytime',
      peakWeekdayLabel: dayTotal > 0 ? weekdayLabel(peakIndex(weekdayCounts)) : 'Any day',
    },
    insights: buildUsageInsights({
      planId: balance?.planId || 'free',
      credits,
      delivery,
      spend,
      ai,
      projects,
      efficiency,
      forecast,
    }),
  };

  return { dashboard, wrapped };
}
