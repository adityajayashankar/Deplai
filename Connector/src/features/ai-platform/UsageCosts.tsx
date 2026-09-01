'use client';

import { useEffect, useMemo, useState } from 'react';
import { EmptyState, Panel, aiFetch, btnGhost } from './ui';
import { formatTokens, formatUsd, providerLabel } from './nineties';

type UsageSummary = {
  usage?: {
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    reasoning_tokens: number;
    tool_calls?: number;
  };
  byProvider?: Array<{ provider_id: string; requests: number; tokens: number; input_tokens?: number; output_tokens?: number }>;
  byCredentialSource?: Array<{ credential_source: string; requests: number; tokens: number }>;
  byModel?: Array<{ provider_id: string; model_id: string; requests: number; tokens: number }>;
  byMember?: Array<{ user_id: string; requests: number; tokens: number }>;
  byProject?: Array<{ project_id: string | null; requests: number; tokens: number }>;
};

type CostRow = {
  provider_id: string;
  requests: number;
  provider_cost_usd: number;
  platform_cost_usd: number;
  customer_charge_usd: number;
};

type BillingRow = {
  billing_source: string;
  requests: number;
  provider_cost_usd: number;
  platform_cost_usd: number;
  customer_charge_usd: number;
};

type CostsSummary = {
  provider_cost_usd?: number;
  platform_cost_usd?: number;
  customer_charge_usd?: number;
  byBillingSource?: BillingRow[];
  byProvider?: CostRow[];
  estimatedVsActual?: Array<{ estimated: number; requests: number; customer_charge_usd: number }>;
};

function sourceLabel(value: string): string {
  if (value === 'byok') return 'BYOK';
  if (value === 'platform') return 'Platform';
  if (value === 'enterprise') return 'Enterprise';
  return value || 'Unknown';
}

