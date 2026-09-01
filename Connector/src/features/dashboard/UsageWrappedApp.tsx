'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity,
  ArrowRight,
  Coins,
  FolderGit2,
  ShieldCheck,
  Sparkles,
  Wallet,
} from 'lucide-react';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import { appBtnInk, appBtnPaper, appPaper } from '@/features/workspace/theme';
import { LOGIN_HREF } from '@/lib/auth-providers';
import {
  emptyUsageDashboard,
  formatUsd,
  type DailyActivityPoint,
  type UsageDashboard,
  type UsageDelta,
  type UsageInsight,
} from '@/lib/usage/dashboard';
import { buildWrappedView, emptyWrappedRaw, formatCompactCount, type WrappedView } from '@/lib/usage/wrapped';

const fallbackWrapped = buildWrappedView(emptyWrappedRaw({ year: new Date().getFullYear() }));
const fallbackDashboard = emptyUsageDashboard();

const HATCH_FILL = 'repeating-linear-gradient(45deg, #000 0 2px, #fff 2px 6px)';
const STRIPE_FILL = 'repeating-linear-gradient(0deg, #000 0 1px, #fff 1px 3px)';

function planLabel(planId: string, planName: string): string {
  const raw = (planName || planId || 'free').replace(/_/g, ' ');
  return raw.replace(/\b\w/g, (char) => char.toUpperCase());
}

function forecastCopy(dashboard: UsageDashboard): string {
  const { credits, forecast } = dashboard;
  if (forecast.status === 'idle') {
    return 'No credit burn in this window. Run a scan or deploy and runway appears here.';
  }
  if (forecast.willExhaustBeforeCycleEnd && credits.runwayDays != null) {
    return `At ${credits.burnPerDay}/day you empty in ~${credits.runwayDays} days, before this cycle renews.`;
  }
  if (forecast.projectedRemainingAtCycleEnd != null) {
    return `On this burn you should still hold ${forecast.projectedRemainingAtCycleEnd} credit${forecast.projectedRemainingAtCycleEnd === 1 ? '' : 's'} at renewal.`;
  }
  if (credits.runwayDays != null) {
    return `${credits.runwayDays} day runway at ${credits.burnPerDay} credits/day.`;
  }
  return `${credits.burnPerDay} credits/day over the last ${dashboard.windowDays} days.`;
}

function DeltaChip({ delta }: { delta: UsageDelta }) {
  return (
    <span className="border-[2px] border-black bg-white px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-black">
      {delta.label}
    </span>
  );
}

function KpiCard({
  label,
  value,
  hint,
  delta,
  href,
  onOpen,
}: {
  label: string;
  value: string;
  hint: string;
  delta?: UsageDelta;
  href?: string;
  onOpen?: () => void;
}) {
  const inner = (
    <>
      <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-neutral-500">{label}</p>
      <p className="mt-3 font-display text-4xl font-semibold tracking-tight text-black">{value}</p>
      <p className="mt-2 text-[13px] leading-relaxed text-neutral-600">{hint}</p>
      {delta ? <div className="mt-4"><DeltaChip delta={delta} /></div> : null}
    </>
  );
  if (href && onOpen) {
    return (
      <button type="button" onClick={onOpen} className={`${appPaper} p-5 text-left transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-[4px_4px_0_0_#000]`}>
        {inner}
      </button>
    );
  }
  return <div className={`${appPaper} p-5`}>{inner}</div>;
}

