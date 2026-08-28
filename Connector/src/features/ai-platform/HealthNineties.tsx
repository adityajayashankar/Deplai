'use client';

import { Plus_Jakarta_Sans, Space_Grotesk } from 'next/font/google';
import { useEffect, useMemo, useRef, useState } from 'react';

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-plus-jakarta',
});

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space-grotesk',
});

const cardHover =
  'transition-all hover:translate-x-1 hover:translate-y-1 hover:shadow-[8px_8px_0px_0px_#000]';

export type HealthSnapshot = {
  providerId: string;
  status: string;
  latencyMs: number | null;
  detail: string | null;
  availability?: number;
  errorRate?: number;
  rateLimitRate?: number;
  timeoutRate?: number;
  checkedAt?: string;
};

type HealthProvider = {
  id: string;
  displayName: string;
  brandColor?: string;
  platformConfigured?: boolean;
  supportsByok?: boolean;
};

type HealthModel = {
  providerId: string;
  lifecycle?: string;
};

type HealthCredential = {
  providerId: string;
};

type Status = 'Healthy' | 'Degraded' | 'Unavailable' | 'Unknown';

function normalizeStatus(status: string | undefined): Status {
  if (status === 'Healthy' || status === 'Degraded' || status === 'Unavailable') return status;
  return 'Unknown';
}

function statusRank(status: Status): number {
  if (status === 'Unavailable') return 0;
  if (status === 'Degraded') return 1;
  if (status === 'Unknown') return 2;
  return 3;
}

function statusFill(status: Status): string {
  if (status === 'Healthy') return 'bg-[#00ff00]';
  if (status === 'Degraded') return 'bg-[#ffff00]';
  if (status === 'Unavailable') return 'bg-[#ff00ff]';
  return 'bg-[#00ffff]';
}

function formatRate(value: number | undefined): string {
  const n = Number(value || 0);
  if (n <= 0) return '0%';
  if (n >= 1) return '100%';
  return `${Math.round(n * 100)}%`;
}

function formatCheckedAt(value: string | undefined): string {
  if (!value) return 'Not checked';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 19);
  return date.toLocaleString();
}

