'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ExternalLink, KeyRound, Sparkles } from 'lucide-react';
import type { AccessMode } from '@/lib/ai-platform/types';
import {
  assertPlatformModelAllowed,
  isLogicalAliasName,
  isPlatformModelAllowedForPlan,
} from '@/lib/ai-platform/subscription-access';
import { isPlatformModelAllowed } from '@/lib/ai-platform/platform-allowlist';
import {
  readRemediationModelPreference,
  storeRemediationModelPreference,
  type RemediationModelPreference,
} from '@/features/security/remediationModelPreference';

export type PlatformModelValue = {
  accessMode: AccessMode;
  model: string;
  provider: string | null;
  credentialId: string | null;
  ready: boolean;
  blockedReason: string | null;
  sourceLabel: string;
};

type SetupModel = {
  id: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  lifecycle: string;
  coding: boolean;
  agents: boolean;
};

type SetupCredential = {
  id: string;
  providerId: string;
  name: string;
  status: string;
  secretMasked: string;
  environment: string;
  allowedModelIds: string[] | null;
};

type SetupPayload = {
  plan_id: string;
  plan_name: string;
  credits_remaining: number;
  paid_plan: boolean;
  platform_aliases: string[];
  catalog_allowed: boolean;
  default_access_mode: AccessMode;
  default_model: string;
  aliases: string[];
  credentials: SetupCredential[];
  models: SetupModel[];
  providers: Array<{ id: string; displayName: string; platformConfigured: boolean; supportsByok: boolean }>;
};

type SelectionInput = {
  accessMode: AccessMode;
  model: string;
  provider: string | null;
  credentialId: string | null;
};

function platformCatalogModels(payload: SetupPayload): SetupModel[] {
  const preferred = payload.models.filter((model) => model.coding || model.agents);
  const pool = preferred.length ? preferred : payload.models;
  const allowlisted = pool.filter((model) => isPlatformModelAllowed(model.id));
  if (payload.catalog_allowed) return allowlisted;
  return allowlisted.filter((model) => isPlatformModelAllowedForPlan(payload.plan_id, model.providerModelId));
}

function normalizePlatformModel(payload: SetupPayload, model: string): string {
  if (isLogicalAliasName(model)) return payload.default_model;
  if (isModelSelectable(payload, model, 'platform', null, null)) return model;
  return platformCatalogModels(payload)[0]?.providerModelId || payload.default_model;
}

export const DEFAULT_PLATFORM_MODEL_VALUE: PlatformModelValue = {
  accessMode: 'platform',
  model: '',
  provider: null,
  credentialId: null,
  ready: false,
  blockedReason: 'Loading model options…',
  sourceLabel: 'Platform',
};

function formatCreditsRemaining(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 100) return Math.round(value).toLocaleString();
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function sourceLabel(mode: AccessMode): string {
  if (mode === 'byok') return 'BYOK';
  if (mode === 'auto') return 'Auto';
  return 'Platform';
}

function providerLabel(id: string, providers: SetupPayload['providers']): string {
  return providers.find((item) => item.id === id)?.displayName || id;
}

function findFirstModelForProvider(payload: SetupPayload, providerId: string): string {
  return payload.models.find((model) => model.providerId === providerId)?.providerModelId
    || payload.default_model;
}

function modelAllowedForCredential(model: SetupModel, credential: SetupCredential | null): boolean {
  if (!credential?.allowedModelIds?.length) return true;
  return credential.allowedModelIds.includes(model.id)
    || credential.allowedModelIds.includes(model.providerModelId);
}

function isModelSelectable(
  payload: SetupPayload,
  model: string,
  accessMode: AccessMode,
  provider: string | null,
  credential: SetupCredential | null,
): boolean {
  if (isLogicalAliasName(model)) return false;
  const catalogModel = payload.models.find((item) => item.providerModelId === model || item.id === model);
  if (!catalogModel) return false;
  if (accessMode === 'platform') {
    return isPlatformModelAllowedForPlan(payload.plan_id, catalogModel.providerModelId);
  }
  if (accessMode === 'byok') {
    if (!provider || catalogModel.providerId !== provider) return false;
    return modelAllowedForCredential(catalogModel, credential);
  }
  return isPlatformModelAllowedForPlan(payload.plan_id, catalogModel.providerModelId);
}

