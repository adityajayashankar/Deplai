'use client';

import { useEffect, useMemo, useState } from 'react';
import { aiFetch } from './ui';
import {
  NinetiesBanner,
  NinetiesField,
  NinetiesFrame,
  NinetiesHeader,
  NinetiesPanel,
  NinetiesRow,
  NinetiesStat,
  NinetiesToggle,
  ninetiesGhostBtn,
  ninetiesInkBtn,
  ninetiesInput,
  providerLabel,
} from './nineties';

type WorkspacePolicy = {
  byokRequired: boolean;
  platformCredentialsAllowed: boolean;
  fallbackAllowed: boolean;
  crossProviderFallbackAllowed: boolean;
  promptLogging: boolean;
  responseLogging: boolean;
  maxTokenLimit: number | null;
  maxMonthlySpendUsd: number | null;
  maxRequestCostUsd: number | null;
  allowedProviders: string[] | null;
};

type GateId =
  | 'byokRequired'
  | 'platformCredentialsAllowed'
  | 'fallbackAllowed'
  | 'crossProviderFallbackAllowed'
  | 'promptLogging'
  | 'responseLogging'
  | 'caps'
  | 'providers';

const GATES: Array<{ id: GateId; title: string; blurb: string }> = [
  { id: 'byokRequired', title: 'BYOK required', blurb: 'Every call must use a customer key. Platform credentials are ignored even if they exist.' },
  { id: 'platformCredentialsAllowed', title: 'Platform credentials', blurb: 'Allow DeplAI-managed keys when a customer key is missing or Auto mode is on.' },
  { id: 'fallbackAllowed', title: 'Fallback allowed', blurb: 'If the chosen model fails, the gateway may try another eligible model instead of erroring immediately.' },
  { id: 'crossProviderFallbackAllowed', title: 'Cross-provider fallback', blurb: 'A fallback may land on a different vendor. Turn this off to keep retries inside the same provider.' },
  { id: 'promptLogging', title: 'Prompt logging', blurb: 'Store prompt text on request logs. Off by default. Never use this for secrets.' },
  { id: 'responseLogging', title: 'Response logging', blurb: 'Store model output on request logs. Off by default. Redaction still applies to credentials.' },
  { id: 'caps', title: 'Spend and token caps', blurb: 'Hard stops for a single request, monthly spend, and max tokens. Empty means no cap.' },
  { id: 'providers', title: 'Allowed providers', blurb: 'If none are selected, every adapter in the catalog may run. A selection becomes an allowlist.' },
];

function asNumberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function PoliciesNineties({
  providers,
  onOpenRouting,
}: {
  providers: Array<{ id: string; displayName: string }>;
  onOpenRouting: () => void;
}) {
  const [policy, setPolicy] = useState<WorkspacePolicy>({
    byokRequired: false,
    platformCredentialsAllowed: true,
    fallbackAllowed: true,
    crossProviderFallbackAllowed: true,
    promptLogging: false,
    responseLogging: false,
    maxTokenLimit: null,
    maxMonthlySpendUsd: null,
    maxRequestCostUsd: null,
    allowedProviders: null,
  });
  const [selectedId, setSelectedId] = useState<GateId>('byokRequired');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    setError('');
    setLoading(true);
    try {
      const payload = await aiFetch<{ policy: WorkspacePolicy }>('policies');
      setPolicy((current) => ({ ...current, ...payload.policy }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load workspace policy');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const selected = GATES.find((item) => item.id === selectedId) || GATES[0];
  const allowlist = policy.allowedProviders;
  const allProviderIds = providers.map((item) => item.id);

  const posture = useMemo(() => {
    const bits = [
      policy.byokRequired ? 'BYOK is required' : 'BYOK is optional',
      policy.fallbackAllowed ? (policy.crossProviderFallbackAllowed ? 'fallback may change vendors' : 'fallback stays on the same vendor') : 'fallback is off',
      policy.platformCredentialsAllowed ? 'platform keys are allowed' : 'platform keys are blocked',
    ];
    return `Right now: ${bits.join('. ')}.`;
  }, [policy.byokRequired, policy.crossProviderFallbackAllowed, policy.fallbackAllowed, policy.platformCredentialsAllowed]);

  const gateOn = (id: GateId): boolean | null => {
    if (id === 'caps') return policy.maxRequestCostUsd != null || policy.maxMonthlySpendUsd != null || policy.maxTokenLimit != null;
    if (id === 'providers') return Boolean(allowlist?.length);
    return Boolean(policy[id as keyof WorkspacePolicy]);
  };

  const save = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await aiFetch('policies', {
        method: 'PUT',
        body: JSON.stringify({
          byokRequired: policy.byokRequired,
          platformCredentialsAllowed: policy.platformCredentialsAllowed,
          fallbackAllowed: policy.fallbackAllowed,
          crossProviderFallbackAllowed: policy.crossProviderFallbackAllowed,
          promptLogging: policy.promptLogging,
          responseLogging: policy.responseLogging,
          maxTokenLimit: policy.maxTokenLimit,
          maxMonthlySpendUsd: policy.maxMonthlySpendUsd,
          maxRequestCostUsd: policy.maxRequestCostUsd,
          allowedProviders: policy.allowedProviders?.length ? policy.allowedProviders : null,
        }),
      });
      setNotice('Workspace policy saved. Routing policies still apply underneath these gates.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save workspace policy');
    } finally {
      setBusy(false);
    }
  };

  const toggleProvider = (id: string) => {
    setPolicy((current) => {
      const next = new Set(current.allowedProviders || allProviderIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...current, allowedProviders: next.size ? [...next] : null };
    });
  };

  return (
    <NinetiesFrame>
      <NinetiesHeader
        kicker="BYOK · Workspace gates"
        title="Policies"
        blurb="These rules apply to every AI call in the workspace. Routing picks a model; this page can still refuse the credential source, the fallback jump, or the vendor."
        actions={
          <>
            <button type="button" className={ninetiesInkBtn} disabled={busy || loading} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save policy'}
            </button>
            <button type="button" className={ninetiesGhostBtn} onClick={onOpenRouting}>Open routing</button>
          </>
        }
      />

      {error ? <NinetiesBanner>{error}</NinetiesBanner> : null}
      {notice ? <NinetiesBanner>{notice}</NinetiesBanner> : null}
      <NinetiesBanner>{loading ? 'Loading workspace policy…' : posture}</NinetiesBanner>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <NinetiesStat label="BYOK" value={policy.byokRequired ? 'Required' : 'Optional'} tone={policy.byokRequired ? 'yellow' : 'lime'} />
        <NinetiesStat label="Fallback" value={policy.fallbackAllowed ? 'On' : 'Off'} tone={policy.fallbackAllowed ? 'lime' : 'magenta'} />
        <NinetiesStat label="Cross-vendor" value={policy.crossProviderFallbackAllowed ? 'Allowed' : 'Blocked'} tone={policy.crossProviderFallbackAllowed ? 'yellow' : 'white'} />
        <NinetiesStat label="Logging" value={policy.promptLogging || policy.responseLogging ? 'On' : 'Off'} tone={policy.promptLogging || policy.responseLogging ? 'magenta' : 'cyan'} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <NinetiesPanel title="Gates" badge="click a row">
          <ul className="flex flex-col gap-3">
            {GATES.map((gate) => {
              const on = gateOn(gate.id);
              return (
                <li key={gate.id}>
                  <NinetiesRow active={gate.id === selectedId} onClick={() => setSelectedId(gate.id)}>
                    <div className="min-w-0 flex-1">
                      <p className="font-black">{gate.title}</p>
                      <p className="mt-1 text-[11px] font-black text-black/70">{gate.blurb}</p>
                    </div>
                    <span className={`shrink-0 border-2 border-black px-2 py-0.5 text-[11px] font-black uppercase ${
                      on ? 'bg-[#00ff00]' : 'bg-white'
                    }`}>
                      {on ? 'On' : 'Off'}
                    </span>
                  </NinetiesRow>
                </li>
              );
            })}
          </ul>
        </NinetiesPanel>

        <NinetiesPanel title={selected.title} badge={gateOn(selected.id) ? 'On' : 'Off'}>
          <p className="border-4 border-black bg-[#00ffff] p-3 text-sm font-black leading-relaxed">{selected.blurb}</p>
          <div className="mt-4 space-y-4">
            {selected.id === 'byokRequired' ? (
              <NinetiesToggle on={policy.byokRequired} onClick={() => setPolicy((current) => ({ ...current, byokRequired: !current.byokRequired }))} label="Require customer keys" />
            ) : null}
            {selected.id === 'platformCredentialsAllowed' ? (
              <NinetiesToggle on={policy.platformCredentialsAllowed} onClick={() => setPolicy((current) => ({ ...current, platformCredentialsAllowed: !current.platformCredentialsAllowed }))} label="Allow platform keys" />
            ) : null}
            {selected.id === 'fallbackAllowed' ? (
              <NinetiesToggle on={policy.fallbackAllowed} onClick={() => setPolicy((current) => ({ ...current, fallbackAllowed: !current.fallbackAllowed }))} label="Allow fallback" />
            ) : null}
            {selected.id === 'crossProviderFallbackAllowed' ? (
              <NinetiesToggle
                on={policy.crossProviderFallbackAllowed}
                onClick={() => setPolicy((current) => ({ ...current, crossProviderFallbackAllowed: !current.crossProviderFallbackAllowed }))}
                label="Allow other vendors"
              />
            ) : null}
            {selected.id === 'promptLogging' ? (
              <NinetiesToggle on={policy.promptLogging} onClick={() => setPolicy((current) => ({ ...current, promptLogging: !current.promptLogging }))} label="Log prompts" />
            ) : null}
            {selected.id === 'responseLogging' ? (
              <NinetiesToggle on={policy.responseLogging} onClick={() => setPolicy((current) => ({ ...current, responseLogging: !current.responseLogging }))} label="Log outputs" />
            ) : null}
            {selected.id === 'caps' ? (
              <div className="grid gap-3">
                <NinetiesField label="Max request cost (USD)">
                  <input
                    value={policy.maxRequestCostUsd ?? ''}
                    onChange={(event) => setPolicy((current) => ({ ...current, maxRequestCostUsd: asNumberOrNull(event.target.value) }))}
                    placeholder="No cap"
                    className={ninetiesInput}
                  />
                </NinetiesField>
                <NinetiesField label="Max monthly spend (USD)">
                  <input
                    value={policy.maxMonthlySpendUsd ?? ''}
                    onChange={(event) => setPolicy((current) => ({ ...current, maxMonthlySpendUsd: asNumberOrNull(event.target.value) }))}
                    placeholder="No cap"
                    className={ninetiesInput}
                  />
                </NinetiesField>
                <NinetiesField label="Max tokens">
                  <input
                    value={policy.maxTokenLimit ?? ''}
                    onChange={(event) => setPolicy((current) => ({ ...current, maxTokenLimit: asNumberOrNull(event.target.value) }))}
                    placeholder="No cap"
                    className={ninetiesInput}
                  />
                </NinetiesField>
              </div>
            ) : null}
            {selected.id === 'providers' ? (
              <div>
                <div className="mb-3 flex gap-2">
                  <button type="button" className={ninetiesInkBtn} onClick={() => setPolicy((current) => ({ ...current, allowedProviders: null }))}>
                    Allow all
                  </button>
                  <button type="button" className={ninetiesGhostBtn} onClick={() => setPolicy((current) => ({ ...current, allowedProviders: allProviderIds }))}>
                    Select all
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {allProviderIds.map((id) => {
                    const explicit = Boolean(allowlist?.includes(id));
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => toggleProvider(id)}
                        className={`border-4 border-black px-3 py-1.5 text-xs font-black shadow-[4px_4px_0px_0px_#000] ${
                          allowlist ? (explicit ? 'bg-[#00ff00]' : 'bg-white') : 'bg-[#ffff00]'
                        }`}
                      >
                        {providerLabel(id, providers)}{allowlist ? '' : ' · all'}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-3 text-[11px] font-black text-black/70">
                  {allowlist?.length ? `${allowlist.length} provider${allowlist.length === 1 ? '' : 's'} on the allowlist.` : 'No allowlist. Every catalog adapter may run, then routing filters.'}
                </p>
              </div>
            ) : null}
            {selected.id === 'crossProviderFallbackAllowed' && !policy.fallbackAllowed ? (
              <p className="text-sm font-black">Fallback is off, so this switch does nothing until fallback is enabled.</p>
            ) : null}
            {selected.id === 'byokRequired' && policy.byokRequired && !policy.platformCredentialsAllowed ? (
              <p className="text-sm font-black">Platform keys are also blocked. Calls fail unless a valid BYOK credential exists.</p>
            ) : null}
          </div>
        </NinetiesPanel>
      </div>
    </NinetiesFrame>
  );
}