function StatusChip({ status }: { status: Status }) {
  return (
    <span className={`inline-flex items-center gap-1.5 border-2 border-black px-2 py-0.5 text-[11px] font-black uppercase ${statusFill(status)}`}>
      <span className="h-2.5 w-2.5 border-2 border-black bg-black" />
      {status}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-4 border-black bg-[#00ffff] p-3 shadow-[4px_4px_0px_0px_#000]">
      <p className="text-[10px] font-black tracking-wider uppercase">{label}</p>
      <p className="mt-1 font-[family-name:var(--font-space-grotesk)] text-xl font-black leading-none sm:text-2xl">{value}</p>
    </div>
  );
}

export function HealthNineties({
  health,
  providers,
  models,
  credentials = [],
  loading,
  error,
  onRefresh,
  onOpenProviders,
}: {
  health: HealthSnapshot[];
  providers: HealthProvider[];
  models: HealthModel[];
  credentials?: HealthCredential[];
  loading: boolean;
  error: string;
  onRefresh: () => Promise<void>;
  onOpenProviders: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    return providers
      .map((provider) => {
        const snapshot = health.find((item) => item.providerId === provider.id);
        const providerModels = models.filter((model) => model.providerId === provider.id);
        return {
          provider,
          snapshot,
          status: normalizeStatus(snapshot?.status),
          models: providerModels.length,
          activeModels: providerModels.filter((model) => model.lifecycle === 'ACTIVE').length,
          keys: credentials.filter((item) => item.providerId === provider.id).length,
        };
      })
      .sort((a, b) => {
        const byStatus = statusRank(a.status) - statusRank(b.status);
        if (byStatus !== 0) return byStatus;
        return (b.snapshot?.latencyMs || 0) - (a.snapshot?.latencyMs || 0);
      });
  }, [credentials, health, models, providers]);

  useEffect(() => {
    if (selectedId && rows.some((row) => row.provider.id === selectedId)) return;
    setSelectedId(rows[0]?.provider.id || null);
  }, [rows, selectedId]);

  const healthy = rows.filter((row) => row.status === 'Healthy').length;
  const degraded = rows.filter((row) => row.status === 'Degraded').length;
  const down = rows.filter((row) => row.status === 'Unavailable').length;
  const unknown = rows.filter((row) => row.status === 'Unknown').length;
  const latencies = rows.map((row) => row.snapshot?.latencyMs).filter((value): value is number => value != null);
  const avgLatency = latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null;
  const maxLatency = latencies.length ? Math.max(...latencies) : 0;
  const selected = rows.find((row) => row.provider.id === selectedId) || null;
  const attention = rows.filter((row) => row.status !== 'Healthy');

  const recheck = async () => {
    setBusy(true);
    try {
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={scrollRef}
      className={`${plusJakarta.variable} ${spaceGrotesk.variable} theme-invert-exempt h-full min-h-0 overflow-y-auto font-[family-name:var(--font-plus-jakarta)]`}
    >
      <div className="relative min-h-full overflow-hidden bg-[#00ffff] px-4 py-6 text-black sm:px-6 sm:py-8 lg:px-8">
        <div className="pointer-events-none absolute inset-0 opacity-20">
          <div className="absolute top-10 left-10 h-32 w-32 rotate-45 border-8 border-[#ff00ff]" />
          <div className="absolute top-40 right-20 h-24 w-24 rounded-full border-8 border-[#00ff00]" />
          <div className="absolute right-16 bottom-24 h-20 w-20 bg-[#ff00ff]" />
        </div>

        <div className="relative z-10 mx-auto flex w-full max-w-[1200px] flex-col gap-5">
          <header className="flex flex-col gap-4 border-8 border-black bg-white p-5 shadow-[12px_12px_0px_0px_#000] sm:flex-row sm:items-end sm:justify-between sm:p-6">
            <div>
              <p className="inline-block border-2 border-black bg-[#ff00ff] px-2 py-1 text-[10px] font-black tracking-wider text-[#ffffff] uppercase">
                BYOK · Routing probes
              </p>
              <h1 className="mt-3 font-[family-name:var(--font-space-grotesk)] text-4xl font-black leading-none tracking-tight sm:text-5xl">
                Provider health
              </h1>
              <p className="mt-3 max-w-xl text-sm font-black leading-relaxed">
                Live adapter checks used by routing. Lime is answering, yellow is noisy, magenta is down. Click a provider to inspect latency, errors, and last failure.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => void recheck()}
                disabled={busy || loading}
                className="border-4 border-black bg-[#00ff00] px-5 py-3 text-sm font-black shadow-[6px_6px_0px_0px_#000] transition-all hover:translate-x-1 hover:translate-y-1 hover:shadow-[4px_4px_0px_0px_#000] disabled:opacity-60"
              >
                {busy || loading ? 'Checking…' : 'Recheck all'}
              </button>
              <button
                type="button"
                onClick={onOpenProviders}
                className="border-4 border-[#00ff00] bg-black px-5 py-3 text-sm font-black text-[#00ff00] shadow-[6px_6px_0px_0px_#00ff00] transition-all hover:translate-x-1 hover:translate-y-1 hover:shadow-[4px_4px_0px_0px_#00ff00]"
              >
                Open providers
              </button>
            </div>
          </header>

          {error ? (
            <div className="border-4 border-black bg-[#ffff00] px-4 py-3 text-sm font-black shadow-[6px_6px_0px_0px_#000]">
              {error}
            </div>
          ) : null}

          {attention.length > 0 && !loading ? (
            <div className="border-4 border-black bg-[#ffff00] px-4 py-3 text-sm font-black shadow-[6px_6px_0px_0px_#000]">
              {attention.length} provider{attention.length === 1 ? '' : 's'} need attention
              {attention.slice(0, 3).map((row) => ` · ${row.provider.displayName} (${row.status})`).join('')}
              {attention.length > 3 ? ` · +${attention.length - 3} more` : ''}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: 'Healthy', value: String(healthy), fill: 'bg-[#00ff00]' },
              { label: 'Degraded', value: String(degraded), fill: 'bg-[#ffff00]' },
              { label: 'Down', value: String(down), fill: 'bg-[#ff00ff] text-[#ffffff]' },
              { label: 'Avg latency', value: avgLatency != null ? `${avgLatency}ms` : '—', fill: 'bg-white' },
            ].map((item) => (
              <div key={item.label} className={`border-8 border-black p-4 shadow-[8px_8px_0px_0px_#000] ${item.fill} ${cardHover}`}>
                <p className="text-[10px] font-black tracking-wider uppercase">{item.label}</p>
                <p className="mt-2 font-[family-name:var(--font-space-grotesk)] text-3xl font-black leading-none sm:text-4xl">{item.value}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
            <section className="border-8 border-black bg-white p-4 shadow-[12px_12px_0px_0px_#000] sm:p-5">
              <div className="mb-4 flex items-center justify-between gap-3 border-b-4 border-black pb-3">
                <h2 className="font-[family-name:var(--font-space-grotesk)] text-xl font-black sm:text-2xl">All providers</h2>
                <span className="border-2 border-black bg-[#00ffff] px-2 py-1 text-[10px] font-black uppercase">
                  {unknown} unknown
                </span>
              </div>
              {loading && rows.length === 0 ? (
                <p className="border-4 border-black bg-[#00ffff] px-4 py-6 text-sm font-black">Pinging every adapter…</p>
              ) : rows.length === 0 ? (
                <p className="border-4 border-black bg-[#ffff00] px-4 py-6 text-sm font-black">No providers in the catalog yet.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {rows.map((row) => {
                    const active = row.provider.id === selected?.provider.id;
                    const latency = row.snapshot?.latencyMs;
                    const bar = maxLatency > 0 && latency != null ? Math.max(8, Math.round((latency / maxLatency) * 100)) : row.status === 'Healthy' ? 24 : 8;
                    return (
                      <li key={row.provider.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(row.provider.id)}
                          className={`flex w-full flex-col gap-2 border-4 border-black p-3 text-left shadow-[6px_6px_0px_0px_#000] sm:flex-row sm:items-center ${
                            active ? 'bg-[#ffff00]' : 'bg-[#00ffff]'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-black">{row.provider.displayName}</span>
                              <StatusChip status={row.status} />
                            </div>
                            <p className="mt-1 text-[11px] font-black text-black/70">
                              {latency != null ? `${latency}ms` : 'No ping'}
                              {row.snapshot?.detail ? ` · ${row.snapshot.detail}` : ''}
                            </p>
                          </div>
                          <div className="w-full sm:w-36">
                            <div className="h-3 overflow-hidden border-2 border-black bg-black">
                              <div
                                className={`h-full ${row.status === 'Unavailable' ? 'bg-[#ff00ff]' : row.status === 'Degraded' ? 'bg-[#ffff00]' : 'bg-[#00ff00]'}`}
                                style={{ width: `${bar}%` }}
                              />
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <aside className="border-8 border-black bg-white p-4 shadow-[12px_12px_0px_0px_#000] sm:p-5">
              {selected ? (
                <div>
                  <p className="inline-block border-2 border-black bg-[#ff00ff] px-2 py-1 text-[10px] font-black tracking-wider text-[#ffffff] uppercase">
                    Probe detail
                  </p>
                  <div className="mt-3 flex flex-wrap items-start justify-between gap-2">
                    <h2 className="font-[family-name:var(--font-space-grotesk)] text-3xl font-black leading-none">
                      {selected.provider.displayName}
                    </h2>
                    <StatusChip status={selected.status} />
                  </div>
                  <p className="mt-3 border-4 border-black bg-[#00ffff] p-3 text-sm font-black">
                    {selected.snapshot?.detail
                      || (selected.status === 'Unknown'
                        ? (selected.provider.platformConfigured ? 'No recent probe yet. Recheck to ping this adapter.' : 'No platform credential configured. Add a BYOK key or platform secret.')
                        : 'Last probe succeeded. Routing can use this provider.')}
                  </p>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <Metric label="Latency" value={selected.snapshot?.latencyMs != null ? `${selected.snapshot.latencyMs}ms` : '—'} />
                    <Metric label="Error rate" value={formatRate(selected.snapshot?.errorRate)} />
                    <Metric label="429 rate" value={formatRate(selected.snapshot?.rateLimitRate)} />
                    <Metric label="Timeouts" value={formatRate(selected.snapshot?.timeoutRate)} />
                    <Metric label="Models" value={`${selected.activeModels || selected.models}/${selected.models || 0}`} />
                    <Metric label="BYOK keys" value={String(selected.keys)} />
                  </div>
                  <dl className="mt-4 space-y-2 border-t-4 border-black pt-4 text-sm font-black">
                    <div className="flex justify-between gap-3">
                      <dt>Platform access</dt>
                      <dd>{selected.provider.platformConfigured ? 'Configured' : 'Missing'}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt>BYOK</dt>
                      <dd>{selected.provider.supportsByok ? (selected.keys ? `${selected.keys} key${selected.keys === 1 ? '' : 's'}` : 'Supported') : 'n/a'}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt>Availability</dt>
                      <dd>{selected.snapshot?.availability != null ? formatRate(selected.snapshot.availability) : '—'}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt>Last check</dt>
                      <dd className="text-right">{formatCheckedAt(selected.snapshot?.checkedAt)}</dd>
                    </div>
                  </dl>
                </div>
              ) : (
                <p className="text-sm font-black">Select a provider to inspect the last probe.</p>
              )}
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