function InsightCard({ insight, onOpen }: { insight: UsageInsight; onOpen: (href: string) => void }) {
  return (
    <div
      className="border-[3px] border-black bg-white p-4"
      style={insight.tone === 'warn' ? { backgroundImage: 'repeating-linear-gradient(45deg, #ffffff 0 8px, #f3f3f3 8px 16px)' } : undefined}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">
        {insight.tone === 'warn' ? 'Attention' : insight.tone === 'ok' ? 'Healthy' : 'Next'}
      </p>
      <h3 className="mt-2 font-display text-lg text-black">{insight.title}</h3>
      <p className="mt-2 text-[13px] leading-relaxed text-neutral-600">{insight.detail}</p>
      {insight.href && insight.action ? (
        <button type="button" onClick={() => onOpen(insight.href!)} className={`${appBtnPaper} mt-4 px-3 py-1.5 text-[12px]`}>
          {insight.action}
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function BarTrack({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? Math.max(value > 0 ? 4 : 0, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-2 w-full overflow-hidden border-[2px] border-black bg-white">
      <div className="h-full bg-black" style={{ width: `${width}%` }} />
    </div>
  );
}

function StackedDay({ point, max }: { point: DailyActivityPoint; max: number }) {
  const sessions = max > 0 ? Math.round((point.sessions / max) * 100) : 0;
  const ai = max > 0 ? Math.round((point.aiRequests / max) * 100) : 0;
  const credits = max > 0 ? Math.round((point.credits / max) * 100) : 0;
  return (
    <div
      className="flex min-w-0 flex-1 flex-col items-stretch justify-end"
      title={`${point.label}: ${point.sessions} runs, ${point.aiRequests} AI, ${point.credits} credits`}
    >
      <div className="flex h-32 flex-col justify-end overflow-hidden">
        {point.credits > 0 ? <div className="w-full border-x-[2px] border-black" style={{ height: `${Math.max(4, credits)}%`, backgroundImage: STRIPE_FILL }} /> : null}
        {point.aiRequests > 0 ? <div className="w-full border-x-[2px] border-black" style={{ height: `${Math.max(4, ai)}%`, backgroundImage: HATCH_FILL }} /> : null}
        {point.sessions > 0 ? <div className="w-full border-[2px] border-black bg-black" style={{ height: `${Math.max(6, sessions)}%` }} /> : null}
        {point.total <= 0 ? <div className="w-full border-[2px] border-black bg-white" style={{ height: '2%' }} /> : null}
      </div>
    </div>
  );
}

export default function UsageWrappedApp() {
  const router = useRouter();
  const wrappedRef = useRef<HTMLDivElement>(null);
  const [dashboard, setDashboard] = useState<UsageDashboard>(fallbackDashboard);
  const [wrapped, setWrapped] = useState<WrappedView>(fallbackWrapped);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const response = await fetch('/api/usage/wrapped', { cache: 'no-store' }).catch(() => null);
      if (!response) {
        if (!cancelled) {
          setNotice('Could not load usage.');
          setLoading(false);
        }
        return;
      }
      if (response.status === 401) {
        router.replace(LOGIN_HREF);
        return;
      }
      const payload = await response.json() as { dashboard?: UsageDashboard; wrapped?: WrappedView; error?: string };
      if (cancelled) return;
      if (!response.ok) {
        setNotice(payload.error || 'Could not load usage.');
      }
      if (payload.dashboard) setDashboard(payload.dashboard);
      if (payload.wrapped) setWrapped(payload.wrapped);
      setLoading(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const open = useCallback((href: string) => {
    router.push(href);
  }, [router]);

  const maxDaily = useMemo(
    () => Math.max(1, ...dashboard.activity.daily.map((point) => point.total)),
    [dashboard.activity.daily],
  );
  const maxHour = useMemo(
    () => Math.max(1, ...dashboard.activity.hourCounts),
    [dashboard.activity.hourCounts],
  );
  const maxWeekday = useMemo(
    () => Math.max(1, ...dashboard.activity.weekdayCounts),
    [dashboard.activity.weekdayCounts],
  );
  const maxService = useMemo(
    () => Math.max(1, ...dashboard.delivery.byService.map((row) => row.total)),
    [dashboard.delivery.byService],
  );
  const maxModelTokens = useMemo(
    () => Math.max(1, ...dashboard.ai.topModels.map((row) => row.tokens)),
    [dashboard.ai.topModels],
  );
  const maxRepoRuns = useMemo(
    () => Math.max(1, ...dashboard.topRepos.map((row) => row.runs)),
    [dashboard.topRepos],
  );

  const captureScreenshot = async () => {
    if (!wrappedRef.current) return null;
    try {
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(wrappedRef.current, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        width: wrappedRef.current.scrollWidth,
        height: wrappedRef.current.scrollHeight,
      });
      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((blob) => resolve(blob), 'image/png');
      });
    } catch {
      return null;
    }
  };

  const handleDownloadImage = async () => {
    const blob = await captureScreenshot();
    if (!blob) {
      window.alert('Could not capture the year-in-review card.');
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `deplai-${wrapped.year}-wrapped.png`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleShareOnX = async () => {
    const blob = await captureScreenshot();
    if (blob && navigator.share && navigator.canShare) {
      try {
        const file = new File([blob], `deplai-${wrapped.year}-wrapped.png`, { type: 'image/png' });
        const shareData = { title: wrapped.shareTitle, text: wrapped.shareText, files: [file] };
        if (navigator.canShare(shareData)) {
          await navigator.share(shareData);
          return;
        }
      } catch {
        /* fall through */
      }
    }
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(wrapped.shareText)}`, '_blank', 'width=550,height=420');
  };

  const creditHint = dashboard.credits.runwayDays != null
    ? `${dashboard.credits.runwayDays} day runway at ${dashboard.credits.burnPerDay}/day`
    : dashboard.credits.burnPerDay > 0
      ? `${dashboard.credits.burnPerDay} credits/day`
      : 'No credit burn in this window';

  const successHint = dashboard.delivery.successRate == null
    ? 'No finished runs yet'
    : `${dashboard.delivery.completed} completed · ${dashboard.delivery.failed} failed`;

  const cycleForecast = forecastCopy(dashboard);

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent font-sans">
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <WorkspaceCommandHeader section="Usage" onExit={() => router.push('/')} />
        <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
          <div className="mx-auto max-w-6xl">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Workspace</p>
                <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-black">Usage</h2>
                <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-zinc-500">
                  {dashboard.displayName ? `${dashboard.displayName} · ` : ''}Last {dashboard.windowDays} days of credits, pipeline reliability, and AI spend — the numbers a developer, startup, or SME actually acts on.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="border-[2px] border-black bg-white px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-black">
                  {planLabel(dashboard.planId, dashboard.planName)}
                </span>
                <span className="border-[2px] border-black bg-black px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-white">
                  {dashboard.windowDays}d window
                </span>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
              {[
                { href: '/dashboard/credits', label: 'Credits' },
                { href: '/dashboard/sessions', label: 'Sessions' },
                { href: '/dashboard/ai/usage', label: 'AI usage' },
                { href: '/dashboard/billing', label: 'Plan' },
              ].map((link) => (
                <button key={link.href} type="button" onClick={() => open(link.href)} className={appBtnPaper}>
                  {link.label}
                </button>
              ))}
            </div>

            {notice ? (
              <p className="mt-6 border-[3px] border-black bg-white px-4 py-3 text-[13px] text-black">{notice}</p>
            ) : null}

            {loading ? (
              <div className="mt-8 grid gap-4 md:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="app-paper h-36 animate-pulse" />
                ))}
              </div>
            ) : (
              <>
            <div className="mt-8 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {dashboard.insights.map((insight) => (
                <InsightCard key={insight.id} insight={insight} onOpen={open} />
              ))}
            </div>

            <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <KpiCard
                label="Credits remaining"
                value={formatCompactCount(dashboard.credits.remaining)}
                hint={creditHint}
                href="/dashboard/credits"
                onOpen={() => open('/dashboard/credits')}
              />
              <KpiCard
                label="Pipeline runs"
                value={formatCompactCount(dashboard.delivery.sessions.current)}
                hint={`${dashboard.projects.total} projects · ${dashboard.delivery.openWork} open`}
                delta={dashboard.delivery.sessions}
                href="/dashboard/sessions"
                onOpen={() => open('/dashboard/sessions')}
              />
              <KpiCard
                label="Success rate"
                value={dashboard.delivery.successRate == null ? '—' : `${dashboard.delivery.successRate}%`}
                hint={successHint}
                href="/dashboard/sessions"
                onOpen={() => open('/dashboard/sessions')}
              />
              <KpiCard
                label="Est. AI spend"
                value={formatUsd(dashboard.spend.aiChargeUsd.current)}
                hint={`${formatCompactCount(dashboard.ai.tokens.current)} tokens`}
                delta={dashboard.spend.aiChargeUsd}
                href="/dashboard/ai/usage"
                onOpen={() => open('/dashboard/ai/usage')}
              />
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <KpiCard
                label="Credits consumed"
                value={formatCompactCount(dashboard.credits.consumed.current)}
                hint={`${dashboard.credits.consumedThisCycle} this billing cycle`}
                delta={dashboard.credits.consumed}
                href="/dashboard/credits"
                onOpen={() => open('/dashboard/credits')}
              />
              <KpiCard
                label="Credits / finished run"
                value={dashboard.efficiency.creditsPerCompletedRun == null ? '—' : String(dashboard.efficiency.creditsPerCompletedRun)}
                hint={dashboard.efficiency.completedRuns > 0
                  ? `${dashboard.efficiency.completedRuns} completed in this window`
                  : 'Appears after a run completes'}
              />
              <KpiCard
                label="Open work"
                value={formatCompactCount(dashboard.delivery.openWork)}
                hint={`${dashboard.delivery.running} live · ${dashboard.delivery.needsReview} need review`}
                href="/dashboard/sessions"
                onOpen={() => open('/dashboard/sessions')}
              />
              <KpiCard
                label="USD / 1k tokens"
                value={dashboard.efficiency.usdPer1kTokens == null ? '—' : formatUsd(dashboard.efficiency.usdPer1kTokens)}
                hint={dashboard.efficiency.filesPerCompletedRun == null
                  ? `${dashboard.projects.addedWindow} projects added`
                  : `${dashboard.efficiency.filesPerCompletedRun} files / finished run`}
                href="/dashboard/ai/usage"
                onOpen={() => open('/dashboard/ai/usage')}
              />
            </div>

            <div className="mt-8 grid gap-4 lg:grid-cols-2">
              <section className={`${appPaper} p-5`}>
                <div className="flex items-center gap-2">
                  <Wallet className="h-4 w-4" />
                  <h3 className="font-display text-lg text-black">Credit health</h3>
                </div>
                <p className="mt-1 text-[13px] text-neutral-600">{cycleForecast}</p>
                <div className="mt-5">
                  <div className="mb-2 flex items-center justify-between text-[12px] text-neutral-600">
                    <span>This cycle</span>
                    <span className="font-mono text-black">
                      {dashboard.credits.cycleUsedPercent == null ? '—' : `${dashboard.credits.cycleUsedPercent}% used`}
                    </span>
                  </div>
                  <BarTrack value={dashboard.credits.cycleUsedPercent || 0} max={100} />
                </div>
                <dl className="mt-5 grid grid-cols-2 gap-3 text-[13px]">
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">Paid left</dt>
                    <dd className="mt-1 font-display text-xl text-black">{dashboard.credits.paidRemaining}</dd>
                  </div>
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">Bonus left</dt>
                    <dd className="mt-1 font-display text-xl text-black">{dashboard.credits.bonusRemaining}</dd>
                  </div>
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">Burn / day</dt>
                    <dd className="mt-1 font-display text-xl text-black">{dashboard.credits.burnPerDay}</dd>
                  </div>
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">Cycle days left</dt>
                    <dd className="mt-1 font-display text-xl text-black">
                      {dashboard.credits.daysLeftInCycle == null ? '—' : dashboard.credits.daysLeftInCycle}
                    </dd>
                  </div>
                </dl>
                <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">
                  Forecast {dashboard.forecast.status}
                  {dashboard.forecast.projectedRemainingAtCycleEnd != null
                    ? ` · ${dashboard.forecast.projectedRemainingAtCycleEnd} at renewal`
                    : ''}
                </p>
                <button type="button" onClick={() => open('/dashboard/credits')} className={`${appBtnInk} mt-6`}>
                  <Coins className="h-4 w-4" />
                  Top up
                </button>
              </section>

              <section className={`${appPaper} p-5`}>
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4" />
                  <h3 className="font-display text-lg text-black">Where AI spend lands</h3>
                </div>
                <p className="mt-1 text-[13px] text-neutral-600">
                  BYOK is billed to your provider. Platform traffic draws DeplAI credits.
                </p>
                <div className="mt-6 grid grid-cols-2 gap-3">
                  <div className="border-[2px] border-black p-3">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">BYOK</p>
                    <p className="mt-2 font-display text-3xl text-black">
                      {dashboard.spend.byokSharePercent == null ? '—' : `${dashboard.spend.byokSharePercent}%`}
                    </p>
                    <p className="mt-1 text-[12px] text-neutral-600">{dashboard.spend.byokRequests} requests</p>
                  </div>
                  <div className="border-[2px] border-black p-3">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">Platform</p>
                    <p className="mt-2 font-display text-3xl text-black">
                      {dashboard.spend.platformSharePercent == null ? '—' : `${dashboard.spend.platformSharePercent}%`}
                    </p>
                    <p className="mt-1 text-[12px] text-neutral-600">{dashboard.spend.platformRequests} requests</p>
                  </div>
                </div>
                <div className="mt-5">
                  <div className="mb-2 flex justify-between text-[12px] text-neutral-600">
                    <span>Tokens</span>
                    <span className="font-mono text-black">{formatCompactCount(dashboard.ai.tokens.current)}</span>
                  </div>
                  <DeltaChip delta={dashboard.ai.tokens} />
                </div>
                <p className="mt-4 text-[12px] text-neutral-600">
                  {dashboard.ai.requests.current} model calls
                  {dashboard.efficiency.usdPer1kTokens != null
                    ? ` · ${formatUsd(dashboard.efficiency.usdPer1kTokens)} per 1k tokens`
                    : ''}
                </p>
                <button type="button" onClick={() => open('/dashboard/ai')} className={`${appBtnPaper} mt-6`}>
                  Manage keys
                </button>
              </section>
            </div>

            <section className={`${appPaper} mt-8 p-5`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4" />
                  <h3 className="font-display text-lg text-black">Delivery mix</h3>
                </div>
                <p className="text-[12px] text-neutral-600">
                  {dashboard.delivery.avgDurationMinutes == null
                    ? 'Duration appears after runs complete'
                    : `Avg ${dashboard.delivery.avgDurationMinutes} min · ${dashboard.delivery.changedFiles} files touched`}
                </p>
              </div>
              <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {dashboard.delivery.byService.map((row) => (
                  <button
                    key={row.service}
                    type="button"
                    onClick={() => open('/dashboard/sessions')}
                    className="border-[2px] border-black bg-white p-3 text-left"
                  >
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">{row.label}</p>
                    <p className="mt-2 font-display text-3xl text-black">{row.total}</p>
                    <div className="mt-3"><BarTrack value={row.total} max={maxService} /></div>
                    <p className="mt-3 text-[12px] text-neutral-600">
                      {row.successRate == null ? 'No finished runs' : `${row.successRate}% success`}
                      {row.needsReview > 0 ? ` · ${row.needsReview} review` : ''}
                      {row.failed > 0 ? ` · ${row.failed} failed` : ''}
                    </p>
                  </button>
                ))}
              </div>
            </section>

            <section className={`${appPaper} mt-8 p-5`}>
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4" />
                <h3 className="font-display text-lg text-black">Activity</h3>
              </div>
              <p className="mt-1 text-[13px] text-neutral-600">
                Peak {dashboard.activity.peakWeekdayLabel}, {dashboard.activity.peakHourLabel} in this {dashboard.windowDays}-day window.
              </p>
              <div className="mt-4 flex flex-wrap gap-4 text-[11px] text-neutral-600">
                <span className="inline-flex items-center gap-2">
                  <span className="h-3 w-3 border-[2px] border-black bg-black" />
                  Pipeline
                </span>
                <span className="inline-flex items-center gap-2">
                  <span className="h-3 w-3 border-[2px] border-black" style={{ backgroundImage: HATCH_FILL }} />
                  AI requests
                </span>
                <span className="inline-flex items-center gap-2">
                  <span className="h-3 w-3 border-[2px] border-black" style={{ backgroundImage: STRIPE_FILL }} />
                  Credits
                </span>
              </div>
              <div className="mt-6 flex items-end gap-[3px]">
                {dashboard.activity.daily.map((point) => (
                  <StackedDay key={point.day} point={point} max={maxDaily} />
                ))}
              </div>
              <div className="mt-2 flex justify-between font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500">
                <span>{dashboard.activity.daily[0]?.label}</span>
                <span>Today</span>
              </div>

              <div className="mt-8 grid gap-6 lg:grid-cols-2">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">Hours</p>
                  <div className="mt-3 flex h-16 items-end gap-px">
                    {dashboard.activity.hourCounts.map((value, hour) => (
                      <div
                        key={hour}
                        className="flex-1 bg-black"
                        style={{ height: `${Math.max(value > 0 ? 12 : 4, Math.round((value / maxHour) * 100))}%` }}
                        title={`${hour}:00 · ${value}`}
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">Weekdays</p>
                  <div className="mt-3 grid grid-cols-7 gap-2">
                    {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label, index) => (
                      <div key={`${label}-${index}`} className="text-center">
                        <div className="mx-auto flex h-16 w-full flex-col justify-end border-[2px] border-black bg-white">
                          <div
                            className="w-full bg-black"
                            style={{
                              height: `${Math.max(dashboard.activity.weekdayCounts[index] > 0 ? 12 : 0, Math.round((dashboard.activity.weekdayCounts[index] / maxWeekday) * 100))}%`,
                            }}
                          />
                        </div>
                        <p className="mt-1 font-mono text-[10px] text-neutral-500">{label}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <div className="mt-8 grid gap-4 lg:grid-cols-2">
              <section className={`${appPaper} overflow-hidden`}>
                <div className="flex items-center justify-between border-b-[3px] border-black px-5 py-4">
                  <h3 className="font-display text-lg text-black">Models this window</h3>
                  <button type="button" onClick={() => open('/dashboard/ai/usage')} className="text-[12px] font-bold underline">
                    Full AI usage
                  </button>
                </div>
                {dashboard.ai.topModels.length === 0 ? (
                  <p className="px-5 py-8 text-[13px] text-neutral-500">No model calls in the last {dashboard.windowDays} days.</p>
                ) : (
                  <table className="w-full text-left text-sm">
                    <thead className="border-b-[3px] border-black bg-neutral-100 font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-600">
                      <tr>
                        <th className="px-5 py-3">Model</th>
                        <th className="px-5 py-3">Requests</th>
                        <th className="px-5 py-3">Tokens</th>
                        <th className="hidden px-5 py-3 sm:table-cell">Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dashboard.ai.topModels.map((row) => (
                        <tr key={`${row.providerId}:${row.modelId}`} className="border-t-[3px] border-black">
                          <td className="px-5 py-3">
                            <p className="font-mono text-[12px] text-black">{row.modelId}</p>
                            <p className="text-[11px] text-neutral-500">{row.providerId}</p>
                          </td>
                          <td className="px-5 py-3 text-black">{formatCompactCount(row.requests)}</td>
                          <td className="px-5 py-3 text-black">{formatCompactCount(row.tokens)}</td>
                          <td className="hidden px-5 py-3 sm:table-cell">
                            <BarTrack value={row.tokens} max={maxModelTokens} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <section className={`${appPaper} overflow-hidden`}>
                <div className="flex items-center justify-between border-b-[3px] border-black px-5 py-4">
                  <div className="flex items-center gap-2">
                    <FolderGit2 className="h-4 w-4" />
                    <h3 className="font-display text-lg text-black">Repos this window</h3>
                  </div>
                  <button type="button" onClick={() => open('/dashboard/sessions')} className="text-[12px] font-bold underline">
                    Sessions
                  </button>
                </div>
                {dashboard.topRepos.length === 0 ? (
                  <p className="px-5 py-8 text-[13px] text-neutral-500">No pipeline runs tagged to a repo yet.</p>
                ) : (
                  <table className="w-full text-left text-sm">
                    <thead className="border-b-[3px] border-black bg-neutral-100 font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-600">
                      <tr>
                        <th className="px-5 py-3">Repo</th>
                        <th className="px-5 py-3">Runs</th>
                        <th className="px-5 py-3">Failed</th>
                        <th className="hidden px-5 py-3 sm:table-cell">Load</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dashboard.topRepos.map((row) => (
                        <tr key={row.repo} className="border-t-[3px] border-black">
                          <td className="max-w-[180px] truncate px-5 py-3 font-mono text-[12px] text-black">{row.repo}</td>
                          <td className="px-5 py-3 text-black">{row.runs}</td>
                          <td className="px-5 py-3 text-black">
                            {row.failed}
                            {row.needsReview > 0 ? ` · ${row.needsReview} review` : ''}
                          </td>
                          <td className="hidden px-5 py-3 sm:table-cell">
                            <BarTrack value={row.runs} max={maxRepoRuns} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </div>

            <section className="mt-10">
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Year in review</p>
              <h3 className="mt-2 font-display text-2xl font-semibold tracking-tight text-black">{wrapped.shareTitle}</h3>
              <p className="mt-2 max-w-2xl text-[13px] text-neutral-500">{wrapped.shareSubtitle}</p>

              <div ref={wrappedRef} className={`${appPaper} mt-6 p-6`}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">{wrapped.possessiveLabel}</p>
                    <p className="mt-2 font-display text-5xl font-semibold tracking-tight text-black">{wrapped.year}</p>
                    <p className="mt-4 max-w-xl text-[13px] leading-relaxed text-black">{wrapped.headline}</p>
                  </div>
                  <div className="border-[3px] border-black bg-black px-4 py-3 text-white">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/70">You are a</p>
                    <p className="mt-1 font-display text-xl">{wrapped.personaLines.join(' ')}</p>
                  </div>
                </div>
                <div className="mt-6 grid gap-4 sm:grid-cols-3">
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">{wrapped.primaryCountLabel}</p>
                    <p className="mt-1 font-display text-3xl text-black">{wrapped.primaryCount}</p>
                  </div>
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">{wrapped.secondaryCountLabel}</p>
                    <p className="mt-1 font-display text-3xl text-black">{wrapped.secondaryCount}</p>
                  </div>
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">Top category</p>
                    <p className="mt-1 font-display text-3xl text-black">{wrapped.categoryValue}</p>
                  </div>
                </div>
                <div className="mt-6 grid gap-6 sm:grid-cols-2">
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">{wrapped.stackCaption}</p>
                    <div className="mt-3 space-y-2">
                      {wrapped.stack.map((item) => (
                        <div key={item.label}>
                          <div className="mb-1 flex justify-between text-[12px] text-black">
                            <span>{item.initial} {item.label}</span>
                            <span className="font-mono">{item.percent}%</span>
                          </div>
                          <BarTrack value={item.percent} max={100} />
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">Last 28 days</p>
                    <div className="mt-3 grid grid-cols-7 gap-1">
                      {wrapped.heatmap.map((active, index) => (
                        <div
                          key={index}
                          className={`h-4 w-full border-[2px] border-black ${active ? 'bg-black' : 'bg-white'}`}
                        />
                      ))}
                    </div>
                    <p className="mt-3 text-[12px] text-neutral-600">{wrapped.peakBlurb}</p>
                  </div>
                </div>
                <p className="mt-4 text-[13px] text-neutral-600">{wrapped.personaBlurb}</p>
              </div>

              <div className="mt-4 flex flex-wrap gap-3">
                <button type="button" onClick={() => void handleDownloadImage()} className={appBtnPaper}>
                  Download card
                </button>
                <button type="button" onClick={() => void handleShareOnX()} className={appBtnInk}>
                  Share on X
                </button>
              </div>
            </section>
            <p className="mt-8 font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">
              Snapshot {new Date(dashboard.generatedAt).toLocaleString()}
            </p>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