function resolveInitialSelection(
  payload: SetupPayload,
  saved: RemediationModelPreference | null,
): SelectionInput {
  if (saved) {
    if (saved.accessMode === 'byok') {
      const credential = (saved.credentialId
        ? payload.credentials.find((item) => item.id === saved.credentialId)
        : null) || payload.credentials[0] || null;
      if (credential) {
        const provider = credential.providerId;
        const model = isModelSelectable(payload, saved.model, 'byok', provider, credential)
          ? saved.model
          : findFirstModelForProvider(payload, provider);
        return {
          accessMode: 'byok',
          model,
          provider,
          credentialId: credential.id,
        };
      }
    } else if (saved.accessMode === 'platform') {
      const model = normalizePlatformModel(payload, saved.model);
      return {
        accessMode: 'platform',
        model,
        provider: null,
        credentialId: null,
      };
    } else if (saved.accessMode === 'auto') {
      const credential = (saved.credentialId
        ? payload.credentials.find((item) => item.id === saved.credentialId)
        : null) || payload.credentials[0] || null;
      const model = saved.model && !isLogicalAliasName(saved.model)
        ? saved.model
        : payload.default_model;
      return {
        accessMode: 'auto',
        model,
        provider: credential?.providerId || null,
        credentialId: credential?.id || null,
      };
    }
  }

  const nextMode = payload.default_access_mode;
  const nextCredential = payload.credentials[0] || null;
  return {
    accessMode: nextMode,
    model: payload.default_model,
    provider: nextMode === 'byok' ? nextCredential?.providerId || null : null,
    credentialId: nextMode === 'byok' ? nextCredential?.id || null : null,
  };
}

