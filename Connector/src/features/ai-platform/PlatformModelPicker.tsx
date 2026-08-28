'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ExternalLink, KeyRound, Sparkles } from 'lucide-react';
import type { AccessMode } from '@/lib/ai-platform/types';
import {
  assertPlatformModelAllowed,
  isLogicalAliasName,
} from '@/lib/ai-platform/subscription-access';

export type PlatformModelValue = {
  accessMode: AccessMode;
  model: string;
  provider: string | null;
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

const ALIAS_LABELS: Record<string, string> = {
  best: 'Best overall',
  best_reasoning: 'Best reasoning',
  best_coding: 'Best coding',
  best_agent: 'Best agent',
  best_fast: 'Best fast',
  best_cost: 'Best cost',
  best_long_context: 'Best long context',
  best_multimodal: 'Best multimodal',
  best_vision: 'Best vision',
  best_structured_output: 'Best structured output',
};

export const DEFAULT_PLATFORM_MODEL_VALUE: PlatformModelValue = {
  accessMode: 'platform',
  model: 'best_coding',
  provider: null,
  ready: false,
  blockedReason: 'Loading model options…',
  sourceLabel: 'Platform',
};

function sourceLabel(mode: AccessMode): string {
  if (mode === 'byok') return 'BYOK';
  if (mode === 'auto') return 'Auto';
  return 'Platform';
}

function providerLabel(id: string, providers: SetupPayload['providers']): string {
  return providers.find((item) => item.id === id)?.displayName || id;
}

export function PlatformModelPicker({
  value,
  onChange,
  workNoun = 'this work',
}: {
  value: PlatformModelValue;
  onChange: (next: PlatformModelValue) => void;
  workNoun?: string;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [setup, setSetup] = useState<SetupPayload | null>(null);
  const [credentialId, setCredentialId] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch('/api/ai/model-setup', { cache: 'no-store' });
        const payload = await response.json().catch(() => ({})) as SetupPayload & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || 'Could not load model options');
        }
        if (cancelled) return;
        setSetup(payload);
        const nextMode = payload.default_access_mode;
        const nextCredential = payload.credentials[0];
        const nextProvider = nextMode === 'byok' ? nextCredential?.providerId || null : null;
        setCredentialId(nextCredential?.id || '');
        emit(payload, {
          accessMode: nextMode,
          model: payload.default_model,
          provider: nextProvider,
          credentialId: nextCredential?.id || '',
        });
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
  }, []);

  const emit = (
    payload: SetupPayload,
    next: { accessMode: AccessMode; model: string; provider: string | null; credentialId: string },
  ) => {
    const blocked = blockedReason(payload, next);
    onChange({
      accessMode: next.accessMode,
      model: next.model,
      provider: next.provider,
      ready: !blocked,
      blockedReason: blocked,
      sourceLabel: sourceLabel(next.accessMode),
    });
  };

  const blockedReason = (
    payload: SetupPayload,
    next: { accessMode: AccessMode; model: string; provider: string | null },
  ): string | null => {
    if (next.accessMode === 'platform' || next.accessMode === 'auto') {
      if (next.accessMode === 'platform') {
        const check = payload.catalog_allowed
          ? { ok: true as const }
          : assertPlatformModelAllowed(payload.plan_id, next.model);
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
    if (!next.provider) {
      return 'Select a saved BYOK credential.';
    }
    if (!next.model) {
      return 'Select a model for the chosen BYOK provider.';
    }
    return null;
  };

  const aliasOptions = useMemo(() => {
    if (!setup) return [];
    const allowed = value.accessMode === 'byok' ? setup.aliases : setup.platform_aliases;
    return allowed.filter((alias) => ALIAS_LABELS[alias]);
  }, [setup, value.accessMode]);

  const catalogOptions = useMemo(() => {
    if (!setup) return [];
    if (value.accessMode === 'platform' && !setup.catalog_allowed) return [];
    const preferred = setup.models.filter((model) => model.coding || model.agents);
    const pool = preferred.length ? preferred : setup.models;
    if (value.accessMode !== 'byok') return pool;
    if (!value.provider) return [];
    return pool.filter((model) => model.providerId === value.provider);
  }, [setup, value.accessMode, value.provider]);

  if (loading) {
    return <p className="text-sm text-zinc-500">Loading subscription and BYOK options…</p>;
  }

  if (error && !setup) {
    return <p className="text-sm text-rose-400">{error}</p>;
  }

  if (!setup) return null;

  const selectedCredential = setup.credentials.find((item) => item.id === credentialId) || setup.credentials[0] || null;
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
              const nextModel = setup.platform_aliases.includes(value.model) ? value.model : setup.default_model;
              emit(setup, {
                accessMode: 'platform',
                model: nextModel,
                provider: null,
                credentialId,
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
              const firstModel = setup.models.find((model) => model.providerId === provider)?.providerModelId
                || setup.default_model;
              emit(setup, {
                accessMode: 'byok',
                model: firstModel,
                provider,
                credentialId: cred?.id || '',
              });
              if (cred) setCredentialId(cred.id);
            }}
          />
        </div>
        <button
          type="button"
          onClick={() => emit(setup, {
            accessMode: 'auto',
            model: setup.default_model,
            provider: selectedCredential?.providerId || null,
            credentialId,
          })}
          className={`mt-3 text-[12px] underline-offset-2 hover:underline ${value.accessMode === 'auto' ? 'font-bold text-black' : 'text-neutral-500'}`}
        >
          Auto: use BYOK if a key is saved, otherwise platform
        </button>
      </div>

      <div className="rounded-none border-[3px] border-black bg-white px-4 py-3 text-[12px] leading-5 text-neutral-600">
        {setup.paid_plan
          ? `Subscription: ${planLabel} · ${setup.credits_remaining} credit${setup.credits_remaining === 1 ? '' : 's'} remaining this cycle.`
          : `Free plan · upgrade to Starter to run flagship models on the platform, or connect a BYOK key.`}
        {' '}
        <Link href="/dashboard/subscription" className="font-bold text-black underline-offset-2 hover:underline">Manage subscription</Link>
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
                setCredentialId(cred?.id || '');
                const provider = cred?.providerId || null;
                const firstModel = setup.models.find((model) => model.providerId === provider)?.providerModelId || value.model;
                emit(setup, {
                  accessMode: 'byok',
                  model: firstModel,
                  provider,
                  credentialId: cred?.id || '',
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
          onChange={(event) => emit(setup, {
            accessMode: value.accessMode,
            model: event.target.value,
            provider: value.provider,
            credentialId,
          })}
          className="w-full rounded-none border-[3px] border-black bg-white px-4 py-2.5 text-sm text-black outline-none"
        >
          {aliasOptions.length ? (
            <optgroup label="DeplAI aliases">
              {aliasOptions.map((alias) => (
                <option key={alias} value={alias}>
                  {ALIAS_LABELS[alias]} ({alias})
                </option>
              ))}
            </optgroup>
          ) : null}
          {catalogOptions.length ? (
            <optgroup label={value.accessMode === 'byok' ? 'Provider models' : 'Platform catalog'}>
              {catalogOptions.map((model) => (
                <option key={model.id} value={model.providerModelId}>
                  {model.displayName} · {providerLabel(model.providerId, setup.providers)}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        {value.accessMode === 'platform' && !setup.catalog_allowed && !isLogicalAliasName(value.model) ? (
          <p className="mt-2 text-[11px] text-amber-700">Upgrade to Starter to pick specific catalog models on the platform.</p>
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
