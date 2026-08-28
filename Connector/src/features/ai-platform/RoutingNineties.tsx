'use client';

import { useEffect, useMemo, useState } from 'react';
import { LOGICAL_ALIASES } from '@/lib/ai-platform/types';
import { aiFetch } from './ui';
import {
  NinetiesBanner,
  NinetiesField,
  NinetiesFrame,
  NinetiesHeader,
  NinetiesPanel,
  NinetiesRow,
  NinetiesStat,
  ninetiesGhostBtn,
  ninetiesInkBtn,
  ninetiesInput,
  providerLabel,
} from './nineties';

type AccessMode = 'auto' | 'byok' | 'platform';

type RoutingPolicy = {
  id: string;
  name: string;
  taskType: string;
  primaryAlias: string;
  secondaryAlias: string | null;
  fallbackModelId: string | null;
  accessMode: AccessMode;
  allowedProviders: string[];
  weights: Record<string, number>;
  isDefault?: boolean;
};

type WeightKey = 'capability' | 'reliability' | 'cost' | 'latency' | 'preference' | 'policy' | 'credential';

const WEIGHT_KEYS: WeightKey[] = ['capability', 'reliability', 'cost', 'latency', 'preference', 'policy', 'credential'];

const TASK_TYPES = [
  { id: 'general', label: 'General' },
  { id: 'security_analysis', label: 'Security' },
  { id: 'coding', label: 'Coding' },
  { id: 'ui_generation', label: 'UI generation' },
];

const ACCESS_MODES: Array<{ id: AccessMode; label: string; detail: string }> = [
  { id: 'auto', label: 'BYOK preferred', detail: 'Use a customer key when one exists, otherwise the platform key.' },
  { id: 'byok', label: 'BYOK only', detail: 'Refuse the call if this workspace has no valid customer key for the winner.' },
  { id: 'platform', label: 'Platform only', detail: 'Always bill through DeplAI credentials. Ignore BYOK even if present.' },
];

const EMPTY_WEIGHTS: Record<WeightKey, number> = {
  capability: 40,
  reliability: 25,
  cost: 10,
  latency: 10,
  preference: 0,
  policy: 10,
  credential: 5,
};

function toPercents(weights: Record<string, number> | undefined): Record<WeightKey, number> {
  const next = { ...EMPTY_WEIGHTS };
  for (const key of WEIGHT_KEYS) {
    const raw = Number(weights?.[key]);
    next[key] = Number.isFinite(raw) ? Math.round(raw <= 1 ? raw * 100 : raw) : next[key];
  }
  return next;
}

function accessLabel(mode: AccessMode): string {
  return ACCESS_MODES.find((item) => item.id === mode)?.label || mode;
}

function taskLabel(taskType: string): string {
  return TASK_TYPES.find((item) => item.id === taskType)?.label || taskType.replace(/_/g, ' ');
}

function blankDraft(providerIds: string[]): RoutingPolicy {
  return {
    id: '',
    name: 'New routing policy',
    taskType: 'general',
    primaryAlias: 'best_reasoning',
    secondaryAlias: 'best_fast',
    fallbackModelId: '',
    accessMode: 'auto',
    allowedProviders: providerIds,
    weights: EMPTY_WEIGHTS,
    isDefault: false,
  };
}