export function PlatformModelPicker({
  value,
  onChange,
  workNoun = 'this work',
  persistKey,
  setupUrl = '/api/ai/model-setup',
}: {
  value: PlatformModelValue;
  onChange: (next: PlatformModelValue) => void;
  workNoun?: string;
  persistKey?: string;
  setupUrl?: string;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [setup, setSetup] = useState<SetupPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch(setupUrl, { cache: 'no-store' });
        const payload = await response.json().catch(() => ({})) as SetupPayload & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || 'Could not load model options');
        }
        if (cancelled) return;
        setSetup(payload);
        const saved = persistKey ? readRemediationModelPreference(persistKey) : null;
        const initial = resolveInitialSelection(payload, saved);
        emit(payload, initial, onChange, workNoun, persistKey);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load model options');
        onChange({
          ...value,
          ready: false,
          blockedReason: err instanceof Error ? err.message : 'Could not load model options',
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // Initial load only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistKey, setupUrl]);

  const emitSelection = (next: SelectionInput) => {
    if (!setup) return;
    emit(setup, next, onChange, workNoun, persistKey);
  };

  const blockedReason = (
    payload: SetupPayload,
    next: SelectionInput,
  ): string | null => {
    if (next.accessMode === 'platform' || next.accessMode === 'auto') {
      if (next.accessMode === 'platform') {
        const check = assertPlatformModelAllowed(payload.plan_id, next.model);
        if (!check.ok) return check.message;
      }
      if (next.accessMode === 'auto' && !payload.credentials.length && !payload.providers.some((item) => item.platformConfigured)) {
        return 'Add a BYOK key or wait for platform credentials to be configured.';
      }
      return null;
    }
    if (!payload.credentials.length) {
      return `Add a provider key in BYOK credentials before starting ${workNoun} with your own models.`;
    }
    if (!next.credentialId) {
      return 'Select a saved BYOK credential.';
    }
    if (!next.provider) {
      return 'Select a saved BYOK credential.';
    }
    if (!next.model) {
      return 'Select a model for the chosen BYOK provider.';
    }
    const credential = payload.credentials.find((item) => item.id === next.credentialId) || null;
    if (!isModelSelectable(payload, next.model, 'byok', next.provider, credential)) {
      return 'Selected model is not allowed for this BYOK credential.';
    }
    return null;
  };

  const selectedCredential = useMemo(() => {
    if (!setup) return null;
    return setup.credentials.find((item) => item.id === value.credentialId) || setup.credentials[0] || null;
  }, [setup, value.credentialId]);

  const catalogOptions = useMemo(() => {
    if (!setup) return [];
    if (value.accessMode === 'byok') {
      if (!value.provider) return [];
      const preferred = setup.models.filter((model) => model.coding || model.agents);
      const pool = preferred.length ? preferred : setup.models;
      return pool.filter(
        (model) => model.providerId === value.provider
          && modelAllowedForCredential(model, selectedCredential),
      );
    }
    if (value.accessMode === 'platform' || value.accessMode === 'auto') {
      return platformCatalogModels(setup);
    }
    return [];
  }, [setup, value.accessMode, value.provider, selectedCredential]);

  if (loading) {
    return <p className="text-sm text-zinc-500">Loading subscription and BYOK options…</p>;
  }

  if (error && !setup) {
    return <p className="text-sm text-rose-400">{error}</p>;
  }

  if (!setup) return null;

  const planLabel = setup.paid_plan ? setup.plan_name.replace(/_/g, ' ') : 'Free';

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-2 block text-[10px] font-bold uppercase text-zinc-500">Model source</label>
        <div className="grid gap-3 sm:grid-cols-2">
          <SourceCard
            active={value.accessMode === 'platform'}
            title="Platform"
            body={setup.paid_plan
              ? `Included with your ${planLabel} subscription. No API key required.`
              : 'Use DeplAI-hosted Fast and Cost models on the Free plan, or upgrade for flagship models.'}
            icon={<Sparkles className="h-4 w-4" />}
            onClick={() => {
              const pool = platformCatalogModels(setup);
              const nextModel = pool.some((model) => model.providerModelId === value.model)
                ? value.model
                : setup.default_model;
              emitSelection({
                accessMode: 'platform',
                model: nextModel,
                provider: null,
                credentialId: null,
              });
            }}
          />
          <SourceCard
            active={value.accessMode === 'byok'}
            title="BYOK"
            body={setup.credentials.length
              ? `${setup.credentials.length} saved key${setup.credentials.length === 1 ? '' : 's'} in AI Platform credentials.`
              : 'Bring your own provider key. Keys are stored in the BYOK vault, not in this form.'}
            icon={<KeyRound className="h-4 w-4" />}
            onClick={() => {
              const cred = selectedCredential || setup.credentials[0] || null;
              const provider = cred?.providerId || null;
              const firstModel = provider ? findFirstModelForProvider(setup, provider) : setup.default_model;
              emitSelection({
                accessMode: 'byok',
                model: firstModel,
                provider,
                credentialId: cred?.id || null,
              });
            }}
          />
        </div>
        <button
          type="button"
          onClick={() => emitSelection({
            accessMode: 'auto',
            model: setup.default_model,
            provider: selectedCredential?.providerId || null,
            credentialId: selectedCredential?.id || null,
          })}
          className={`mt-3 text-[12px] underline-offset-2 hover:underline ${value.accessMode === 'auto' ? 'font-bold text-black' : 'text-neutral-500'}`}
        >
          Auto: use BYOK if a key is saved, otherwise platform
        </button>
      </div>

      <div className="rounded-none border-[3px] border-black bg-white px-4 py-3 text-[12px] leading-5 text-neutral-600">
        {setup.paid_plan
          ? `Subscription: ${planLabel} · ${formatCreditsRemaining(setup.credits_remaining)} credit${setup.credits_remaining === 1 ? '' : 's'} available.`
          : `Free plan · upgrade to Starter to run flagship models on the platform, or connect a BYOK key.`}
        {' '}
        <Link href="/dashboard/billing" className="font-bold text-black underline-offset-2 hover:underline">Manage billing</Link>
        {' · '}
        <Link href="/dashboard/ai" className="font-bold text-black underline-offset-2 hover:underline">
          Open BYOK credentials
          <ExternalLink className="ml-1 inline h-3 w-3" />
        </Link>
      </div>

      {value.accessMode === 'byok' ? (
        <div>
          <label className="mb-2 block text-[10px] font-bold uppercase text-zinc-500">Saved credential</label>
          {setup.credentials.length === 0 ? (
            <div className="rounded-none border-[3px] border-dashed border-black bg-white px-4 py-4 text-sm text-neutral-600">
              No provider keys are stored yet.
              {' '}
              <Link href="/dashboard/ai" className="font-bold text-black underline-offset-2 hover:underline">
                Add a key in BYOK
              </Link>
              {' '}
              and return here. Keys are never pasted on this page.
            </div>
          ) : (
            <select
              value={selectedCredential?.id || ''}
              onChange={(event) => {
                const cred = setup.credentials.find((item) => item.id === event.target.value) || null;
                const provider = cred?.providerId || null;
                const firstModel = provider
                  ? findFirstModelForProvider(setup, provider)
                  : value.model;
                emitSelection({
                  accessMode: 'byok',
                  model: firstModel,
                  provider,
                  credentialId: cred?.id || null,
                });
              }}
              className="w-full rounded-none border-[3px] border-black bg-white px-4 py-2.5 text-sm text-black outline-none"
            >
              {setup.credentials.map((item) => (
                <option key={item.id} value={item.id}>
                  {providerLabel(item.providerId, setup.providers)} · {item.name || item.secretMasked} · {item.status}
                </option>
              ))}
            </select>
          )}
        </div>
      ) : null}

      <div>
        <label className="mb-2 block text-[10px] font-bold uppercase text-zinc-500">Model</label>
        <select
          value={value.model}
          onChange={(event) => emitSelection({
            accessMode: value.accessMode,
            model: event.target.value,
            provider: value.provider,
            credentialId: value.credentialId,
          })}
          className="w-full rounded-none border-[3px] border-black bg-white px-4 py-2.5 text-sm text-black outline-none"
        >
          {catalogOptions.map((model) => (
            <option key={model.id} value={model.providerModelId}>
              {model.displayName} · {providerLabel(model.providerId, setup.providers)}
            </option>
          ))}
        </select>
        {value.accessMode === 'platform' && !catalogOptions.length ? (
          <p className="mt-2 text-[11px] text-amber-700">No platform models are available on your current plan.</p>
        ) : null}
      </div>

      {value.blockedReason ? (
        <p className="text-[12px] text-amber-700">{value.blockedReason}</p>
      ) : (
        <p className="text-[12px] text-zinc-500">
          {value.accessMode === 'byok'
            ? `${capitalize(workNoun)} will use the selected vaulted key. It is not stored in the browser.`
            : value.accessMode === 'auto'
              ? `${capitalize(workNoun)} will prefer a saved BYOK key, then fall back to platform credentials included with your plan.`
              : `${capitalize(workNoun)} will call DeplAI-hosted models included with your subscription. No key paste required.`}
        </p>
      )}
    </div>
  );
}

