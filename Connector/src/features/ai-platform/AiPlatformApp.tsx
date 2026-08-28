'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CompareModels } from './CompareModels';
import { UsageCosts } from './UsageCosts';
import { type HealthSnapshot } from './HealthNineties';
import { CapabilityBar, EmptyState, Field, HealthDot, Panel, aiFetch, btnGhost, btnPrimary, inputClass } from './ui';

type Section = 'keys' | 'catalog' | 'compare' | 'usage';

const TABS: Array<{ id: Section; label: string; href: string }> = [
  { id: 'keys', label: 'Keys', href: '/dashboard/ai' },
  { id: 'catalog', label: 'Catalog', href: '/dashboard/ai/catalog' },
  { id: 'compare', label: 'Compare', href: '/dashboard/ai/compare' },
  { id: 'usage', label: 'Usage', href: '/dashboard/ai/usage' },
];

type Provider = {
  id: string;
  displayName: string;
  status: string;
  supportsByok: boolean;
  supportsPlatformCredentials: boolean;
  platformConfigured: boolean;
  documentationUrl: string;
  credentialSchema: { secretLabel: string; placeholder: string; helpUrl: string };
  brandColor: string;
};

type Model = {
  id: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  family: string;
  lifecycle: string;
  contextWindow: number;
  maxOutputTokens: number;
  latencyProfile: string;
  modelOwner: string | null;
  capabilities: {
    reasoning: boolean;
    coding: boolean;
    agents: boolean;
    tools: boolean;
    vision: boolean;
    streaming: boolean;
    multimodal: boolean;
    scores: Record<string, { value: number; source: string }>;
  };
  pricing: { inputPerMillionUsd: number | null; outputPerMillionUsd: number | null; source: string };
};

type Credential = {
  id: string;
  providerId: string;
  name: string;
  status: string;
  secretMasked: string;
  environment: string;
  lastValidatedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  allowedModelIds: string[] | null;
};