export function RoutingNineties({
  providers,
  onOpenPolicies,
  onOpenPlayground,
}: {
  providers: Array<{ id: string; displayName: string }>;
  onOpenPolicies: () => void;
  onOpenPlayground: () => void;
}) {
  const providerIds = useMemo(
    () => (providers.length ? providers.map((item) => item.id) : ['openai', 'anthropic', 'gemini', 'glm', 'groq', 'xai', 'minimax', 'kimi']),
    [providers],
  );
  const [policies, setPolicies] = useState<RoutingPolicy[]>([]);
  const [draft, setDraft] = useState<RoutingPolicy>(blankDraft(providerIds));
  const [weights, setWeights] = useState<Record<WeightKey, number>>(EMPTY_WEIGHTS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    setError('');
    setLoading(true);
    try {
      const payload = await aiFetch<{ policies: RoutingPolicy[] }>('routing-policies');
      const next = payload.policies || [];
      setPolicies(next);
      const current = next.find((item) => item.id === selectedId) || next[0];
      if (current) applyPolicy(current);
      else startNew();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load routing policies');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const applyPolicy = (policy: RoutingPolicy) => {
    setSelectedId(policy.id);
    setDraft({
      ...policy,
      fallbackModelId: policy.fallbackModelId || '',
      secondaryAlias: policy.secondaryAlias || '',
      allowedProviders: policy.allowedProviders?.length ? policy.allowedProviders : providerIds,
    });
    setWeights(toPercents(policy.weights));
  };

  const startNew = () => {
    const next = blankDraft(providerIds);
    setSelectedId('');
    setDraft(next);
    setWeights(EMPTY_WEIGHTS);
    setNotice('');
  };

  const toggleProvider = (id: string) => {
    setDraft((current) => ({
      ...current,
      allowedProviders: current.allowedProviders.includes(id)
        ? current.allowedProviders.filter((item) => item !== id)
        : [...current.allowedProviders, id],
    }));
  };

  const weightSum = WEIGHT_KEYS.reduce((sum, key) => sum + weights[key], 0);

  const save = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = await aiFetch<{ policy: RoutingPolicy }>('routing-policies', {
        method: 'POST',
        body: JSON.stringify({
          id: draft.id || undefined,
          name: draft.name.trim() || 'Untitled policy',
          taskType: draft.taskType,
          primaryAlias: draft.primaryAlias,
          secondaryAlias: draft.secondaryAlias || null,
          fallbackModelId: draft.fallbackModelId || null,
          accessMode: draft.accessMode,
          allowedProviders: draft.allowedProviders,
          isDefault: Boolean(draft.isDefault),
          weights: {
            capability: weights.capability / 100,
            reliability: weights.reliability / 100,
            cost: weights.cost / 100,
            latency: weights.latency / 100,
            preference: weights.preference / 100,
            policy: weights.policy / 100,
            credential: weights.credential / 100,
          },
        }),
      });
      setNotice('Routing policy saved. Playground and agents will use it for this task type.');
      const saved = payload.policy;
      const list = await aiFetch<{ policies: RoutingPolicy[] }>('routing-policies');
      setPolicies(list.policies || []);
      if (saved) applyPolicy(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save routing policy');
    } finally {
      setBusy(false);
    }
  };

  const fallbackCopy = draft.fallbackModelId
    ? `If the primary alias cannot run, try ${draft.fallbackModelId}. Fallback stays inside the allowlist unless workspace policy permits a cross-provider jump.`
    : 'No concrete fallback model. If the alias cannot run, the gateway stops unless another eligible model scores through.';

  const story = `${taskLabel(draft.taskType)} traffic asks for ${draft.primaryAlias}${draft.secondaryAlias ? `, then ${draft.secondaryAlias}` : ''}. Access is ${accessLabel(draft.accessMode).toLowerCase()}. ${draft.allowedProviders.length} provider${draft.allowedProviders.length === 1 ? '' : 's'} allowed. ${fallbackCopy}`;

  return (
    <NinetiesFrame>
      <NinetiesHeader
        kicker="BYOK · Alias resolution"
        title="Routing"
        blurb="These policies decide how aliases like best_reasoning become a real model. Workspace gates on the Policies page can still block a winner."
        actions={
          <>
            <button type="button" className={ninetiesInkBtn} onClick={startNew}>New policy</button>
            <button type="button" className={ninetiesGhostBtn} onClick={onOpenPolicies}>Open policies</button>
          </>
        }
      />

      {error ? <NinetiesBanner>{error}</NinetiesBanner> : null}
      {notice ? <NinetiesBanner>{notice}</NinetiesBanner> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <NinetiesStat label="Policies" value={loading ? '…' : String(policies.length)} tone="white" />
        <NinetiesStat label="Default" value={policies.find((item) => item.isDefault)?.name || 'none'} tone="lime" />
        <NinetiesStat label="BYOK only" value={String(policies.filter((item) => item.accessMode === 'byok').length)} tone="yellow" />
        <NinetiesStat label="Weight sum" value={`${weightSum}%`} tone={weightSum === 100 ? 'cyan' : 'magenta'} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <NinetiesPanel title="Saved policies" badge="click to edit">
          {loading && policies.length === 0 ? (
            <p className="border-4 border-black bg-[#00ffff] px-4 py-6 text-sm font-black">Loading policies…</p>
          ) : (
            <ul className="flex flex-col gap-3">
              <li>
                <NinetiesRow active={selectedId === ''} onClick={startNew}>
                  <div className="min-w-0 flex-1">
                    <p className="font-black">New routing policy</p>
                    <p className="mt-1 text-[11px] font-black text-black/70">Blank builder. Save to add it to the list.</p>
                  </div>
                </NinetiesRow>
              </li>
              {policies.map((policy) => (
                <li key={policy.id}>
                  <NinetiesRow active={policy.id === selectedId} onClick={() => applyPolicy(policy)}>
                    <div className="min-w-0 flex-1">
                      <p className="font-black">{policy.name}</p>
                      <p className="mt-1 text-[11px] font-black text-black/70">
                        {taskLabel(policy.taskType)} · {policy.primaryAlias} · {accessLabel(policy.accessMode)}
                      </p>
                    </div>
                    {policy.isDefault ? (
                      <span className="border-2 border-black bg-[#00ff00] px-2 py-0.5 text-[11px] font-black uppercase">Default</span>
                    ) : null}
                  </NinetiesRow>
                </li>
              ))}
            </ul>
          )}
        </NinetiesPanel>

        <NinetiesPanel title={draft.id ? 'Edit policy' : 'Build policy'} badge={taskLabel(draft.taskType)}>
          <p className="mb-4 border-4 border-black bg-[#00ffff] p-3 text-sm font-black leading-relaxed">{story}</p>
          <div className="space-y-4">
            <NinetiesField label="Policy name">
              <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} className={ninetiesInput} />
            </NinetiesField>
            <div className="grid gap-3 md:grid-cols-2">
              <NinetiesField label="Task type">
                <select value={draft.taskType} onChange={(event) => setDraft((current) => ({ ...current, taskType: event.target.value }))} className={ninetiesInput}>
                  {TASK_TYPES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </NinetiesField>
              <NinetiesField label="Access">
                <select value={draft.accessMode} onChange={(event) => setDraft((current) => ({ ...current, accessMode: event.target.value as AccessMode }))} className={ninetiesInput}>
                  {ACCESS_MODES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </NinetiesField>
              <NinetiesField label="Primary alias">
                <select value={draft.primaryAlias} onChange={(event) => setDraft((current) => ({ ...current, primaryAlias: event.target.value }))} className={ninetiesInput}>
                  {LOGICAL_ALIASES.map((alias) => <option key={alias} value={alias}>{alias}</option>)}
                </select>
              </NinetiesField>
              <NinetiesField label="Secondary alias">
                <select value={draft.secondaryAlias || ''} onChange={(event) => setDraft((current) => ({ ...current, secondaryAlias: event.target.value }))} className={ninetiesInput}>
                  <option value="">None</option>
                  {LOGICAL_ALIASES.map((alias) => <option key={alias} value={alias}>{alias}</option>)}
                </select>
              </NinetiesField>
            </div>
            <NinetiesField label="Fallback model id">
              <input
                value={draft.fallbackModelId || ''}
                onChange={(event) => setDraft((current) => ({ ...current, fallbackModelId: event.target.value }))}
                placeholder="glm:glm-5"
                className={ninetiesInput}
              />
            </NinetiesField>
            <p className="text-[11px] font-black text-black/70">{ACCESS_MODES.find((item) => item.id === draft.accessMode)?.detail}</p>
            <div>
              <p className="mb-2 text-[10px] font-black tracking-wider uppercase">Provider allowlist</p>
              <div className="flex flex-wrap gap-2">
                {providerIds.map((id) => {
                  const on = draft.allowedProviders.includes(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleProvider(id)}
                      className={`border-4 border-black px-3 py-1.5 text-xs font-black shadow-[4px_4px_0px_0px_#000] ${on ? 'bg-[#00ff00]' : 'bg-white'}`}
                    >
                      {providerLabel(id, providers)}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <p className="mb-2 text-[10px] font-black tracking-wider uppercase">Score weights</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {WEIGHT_KEYS.map((key) => (
                  <NinetiesField key={key} label={`${key} ${weights[key]}%`}>
                    <input
                      type="range"
                      min={0}
                      max={50}
                      value={weights[key]}
                      onChange={(event) => setWeights((current) => ({ ...current, [key]: Number(event.target.value) }))}
                      className="w-full accent-black"
                    />
                  </NinetiesField>
                ))}
              </div>
              {weightSum !== 100 ? (
                <p className="mt-2 text-[11px] font-black">Weights currently add to {weightSum}%. The ranker still uses them as relative scores.</p>
              ) : null}
            </div>
            <label className="flex items-center gap-2 text-sm font-black">
              <input
                type="checkbox"
                checked={Boolean(draft.isDefault)}
                onChange={(event) => setDraft((current) => ({ ...current, isDefault: event.target.checked }))}
              />
              Default policy for unmatched tasks
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button type="button" className={ninetiesInkBtn} disabled={busy || !draft.name.trim()} onClick={() => void save()}>
                {busy ? 'Saving…' : draft.id ? 'Save policy' : 'Create policy'}
              </button>
              <button type="button" className={ninetiesGhostBtn} onClick={onOpenPlayground}>Try in playground</button>
            </div>
          </div>
        </NinetiesPanel>
      </div>
    </NinetiesFrame>
  );
}
