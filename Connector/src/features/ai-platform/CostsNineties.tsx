'use client';

import { useEffect, useState } from 'react';
import { aiFetch } from './ui';
import {
  NinetiesBanner,
  NinetiesBar,
  NinetiesFrame,
  NinetiesHeader,
  NinetiesMetric,
  NinetiesPanel,
  NinetiesRow,
  NinetiesStat,
  formatUsd,
  ninetiesGhostBtn,
  ninetiesInkBtn,
  providerLabel,
} from './nineties';

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
  if (value === 'byok') return 'BYOK pass-through';
  if (value === 'platform') return 'Platform-managed';
  return value || 'Unknown';
}

export function CostsNineties({
  providers,
  onOpenUsage,
}: {
  providers: Array<{ id: string; displayName: string }>;
  onOpenUsage: () => void;
}) {
  const [data, setData] = useState<CostsSummary | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = async () => {
    setError('');
    setLoading(true);
    try {
      setData(await aiFetch<CostsSummary>('costs'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load costs');
      setData({});
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const byProvider = data?.byProvider || [];
  const byBilling = data?.byBillingSource || [];
  const maxCharge = Math.max(1, ...byProvider.map((row) => Number(row.customer_charge_usd || 0)));
  const selected = byProvider.find((row) => row.provider_id === selectedId) || byProvider[0] || null;
  const estimated = (data?.estimatedVsActual || []).find((row) => Number(row.estimated) === 1);
  const actual = (data?.estimatedVsActual || []).find((row) => Number(row.estimated) === 0);
  const platform = byBilling.find((row) => row.billing_source === 'platform');
  const byok = byBilling.find((row) => row.billing_source === 'byok');

  useEffect(() => {
    if (selectedId && byProvider.some((row) => row.provider_id === selectedId)) return;
    setSelectedId(byProvider[0]?.provider_id || null);
  }, [byProvider, selectedId]);

  return (
    <NinetiesFrame>
      <NinetiesHeader
        kicker="BYOK · Last 30 days"
        title="Costs"
        blurb="Provider spend, platform fee, and what the workspace is charged are kept on separate books. BYOK never books the vendor invoice here — only the DeplAI fee."
        actions={
          <>
            <button type="button" className={ninetiesInkBtn} onClick={() => void load()} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
            <button type="button" className={ninetiesGhostBtn} onClick={onOpenUsage}>Open usage</button>
          </>
        }
      />

      {error ? <NinetiesBanner>{error}</NinetiesBanner> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <NinetiesStat label="Provider cost" value={loading ? '…' : formatUsd(data?.provider_cost_usd)} tone="white" />
        <NinetiesStat label="Platform fee" value={loading ? '…' : formatUsd(data?.platform_cost_usd)} tone="yellow" />
        <NinetiesStat label="Customer charge" value={loading ? '…' : formatUsd(data?.customer_charge_usd)} tone="lime" />
        <NinetiesStat
          label="Estimated share"
          value={loading ? '…' : formatUsd(estimated?.customer_charge_usd)}
          tone="cyan"
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <NinetiesPanel title="Platform-managed" badge={`${platform?.requests || 0} req`}>
          <p className="text-sm font-black leading-relaxed">
            DeplAI pays the vendor, then charges this workspace provider cost plus margin.
          </p>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <NinetiesMetric label="Vendor" value={formatUsd(platform?.provider_cost_usd)} />
            <NinetiesMetric label="Fee" value={formatUsd(platform?.platform_cost_usd)} />
            <NinetiesMetric label="Charged" value={formatUsd(platform?.customer_charge_usd)} />
          </div>
        </NinetiesPanel>
        <NinetiesPanel title="BYOK" badge={`${byok?.requests || 0} req`}>
          <p className="text-sm font-black leading-relaxed">
            The vendor bills the customer key. This column is only the platform fee on that traffic.
          </p>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <NinetiesMetric label="Vendor on us" value={formatUsd(byok?.provider_cost_usd)} />
            <NinetiesMetric label="Fee" value={formatUsd(byok?.platform_cost_usd)} />
            <NinetiesMetric label="Charged" value={formatUsd(byok?.customer_charge_usd)} />
          </div>
        </NinetiesPanel>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <NinetiesPanel title="By provider" badge="customer charge">
          {loading && byProvider.length === 0 ? (
            <p className="border-4 border-black bg-[#00ffff] px-4 py-6 text-sm font-black">Loading ledger…</p>
          ) : byProvider.length === 0 ? (
            <p className="border-4 border-black bg-[#ffff00] px-4 py-6 text-sm font-black">
              No cost rows in the last 30 days. Metered calls write provider cost, platform fee, and customer charge separately.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {byProvider.map((row) => (
                <li key={row.provider_id}>
                  <NinetiesRow active={row.provider_id === selected?.provider_id} onClick={() => setSelectedId(row.provider_id)}>
                    <div className="min-w-0 flex-1">
                      <p className="font-black">{providerLabel(row.provider_id, providers)}</p>
                      <p className="mt-1 text-[11px] font-black text-black/70">
                        {row.requests} requests · charged {formatUsd(row.customer_charge_usd)}
                      </p>
                    </div>
                    <NinetiesBar
                      percent={(Number(row.customer_charge_usd || 0) / maxCharge) * 100}
                      tone={Number(row.provider_cost_usd || 0) === 0 ? 'yellow' : 'lime'}
                    />
                  </NinetiesRow>
                </li>
              ))}
            </ul>
          )}
        </NinetiesPanel>

        <NinetiesPanel title="Ledger detail" badge={selected ? providerLabel(selected.provider_id, providers) : 'Pick a row'}>
          {selected ? (
            <div>
              <h3 className="font-[family-name:var(--font-space-grotesk)] text-3xl font-black leading-none">
                {providerLabel(selected.provider_id, providers)}
              </h3>
              <p className="mt-3 border-4 border-black bg-[#00ffff] p-3 text-sm font-black">
                {Number(selected.provider_cost_usd || 0) === 0
                  ? 'Vendor cost is $0 on our books — typical for BYOK, where the customer account pays the model vendor.'
                  : 'Vendor cost is what DeplAI paid this adapter. Customer charge is that amount plus platform fee.'}
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <NinetiesMetric label="Requests" value={String(selected.requests)} />
                <NinetiesMetric label="Provider cost" value={formatUsd(selected.provider_cost_usd)} />
                <NinetiesMetric label="Platform fee" value={formatUsd(selected.platform_cost_usd)} />
                <NinetiesMetric label="Customer charge" value={formatUsd(selected.customer_charge_usd)} />
              </div>
              <dl className="mt-4 space-y-2 border-t-4 border-black pt-4 text-sm font-black">
                <div className="flex justify-between gap-3">
                  <dt>Estimated rows</dt>
                  <dd>{estimated?.requests || 0} · {formatUsd(estimated?.customer_charge_usd)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>Actual rows</dt>
                  <dd>{actual?.requests || 0} · {formatUsd(actual?.customer_charge_usd)}</dd>
                </div>
              </dl>
            </div>
          ) : (
            <p className="text-sm font-black">Select a provider to split vendor cost, fee, and charge.</p>
          )}
        </NinetiesPanel>
      </div>
    </NinetiesFrame>
  );
}