function sectionFromPath(pathname: string): Section {
  const part = pathname.replace('/dashboard/ai', '').replace(/^\//, '').split('/')[0] || '';
  if (part === 'catalog' || part === 'models' || part === 'providers') return 'catalog';
  if (part === 'compare' || part === 'playground') return 'compare';
  if (part === 'usage' || part === 'costs') return 'usage';
  return 'keys';
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 2)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

function ByokTabs({ section }: { section: Section }) {
  return (
    <div className="mb-8 flex flex-wrap border-[3px] border-black bg-white">
      {TABS.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          className={`px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] ${
            tab.id === section ? 'bg-black text-white' : 'text-black hover:bg-neutral-100'
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}

export default function AiPlatformApp() {
  const pathname = usePathname() || '/dashboard/ai';
  const section = sectionFromPath(pathname);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [health, setHealth] = useState<HealthSnapshot[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError('');
    try {
      const [providerPayload, modelPayload, credPayload, healthPayload] = await Promise.all([
        aiFetch<{ providers: Provider[] }>('providers'),
        aiFetch<{ models: Model[] }>('models'),
        aiFetch<{ credentials: Credential[] }>('credentials'),
        aiFetch<{ providers: HealthSnapshot[] }>('health').catch(() => ({ providers: [] })),
      ]);
      setProviders(providerPayload.providers || []);
      setModels(modelPayload.models || []);
      setCredentials(credPayload.credentials || []);
      setHealth(healthPayload.providers || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load AI platform');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const healthMap = useMemo(() => new Map(health.map((item) => [item.providerId, item])), [health]);

  return (
    <div className="custom-scrollbar h-full min-h-0 overflow-y-auto bg-transparent p-5 font-sans sm:p-8">
      <div className="mx-auto max-w-6xl">
        <ByokTabs section={section} />
        {error ? <p className="mb-4 border-[3px] border-black bg-amber-200 px-4 py-3 text-[13px] font-medium text-black">{error}</p> : null}
        {loading ? <p className="text-[13px] text-zinc-500">Loading models and credentials…</p> : null}
        {!loading && section === 'keys' ? (
          <Keys
            providers={providers}
            models={models}
            credentials={credentials}
            healthMap={healthMap}
            onChange={load}
          />
        ) : null}
        {!loading && section === 'catalog' ? (
          <Catalog
            providers={providers}
            models={models}
            credentials={credentials}
            healthMap={healthMap}
            onRefresh={load}
          />
        ) : null}
        {!loading && section === 'compare' ? <CompareModels models={models} /> : null}
        {!loading && section === 'usage' ? <UsageCosts providers={providers} /> : null}
      </div>
    </div>
  );
}

function Keys({
  providers, models, credentials, healthMap, onChange,
}: {
  providers: Provider[];
  models: Model[];
  credentials: Credential[];
  healthMap: Map<string, { status: string }>;
  onChange: () => void;
}) {
  const ready = providers.filter((provider) => provider.platformConfigured || credentials.some((item) => item.providerId === provider.id)).length;
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">Workspace BYOK</p>
      <h2 className="mt-2 font-display text-2xl font-semibold text-black">Keys</h2>
      <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-zinc-500">
        One credential set for the whole platform. Security, deploy, and UI customization all use these keys — never a paste-key dialog per agent.
      </p>
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Panel className="p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">Saved keys</p>
          <p className="mt-2 font-display text-2xl text-black">{credentials.length}</p>
        </Panel>
        <Panel className="p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">Providers ready</p>
          <p className="mt-2 font-display text-2xl text-black">{ready}</p>
        </Panel>
        <Panel className="p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">Models in catalog</p>
          <p className="mt-2 font-display text-2xl text-black">{models.length}</p>
        </Panel>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        {providers.filter((provider) => provider.id !== 'openrouter').slice(0, 8).map((provider) => {
          const status = healthMap.get(provider.id)?.status || 'Unknown';
          return (
            <span key={provider.id} className="inline-flex items-center gap-1.5 border-2 border-black bg-white px-3 py-1.5 text-[12px] text-black">
              <HealthDot status={status} />
              {provider.displayName}
            </span>
          );
        })}
      </div>
      <Credentials providers={providers} credentials={credentials} models={models} onChange={onChange} />
    </div>
  );
}

function Catalog({
  providers, models, credentials, healthMap, onRefresh,
}: {
  providers: Provider[];
  models: Model[];
  credentials: Credential[];
  healthMap: Map<string, { status: string; latencyMs: number | null; detail: string | null }>;
  onRefresh: () => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const [sync, setSync] = useState<{ discovered?: number; providers?: number } | null>(null);
  const deprecated = models.filter((model) => model.lifecycle === 'DEPRECATED' || model.lifecycle === 'SUNSET_PENDING').length;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-semibold text-black">Models & providers</h2>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-zinc-500">
            What this workspace can call. Capability bars are labeled with their source and are not independent benchmarks.
          </p>
        </div>
        <button
          type="button"
          className={btnGhost}
          disabled={syncing}
          onClick={async () => {
            setSyncing(true);
            try {
              const result = await aiFetch<{ discovered: number; providers: number }>('models/sync', { method: 'POST', body: '{}' });
              setSync(result);
              onRefresh();
            } finally {
              setSyncing(false);
            }
          }}
        >
          {syncing ? 'Syncing…' : 'Sync catalog'}
        </button>
      </div>
      {sync ? <p className="mt-3 text-[12px] text-zinc-500">Last sync discovered {sync.discovered ?? 0} models across {sync.providers ?? 0} providers.</p> : null}
      {deprecated > 0 ? (
        <p className="mt-4 border-[3px] border-black bg-amber-200 px-4 py-3 text-[13px] font-medium text-black">
          {deprecated} model{deprecated === 1 ? '' : 's'} are deprecated or pending sunset. Routing will not select them.
        </p>
      ) : null}
      <Providers providers={providers} models={models} credentials={credentials} healthMap={healthMap} onRefresh={onRefresh} />
      <div className="mt-10">
        <Models models={models} />
      </div>
    </div>
  );
}

function Models({ models }: { models: Model[] }) {
  const [query, setQuery] = useState('');
  const [capability, setCapability] = useState('');
  const [provider, setProvider] = useState('');
  const filtered = models.filter((model) => {
    if (provider && model.providerId !== provider) return false;
    if (capability === 'reasoning' && !model.capabilities.reasoning) return false;
    if (capability === 'coding' && !model.capabilities.coding) return false;
    if (capability === 'agents' && !model.capabilities.agents) return false;
    if (capability === 'multimodal' && !model.capabilities.multimodal) return false;
    const haystack = `${model.displayName} ${model.providerModelId} ${model.family} ${model.providerId}`.toLowerCase();
    if (query && !haystack.includes(query.toLowerCase())) return false;
    return true;
  });

  return (
    <div>
      <h3 className="font-display text-lg text-black">Supported models</h3>
      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search coding, reasoning, BYOK…" className={inputClass} />
        <select value={provider} onChange={(event) => setProvider(event.target.value)} className={inputClass}>
          <option value="">Any provider</option>
          {[...new Set(models.map((model) => model.providerId))].map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        <select value={capability} onChange={(event) => setCapability(event.target.value)} className={inputClass}>
          <option value="">Any capability</option>
          <option value="reasoning">Reasoning</option>
          <option value="coding">Coding</option>
          <option value="agents">Agents</option>
          <option value="multimodal">Multimodal</option>
        </select>
      </div>
      {filtered.length === 0 ? <div className="mt-6"><EmptyState title="No models match" body="Adjust filters or sync the catalog after adding a credential." /></div> : (
        <div className="mt-6 grid gap-3 lg:grid-cols-2">
          {filtered.map((model) => (
            <Panel key={model.id} className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-black">{model.displayName}</p>
                  <p className="mt-1 font-mono text-[11px] text-zinc-500">{model.providerId} · {model.providerModelId}{model.modelOwner && model.modelOwner !== model.providerId ? ` · owner ${model.modelOwner}` : ''}</p>
                </div>
                <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">{model.lifecycle}</span>
              </div>
              {model.lifecycle === 'DEPRECATED' ? <p className="mt-3 border-[3px] border-black bg-amber-200 px-3 py-2 text-[12px] font-medium text-black">Deprecated. Routing will migrate workflows away from this model.</p> : null}
              <div className="mt-4 space-y-2">
                <CapabilityBar label="Reasoning" value={model.capabilities.scores.reasoning?.value ?? (model.capabilities.reasoning ? 7 : 2)} source={model.capabilities.scores.reasoning?.source || 'inferred'} />
                <CapabilityBar label="Coding" value={model.capabilities.scores.coding?.value ?? (model.capabilities.coding ? 7 : 2)} source={model.capabilities.scores.coding?.source || 'inferred'} />
                <CapabilityBar label="Agents" value={model.capabilities.scores.agentic?.value ?? (model.capabilities.agents ? 7 : 2)} source={model.capabilities.scores.agentic?.source || 'inferred'} />
              </div>
              <p className="mt-4 text-[12px] text-zinc-500">Context {formatTokens(model.contextWindow)} · Tools {model.capabilities.tools ? 'yes' : 'no'} · Vision {model.capabilities.vision ? 'yes' : 'no'} · Streaming {model.capabilities.streaming ? 'yes' : 'no'}</p>
              <p className="mt-1 font-mono text-[11px] text-zinc-600">Cost source: {model.pricing.source}{model.pricing.outputPerMillionUsd != null ? ` · $${model.pricing.outputPerMillionUsd}/M out` : ''}</p>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}

function Providers({ providers, models, credentials, healthMap, onRefresh }: {
  providers: Provider[];
  models: Model[];
  credentials: Credential[];
  healthMap: Map<string, { status: string; latencyMs: number | null; detail: string | null }>;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="mt-6 grid gap-3 lg:grid-cols-2">
      {providers.map((provider) => {
        const status = healthMap.get(provider.id);
        const count = models.filter((model) => model.providerId === provider.id);
        const keys = credentials.filter((item) => item.providerId === provider.id);
        return (
          <Panel key={provider.id} className="p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-base text-black">{provider.displayName}</h3>
              <span className="flex items-center gap-1.5 text-[12px] text-neutral-600"><HealthDot status={status?.status || 'Unknown'} />{status?.status || 'Unknown'}</span>
            </div>
            <p className="mt-3 text-[13px] text-zinc-500">Platform access {provider.platformConfigured ? 'yes' : 'no'} · BYOK {provider.supportsByok ? 'yes' : 'no'}</p>
            <p className="mt-1 text-[13px] text-zinc-500">Models {count.length} · Active {count.filter((model) => model.lifecycle === 'ACTIVE').length} · Keys {keys.length}</p>
            {status?.detail ? <p className="mt-2 text-[12px] text-zinc-600">{status.detail}</p> : null}
            <div className="mt-4 flex gap-2">
              <a className={`${btnGhost} inline-block`} href={provider.documentationUrl} target="_blank" rel="noreferrer">Docs</a>
              <button
                type="button"
                className={btnGhost}
                disabled={busy === provider.id}
                onClick={async () => {
                  setBusy(provider.id);
                  try {
                    await aiFetch('models/sync', { method: 'POST', body: JSON.stringify({ provider: provider.id }) });
                    onRefresh();
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === provider.id ? 'Syncing…' : 'Sync models'}
              </button>
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

function Credentials({ providers, credentials, models, onChange }: { providers: Provider[]; credentials: Credential[]; models: Model[]; onChange: () => void }) {
  const [step, setStep] = useState(1);
  const [providerId, setProviderId] = useState('');
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [environment, setEnvironment] = useState<'production' | 'development' | 'security' | 'other'>('production');
  const [allowed, setAllowed] = useState<string[]>([]);
  const [result, setResult] = useState<{ ok: boolean; message: string; modelsDiscovered: number } | null>(null);
  const [createdId, setCreatedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const provider = providers.find((item) => item.id === providerId);

  const reset = () => {
    setStep(1); setProviderId(''); setName(''); setSecret(''); setAllowed([]); setResult(null); setError(''); setCreatedId('');
  };

  return (
    <div className="mt-10">
      <h3 className="font-display text-lg font-semibold text-black">Saved credentials</h3>
      <p className="mt-2 text-[13px] text-zinc-500">Keys are encrypted at rest. The UI only ever shows a masked suffix after save.</p>
      {credentials.length === 0 ? (
        <div className="mt-6"><EmptyState title="No BYOK credentials configured" body="Connect a provider key to run on your own account. Platform credentials still work in Auto mode when configured." /></div>
      ) : (
        <div className="mt-6 space-y-3">
          {credentials.map((item) => (
            <Panel key={item.id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-black">{item.name}</p>
                  <p className="mt-1 font-mono text-[11px] text-zinc-500">{item.providerId} · {item.secretMasked} · {item.environment}</p>
                  {item.allowedModelIds?.length ? (
                    <p className="mt-1 text-[11px] text-zinc-600">Allowlist: {item.allowedModelIds.length} model{item.allowedModelIds.length === 1 ? '' : 's'}</p>
                  ) : null}
                  <p className="mt-2 flex items-center gap-1.5 text-[12px] text-neutral-600"><HealthDot status={item.status} />{item.status}</p>
                  <p className="mt-1 text-[12px] text-zinc-600">Created {item.createdAt.slice(0, 10)} · Last validated {item.lastValidatedAt?.slice(0, 10) || 'never'} · Last used {item.lastUsedAt?.slice(0, 10) || 'never'}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={btnGhost} onClick={async () => { await aiFetch(`credentials/${item.id}/validate`, { method: 'POST', body: '{}' }); onChange(); }}>Validate</button>
                  <button type="button" className={btnGhost} onClick={async () => { await aiFetch(`credentials/${item.id}?revoke=1`, { method: 'DELETE' }); onChange(); }}>Revoke</button>
                  <button type="button" className={btnGhost} onClick={async () => { await aiFetch(`credentials/${item.id}`, { method: 'DELETE' }); onChange(); }}>Delete</button>
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}

      <h3 className="mt-10 font-display text-lg font-semibold text-black">Connect a key</h3>
      <Panel className="mt-4 p-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">Step {step} of 7</p>
        {step === 1 ? (
          <Field label="Provider">
            <select value={providerId} onChange={(event) => setProviderId(event.target.value)} className={`${inputClass} mt-3`}>
              <option value="">Select provider</option>
              {providers.filter((item) => item.supportsByok).map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
            </select>
          </Field>
        ) : null}
        {step === 2 ? (
          <div className="mt-3 space-y-3">
            <Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} placeholder={`${provider?.displayName || 'Provider'} production key`} className={inputClass} /></Field>
            <Field label={provider?.credentialSchema.secretLabel || 'API key'}><input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={provider?.credentialSchema.placeholder} className={inputClass} autoComplete="off" /></Field>
            <Field label="Environment">
              <select value={environment} onChange={(event) => setEnvironment(event.target.value as typeof environment)} className={inputClass}>
                <option value="production">Production</option>
                <option value="development">Development</option>
                <option value="security">Security</option>
              </select>
            </Field>
          </div>
        ) : null}
        {step === 3 || step === 4 ? (
          <div className="mt-4 text-[13px] text-neutral-800">
            {result?.ok ? (
              <div className="space-y-1">
                <p>Credential valid</p>
                <p>Provider reachable</p>
                <p>Models discovered: {result.modelsDiscovered}</p>
              </div>
            ) : <p className="text-rose-700">{result?.message || error || 'Validate the key to continue.'}</p>}
          </div>
        ) : null}
        {step === 5 ? (
          <div className="mt-3 max-h-56 space-y-1 overflow-y-auto">
            {models.filter((model) => model.providerId === providerId).map((model) => (
              <label key={model.id} className="flex items-center gap-2 text-[13px] text-black">
                <input type="checkbox" checked={allowed.includes(model.id)} onChange={(event) => setAllowed((current) => event.target.checked ? [...current, model.id] : current.filter((id) => id !== model.id))} />
                {model.displayName}
              </label>
            ))}
          </div>
        ) : null}
        {step === 6 ? <p className="mt-3 text-[13px] text-neutral-600">This key is available to every DeplAI agent in the workspace. Tighten the model allowlist now, or leave it open.</p> : null}
        {step === 7 ? <p className="mt-3 text-[13px] font-medium text-emerald-800">Credential saved. Raw key material is not shown again.</p> : null}
        {error && step < 3 ? <p className="mt-3 text-[12px] text-rose-700">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          {step > 1 && step < 7 ? <button type="button" className={btnGhost} onClick={() => setStep((current) => current - 1)}>Back</button> : null}
          {step === 7 ? <button type="button" className={btnPrimary} onClick={reset}>Done</button> : (
            <button
              type="button"
              className={btnPrimary}
              disabled={busy || (step === 1 && !providerId) || (step === 2 && !secret.trim())}
              onClick={async () => {
                setError('');
                if (step === 2) {
                  setBusy(true);
                  try {
                    const payload = await aiFetch<{ credential: { id: string }; validation: { ok: boolean; message: string; modelsDiscovered: number } }>('credentials', {
                      method: 'POST',
                      body: JSON.stringify({ provider: providerId, name: name || `${provider?.displayName} key`, secret, environment }),
                    });
                    setCreatedId(payload.credential?.id || '');
                    setResult(payload.validation);
                    setSecret('');
                    setStep(payload.validation.ok ? 4 : 3);
                    onChange();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Validation failed');
                    setStep(3);
                  } finally {
                    setBusy(false);
                  }
                  return;
                }
                if (step === 5 && createdId) {
                  setBusy(true);
                  try {
                    await aiFetch(`credentials/${createdId}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ allowedModelIds: allowed.length ? allowed : null }),
                    });
                    onChange();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Could not save model allowlist');
                  } finally {
                    setBusy(false);
                  }
                }
                setStep((current) => Math.min(7, current + 1));
              }}
            >
              {busy ? 'Validating…' : step === 2 ? 'Validate' : 'Continue'}
            </button>
          )}
        </div>
      </Panel>
    </div>
  );
}