function emit(
  payload: SetupPayload,
  next: SelectionInput,
  onChange: (next: PlatformModelValue) => void,
  workNoun: string,
  persistKey?: string,
) {
  const blocked = (() => {
    if (next.accessMode === 'platform' || next.accessMode === 'auto') {
      if (next.accessMode === 'platform') {
        const check = assertPlatformModelAllowed(payload.plan_id, next.model);
        if (!check.ok) return check.message;
      }
      if (next.accessMode === 'auto' && !payload.credentials.length && !payload.providers.some((item) => item.platformConfigured)) {
        return 'Add a BYOK key or wait for platform credentials to be configured.';
      }
      return null;
    }
    if (!payload.credentials.length) {
      return `Add a provider key in BYOK credentials before starting ${workNoun} with your own models.`;
    }
    if (!next.credentialId || !next.provider) {
      return 'Select a saved BYOK credential.';
    }
    if (!next.model) {
      return 'Select a model for the chosen BYOK provider.';
    }
    const credential = payload.credentials.find((item) => item.id === next.credentialId) || null;
    if (!isModelSelectable(payload, next.model, 'byok', next.provider, credential)) {
      return 'Selected model is not allowed for this BYOK credential.';
    }
    return null;
  })();

  const nextValue: PlatformModelValue = {
    accessMode: next.accessMode,
    model: next.model,
    provider: next.provider,
    credentialId: next.credentialId,
    ready: !blocked,
    blockedReason: blocked,
    sourceLabel: sourceLabel(next.accessMode),
  };
  onChange(nextValue);
  if (persistKey && !blocked) {
    storeRemediationModelPreference(persistKey, {
      accessMode: next.accessMode,
      model: next.model,
      provider: next.provider,
      credentialId: next.credentialId,
    });
  }
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function SourceCard({
  active,
  title,
  body,
  icon,
  onClick,
}: {
  active: boolean;
  title: string;
  body: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-none border-[3px] px-4 py-3 text-left transition ${
        active
          ? 'border-black bg-black text-white shadow-[4px_4px_0_0_#000]'
          : 'border-black bg-white text-black shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none'
      }`}
    >
      <div className={`flex items-center gap-2 text-sm font-semibold ${active ? 'text-white' : 'text-black'}`}>
        {icon}
        {title}
      </div>
      <p className={`mt-1 text-[12px] leading-5 ${active ? 'text-[#e5e5e5]' : 'text-neutral-600'}`}>{body}</p>
    </button>
  );
}