export function UsageCosts({ providers }: { providers: Array<{ id: string; displayName: string }> }) {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [costs, setCosts] = useState<CostsSummary | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setError('');
    setLoading(true);
    try {
      const [usagePayload, costsPayload] = await Promise.all([
        aiFetch<UsageSummary>('usage').catch(() => ({})),
        aiFetch<CostsSummary>('costs').catch(() => ({})),
      ]);
      setUsage(usagePayload);
      setCosts(costsPayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load usage and cost');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const meter = usage?.usage;
  const byProvider = usage?.byProvider || [];
  const costByProvider = costs?.byProvider || [];
  const byBilling = costs?.byBillingSource || [];
  const platform = byBilling.find((row) => row.billing_source === 'platform');
  const byok = byBilling.find((row) => row.billing_source === 'byok');
  const empty = !loading && !Number(meter?.requests || 0);

  const merged = useMemo(() => {
    const ids = new Set([
      ...byProvider.map((row) => row.provider_id),
      ...costByProvider.map((row) => row.provider_id),
    ]);
    return [...ids].map((id) => ({
      id,
      usage: byProvider.find((row) => row.provider_id === id),
      cost: costByProvider.find((row) => row.provider_id === id),
    }));
  }, [byProvider, costByProvider]);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-semibold text-black">Usage & cost</h2>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-zinc-500">
            Last 30 days of gateway traffic from security, deploy, and customization. BYOK keeps the vendor invoice on your account; this page still shows the DeplAI fee.
          </p>
        </div>
        <button type="button" className={btnGhost} onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error ? <p className="mt-4 border-[3px] border-black bg-amber-200 px-4 py-3 text-[13px] font-medium text-black">{error}</p> : null}

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Requests" value={loading ? '…' : String(meter?.requests || 0)} />
        <Stat label="Tokens" value={loading ? '…' : `${formatTokens(meter?.input_tokens)} in / ${formatTokens(meter?.output_tokens)} out`} />
        <Stat label="Charged" value={loading ? '…' : formatUsd(costs?.customer_charge_usd)} />
        <Stat label="Platform fee" value={loading ? '…' : formatUsd(costs?.platform_cost_usd)} />
      </div>

      {empty ? (
        <div className="mt-6">
          <EmptyState
            title="No metered traffic yet"
            body="Run a security scan, deploy conversation, or customization job. Usage and cost land here after the request finishes — secrets are never stored with the meter."
          />
        </div>
      ) : (
        <>
          <div className="mt-6 grid gap-3 md:grid-cols-3">
            {(usage?.byCredentialSource || []).map((row) => (
              <Stat
                key={row.credential_source}
                label={sourceLabel(row.credential_source)}
                value={`${row.requests} req · ${formatTokens(row.tokens)}`}
              />
            ))}
            <Stat label="Tool calls" value={loading ? '…' : String(meter?.tool_calls || 0)} />
          </div>

          <div className="mt-6 grid gap-3 md:grid-cols-2">
            <Panel className="p-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">Platform-managed</p>
              <p className="mt-3 text-[13px] text-zinc-600">DeplAI pays the vendor, then charges this workspace provider cost plus margin.</p>
              <dl className="mt-4 grid grid-cols-3 gap-3 text-[13px]">
                <div><dt className="font-mono text-[10px] uppercase text-zinc-500">Vendor</dt><dd className="mt-1 text-black">{formatUsd(platform?.provider_cost_usd)}</dd></div>
                <div><dt className="font-mono text-[10px] uppercase text-zinc-500">Fee</dt><dd className="mt-1 text-black">{formatUsd(platform?.platform_cost_usd)}</dd></div>
                <div><dt className="font-mono text-[10px] uppercase text-zinc-500">Charged</dt><dd className="mt-1 text-black">{formatUsd(platform?.customer_charge_usd)}</dd></div>
              </dl>
            </Panel>
            <Panel className="p-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">BYOK</p>
              <p className="mt-3 text-[13px] text-zinc-600">The vendor bills your key. This column is only the platform fee on that traffic.</p>
              <dl className="mt-4 grid grid-cols-3 gap-3 text-[13px]">
                <div><dt className="font-mono text-[10px] uppercase text-zinc-500">On us</dt><dd className="mt-1 text-black">{formatUsd(byok?.provider_cost_usd)}</dd></div>
                <div><dt className="font-mono text-[10px] uppercase text-zinc-500">Fee</dt><dd className="mt-1 text-black">{formatUsd(byok?.platform_cost_usd)}</dd></div>
                <div><dt className="font-mono text-[10px] uppercase text-zinc-500">Charged</dt><dd className="mt-1 text-black">{formatUsd(byok?.customer_charge_usd)}</dd></div>
              </dl>
            </Panel>
          </div>

          <h3 className="mt-10 font-display text-lg text-black">By provider</h3>
          <div className="mt-4 space-y-3">
            {merged.length === 0 ? (
              <p className="text-[13px] text-zinc-500">No provider split in the last 30 days.</p>
            ) : merged.map((row) => (
              <Panel key={row.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <p className="text-sm font-semibold text-black">{providerLabel(row.id, providers)}</p>
                  <p className="font-mono text-[11px] text-zinc-500">
                    {row.usage?.requests || row.cost?.requests || 0} requests · {formatTokens(row.usage?.tokens)} · charged {formatUsd(row.cost?.customer_charge_usd)}
                  </p>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
                  <div><dt className="font-mono text-[10px] uppercase text-zinc-500">Input</dt><dd className="mt-1">{formatTokens(row.usage?.input_tokens)}</dd></div>
                  <div><dt className="font-mono text-[10px] uppercase text-zinc-500">Output</dt><dd className="mt-1">{formatTokens(row.usage?.output_tokens)}</dd></div>
                  <div><dt className="font-mono text-[10px] uppercase text-zinc-500">Vendor cost</dt><dd className="mt-1">{formatUsd(row.cost?.provider_cost_usd)}</dd></div>
                  <div><dt className="font-mono text-[10px] uppercase text-zinc-500">Fee</dt><dd className="mt-1">{formatUsd(row.cost?.platform_cost_usd)}</dd></div>
                </dl>
              </Panel>
            ))}
          </div>

          {(usage?.byModel?.length || 0) > 0 ? (
            <>
              <h3 className="mt-10 font-display text-lg text-black">By model</h3>
              <div className="mt-4 space-y-2">
                {(usage?.byModel || []).slice(0, 12).map((row) => (
                  <Panel key={`${row.provider_id}:${row.model_id}`} className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <p className="text-[13px] font-semibold text-black">{row.model_id}</p>
                    <p className="font-mono text-[11px] text-zinc-500">
                      {providerLabel(row.provider_id, providers)} · {row.requests} req · {formatTokens(row.tokens)}
                    </p>
                  </Panel>
                ))}
              </div>
            </>
          ) : null}

          {(usage?.byMember?.length || 0) > 0 ? (
            <>
              <h3 className="mt-10 font-display text-lg text-black">By member</h3>
              <div className="mt-4 space-y-2">
                {(usage?.byMember || []).slice(0, 12).map((row) => (
                  <Panel key={row.user_id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <p className="font-mono text-[12px] text-black">{row.user_id.slice(0, 8)}…</p>
                    <p className="font-mono text-[11px] text-zinc-500">{row.requests} req · {formatTokens(row.tokens)}</p>
                  </Panel>
                ))}
              </div>
            </>
          ) : null}

          {(usage?.byProject?.length || 0) > 0 ? (
            <>
              <h3 className="mt-10 font-display text-lg text-black">By project</h3>
              <div className="mt-4 space-y-2">
                {(usage?.byProject || []).slice(0, 12).map((row) => (
                  <Panel key={row.project_id || 'none'} className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <p className="text-[13px] font-semibold text-black">{row.project_id || 'Unscoped'}</p>
                    <p className="font-mono text-[11px] text-zinc-500">{row.requests} req · {formatTokens(row.tokens)}</p>
                  </Panel>
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Panel className="p-5">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">{label}</p>
      <p className="mt-2 font-display text-xl text-black">{value}</p>
    </Panel>
  );
}
