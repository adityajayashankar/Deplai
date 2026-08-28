'use client';

import { useEffect, useMemo, useState } from 'react';
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
  formatTokens,
  ninetiesGhostBtn,
  ninetiesInkBtn,
  providerLabel,
} from './nineties';

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
};

function sourceLabel(value: string): string {
  if (value === 'byok') return 'BYOK';
  if (value === 'platform') return 'Platform';
  if (value === 'enterprise') return 'Enterprise';
  if (value === 'self_hosted') return 'Self-hosted';
  return value || 'Unknown';
}

export function UsageNineties({
  providers,
  onOpenCosts,
  onOpenPlayground,
}: {
  providers: Array<{ id: string; displayName: string }>;
  onOpenCosts: () => void;
  onOpenPlayground: () => void;
}) {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = async () => {
    setError('');
    setLoading(true);
    try {
      const payload = await aiFetch<UsageSummary>('usage');
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load usage');
      setData({});
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const usage = data?.usage;
  const byProvider = data?.byProvider || [];
  const maxTokens = Math.max(1, ...byProvider.map((row) => Number(row.tokens || 0)));
  const selected = byProvider.find((row) => row.provider_id === selectedId) || byProvider[0] || null;
  const modelsForSelected = useMemo(
    () => (data?.byModel || []).filter((row) => row.provider_id === selected?.provider_id),
    [data?.byModel, selected?.provider_id],
  );

  useEffect(() => {
    if (selectedId && byProvider.some((row) => row.provider_id === selectedId)) return;
    setSelectedId(byProvider[0]?.provider_id || null);
  }, [byProvider, selectedId]);

  const empty = !loading && !Number(usage?.requests || 0);

  return (
    <NinetiesFrame>
      <NinetiesHeader
        kicker="BYOK · Last 30 days"
        title="Usage"
        blurb="Metered requests from playground, security, deploy, and customization. Tokens are counted the way the provider reported them, or marked estimated when that payload was missing."
        actions={
          <>
            <button type="button" className={ninetiesInkBtn} onClick={() => void load()} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
            <button type="button" className={ninetiesGhostBtn} onClick={onOpenCosts}>Open costs</button>
          </>
        }
      />

      {error ? <NinetiesBanner>{error}</NinetiesBanner> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <NinetiesStat label="Requests" value={loading ? '…' : String(usage?.requests || 0)} tone="lime" />
        <NinetiesStat label="Input tokens" value={loading ? '…' : formatTokens(usage?.input_tokens)} tone="white" />
        <NinetiesStat label="Output tokens" value={loading ? '…' : formatTokens(usage?.output_tokens)} tone="yellow" />
        <NinetiesStat label="Cached / reasoning" value={loading ? '…' : `${formatTokens(usage?.cached_tokens)} / ${formatTokens(usage?.reasoning_tokens)}`} tone="cyan" />
      </div>

      {empty ? (
        <NinetiesPanel title="No metered traffic yet" badge="30d">
          <p className="text-sm font-black leading-relaxed">
            Run the playground or any agent job that goes through the AI gateway. Usage lands here after the request finishes — secrets are never stored with the meter.
          </p>
          <button type="button" className={`${ninetiesInkBtn} mt-4`} onClick={onOpenPlayground}>
            Open playground
          </button>
        </NinetiesPanel>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            {(data?.byCredentialSource || []).length ? (data?.byCredentialSource || []).map((row) => (
              <NinetiesStat
                key={row.credential_source}
                label={sourceLabel(row.credential_source)}
                value={`${row.requests} req · ${formatTokens(row.tokens)}`}
                tone={row.credential_source === 'byok' ? 'lime' : row.credential_source === 'platform' ? 'yellow' : 'white'}
              />
            )) : (
              <NinetiesStat label="Credential source" value={loading ? '…' : 'None yet'} tone="white" />
            )}
            <NinetiesStat label="Tool calls" value={loading ? '…' : String(usage?.tool_calls || 0)} tone="magenta" />
          </div>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
            <NinetiesPanel title="By provider" badge={`${byProvider.length} adapters`}>
              {byProvider.length === 0 ? (
                <p className="border-4 border-black bg-[#00ffff] px-4 py-6 text-sm font-black">No provider breakdown yet.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {byProvider.map((row) => (
                    <li key={row.provider_id}>
                      <NinetiesRow active={row.provider_id === selected?.provider_id} onClick={() => setSelectedId(row.provider_id)}>
                        <div className="min-w-0 flex-1">
                          <p className="font-black">{providerLabel(row.provider_id, providers)}</p>
                          <p className="mt-1 text-[11px] font-black text-black/70">
                            {row.requests} requests · {formatTokens(row.tokens)} tokens
                          </p>
                        </div>
                        <NinetiesBar percent={(Number(row.tokens || 0) / maxTokens) * 100} />
                      </NinetiesRow>
                    </li>
                  ))}
                </ul>
              )}
            </NinetiesPanel>

            <NinetiesPanel title="Selected adapter" badge={selected ? 'Adapter' : 'Pick a row'}>
              {selected ? (
                <div>
                  <h3 className="font-[family-name:var(--font-space-grotesk)] text-3xl font-black leading-none">
                    {providerLabel(selected.provider_id, providers)}
                  </h3>
                  <p className="mt-3 border-4 border-black bg-[#00ffff] p-3 text-sm font-black">
                    Share of 30-day tokens: {Math.round((Number(selected.tokens || 0) / Math.max(1, Number(usage?.input_tokens || 0) + Number(usage?.output_tokens || 0))) * 100)}%.
                    Click another row to compare adapters.
                  </p>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <NinetiesMetric label="Requests" value={String(selected.requests)} />
                    <NinetiesMetric label="Tokens" value={formatTokens(selected.tokens)} />
                    <NinetiesMetric label="Input" value={formatTokens(selected.input_tokens)} />
                    <NinetiesMetric label="Output" value={formatTokens(selected.output_tokens)} />
                  </div>
                  <div className="mt-4 border-t-4 border-black pt-4">
                    <p className="mb-2 text-[10px] font-black tracking-wider uppercase">Top models</p>
                    {modelsForSelected.length === 0 ? (
                      <p className="text-sm font-black">No model split for this adapter.</p>
                    ) : (
                      <ul className="space-y-2">
                        {modelsForSelected.map((row) => (
                          <li key={`${row.provider_id}:${row.model_id}`} className="flex justify-between gap-3 text-sm font-black">
                            <span className="truncate">{row.model_id}</span>
                            <span className="shrink-0">{row.requests} · {formatTokens(row.tokens)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-sm font-black">Select a provider to see its token mix.</p>
              )}
            </NinetiesPanel>
          </div>
        </>
      )}
    </NinetiesFrame>
  );
}
