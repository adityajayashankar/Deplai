'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  StageHeader,
  Surface,
  SurfaceLabel,
  accentButtonClass,
  secondaryButtonClass,
} from '@/features/deployment/deployment-ui';
import { isValidEnvSecretKey, parseEnvSecretBlock } from '@/features/deployment/parseEnvSecretBlock';

export type AppSecretMeta = {
  key: string;
  is_set: boolean;
  required?: boolean;
  updated_at?: string | null;
  arn?: string | null;
};

type DraftRow = {
  key: string;
  value: string;
  required: boolean;
};

type AwsCreds = {
  aws_access_key_id: string;
  aws_secret_access_key: string;
  aws_session_token: string;
};

type Props = {
  projectId: string;
  projectName: string;
  aws: AwsCreds;
  awsRegion: string;
  secretsPrefix: string;
  environment: string;
  requiredKeys: string[];
  optionalHintKeys?: string[];
  publicAppUrl?: string | null;
  oauthCallbackPaths?: string[];
  hasAwsCredentials: boolean;
  onMetaChange?: (meta: AppSecretMeta[]) => void;
  onContinueToDeploy: () => void | Promise<void>;
  onBackToAwsConfig?: () => void;
  canContinueToDeploy: boolean;
  initialMeta?: AppSecretMeta[];
};

const GENERATED_KEYS = new Set(['JWT_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET']);
const EMPTY_HINT_KEYS: string[] = [];

function keysSignature(keys: Iterable<string>): string {
  return Array.from(keys).map((key) => String(key).trim()).filter(Boolean).sort().join('\0');
}

function rowStatusLabel(row: DraftRow, isSetInAws: boolean): string {
  if (row.value.trim()) {
    return `Ready to save (${row.value.trim().length} chars)`;
  }
  if (isSetInAws) {
    return 'Saved in AWS Secrets Manager';
  }
  return 'Not set';
}

export function AppSecretsPanel({
  projectId,
  projectName,
  aws,
  awsRegion,
  secretsPrefix,
  environment,
  requiredKeys,
  optionalHintKeys = EMPTY_HINT_KEYS,
  publicAppUrl,
  oauthCallbackPaths = EMPTY_HINT_KEYS,
  hasAwsCredentials,
  onMetaChange,
  onContinueToDeploy,
  onBackToAwsConfig,
  canContinueToDeploy,
  initialMeta = [],
}: Props) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remote, setRemote] = useState<AppSecretMeta[]>(() => initialMeta);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [bulkPaste, setBulkPaste] = useState('');
  const [bulkHint, setBulkHint] = useState<string | null>(null);
  const onMetaChangeRef = useRef(onMetaChange);
  onMetaChangeRef.current = onMetaChange;
  const knownSetKeysRef = useRef<Set<string>>(
    new Set(initialMeta.filter((row) => row.is_set).map((row) => row.key)),
  );
  const clearDraftsAfterSaveRef = useRef(false);
  const bootstrappedRef = useRef(false);

  const requiredKeySig = useMemo(() => keysSignature(requiredKeys), [requiredKeys]);
  const optionalHintSig = useMemo(() => keysSignature(optionalHintKeys), [optionalHintKeys]);
  const requiredSet = useMemo(
    () => new Set(requiredKeySig ? requiredKeySig.split('\0') : []),
    [requiredKeySig],
  );
  const optionalHints = useMemo(
    () => (optionalHintSig ? optionalHintSig.split('\0') : EMPTY_HINT_KEYS),
    [optionalHintSig],
  );

  const awsAccessKeyId = aws.aws_access_key_id;
  const awsSecretAccessKey = aws.aws_secret_access_key;
  const awsSessionToken = aws.aws_session_token;

  const callSecretsApi = useCallback(
    async (body: Record<string, unknown>) => {
      const response = await fetch('/api/pipeline/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          aws_access_key_id: awsAccessKeyId,
          aws_secret_access_key: awsSecretAccessKey,
          aws_session_token: awsSessionToken || undefined,
          aws_region: awsRegion,
          secrets_manager_prefix: secretsPrefix,
          environment,
          ...body,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        prefix?: string;
        secrets?: AppSecretMeta[];
      };
      if (!response.ok || data.success === false) {
        throw new Error(data.error || 'Secrets request failed');
      }
      return data;
    },
    [awsAccessKeyId, awsRegion, awsSecretAccessKey, awsSessionToken, environment, projectId, secretsPrefix],
  );

  const publishMeta = useCallback((meta: AppSecretMeta[]) => {
    for (const row of meta) {
      if (row.is_set) knownSetKeysRef.current.add(row.key);
    }
    setRemote(meta);
    onMetaChangeRef.current?.(meta);
  }, []);

  const mergeMetaIntoDrafts = useCallback((meta: AppSecretMeta[], clearValues: boolean) => {
    setDrafts((prev) => {
      const prevValues = new Map(prev.map((row) => [row.key, row.value]));
      const keys = new Set(meta.map((row) => row.key));
      for (const row of prev) {
        if (!keys.has(row.key) && row.value.trim()) keys.add(row.key);
      }
      const next: DraftRow[] = [];
      for (const key of keys) {
        const remoteRow = meta.find((row) => row.key === key);
        next.push({
          key,
          value: clearValues ? '' : (prevValues.get(key) || ''),
          required: Boolean(remoteRow?.required || requiredSet.has(key)),
        });
      }
      return next.sort(
        (a, b) => Number(b.required) - Number(a.required) || a.key.localeCompare(b.key),
      );
    });
  }, [requiredSet]);

  const buildMeta = useCallback((listed: AppSecretMeta[]) => {
    const byKey = new Map(listed.map((row) => [row.key, { ...row, is_set: Boolean(row.is_set) }]));
    for (const key of knownSetKeysRef.current) {
      const existing = byKey.get(key);
      if (existing) {
        byKey.set(key, { ...existing, is_set: true });
      } else {
        byKey.set(key, { key, is_set: true, required: requiredSet.has(key) });
      }
    }
    for (const key of requiredSet) {
      if (!byKey.has(key)) {
        byKey.set(key, { key, is_set: false, required: true });
      }
    }
    for (const key of optionalHints) {
      if (!byKey.has(key) && !GENERATED_KEYS.has(key)) {
        byKey.set(key, { key, is_set: false, required: false });
      }
    }
    return Array.from(byKey.values())
      .map((row) => ({
        ...row,
        required: requiredSet.has(row.key) || Boolean(row.required),
        is_set: Boolean(row.is_set) || knownSetKeysRef.current.has(row.key),
      }))
      .sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)) || a.key.localeCompare(b.key));
  }, [optionalHints, requiredSet]);

  const refresh = useCallback(async () => {
    if (!hasAwsCredentials) {
      setError('Add AWS credentials in AWS Config before managing app secrets.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await callSecretsApi({ action: 'list' });
      const listed = Array.isArray(data.secrets) ? data.secrets : [];
      const meta = buildMeta(listed);
      publishMeta(meta);
      mergeMetaIntoDrafts(meta, clearDraftsAfterSaveRef.current);
      clearDraftsAfterSaveRef.current = false;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to list secrets');
    } finally {
      setLoading(false);
    }
  }, [buildMeta, callSecretsApi, hasAwsCredentials, mergeMetaIntoDrafts, publishMeta]);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    if (initialMeta.length > 0) {
      const meta = buildMeta(initialMeta);
      publishMeta(meta);
      mergeMetaIntoDrafts(meta, false);
    }
    void refresh();
  }, [buildMeta, initialMeta, mergeMetaIntoDrafts, publishMeta, refresh]);

  const draftValueByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of drafts) {
      if (row.value.trim()) map.set(row.key, row.value);
    }
    return map;
  }, [drafts]);

  const missingRequired = useMemo(
    () => remote
      .filter((row) => {
        if (!row.required) return false;
        if (row.is_set) return false;
        if (knownSetKeysRef.current.has(row.key)) return false;
        if (draftValueByKey.has(row.key)) return false;
        return true;
      })
      .map((row) => row.key),
    [draftValueByKey, remote],
  );

  const pendingSaveCount = draftValueByKey.size;
  // Secrets are optional for moving on — warn only, never hard-block Continue.
  const proceedBlocker = !canContinueToDeploy
    ? 'Finish Infrastructure Generation / approve the architecture setup first.'
    : !hasAwsCredentials
      ? 'AWS credentials expired or missing. Re-enter them in AWS Config, then continue.'
      : null;
  const continueEnabled = !saving && (
    !hasAwsCredentials
      ? Boolean(onBackToAwsConfig)
      : canContinueToDeploy
  );

  // Keep parent deploy-gate in sync when local known-set cache says a key is saved.
  useEffect(() => {
    const needsSync = remote.some((row) => !row.is_set && knownSetKeysRef.current.has(row.key));
    if (!needsSync) return;
    publishMeta(
      remote.map((row) => ({
        ...row,
        is_set: row.is_set || knownSetKeysRef.current.has(row.key),
      })),
    );
  }, [publishMeta, remote]);

  const applyPairsToDrafts = useCallback((pairs: Array<{ key: string; value: string }>) => {
    setDrafts((prev) => {
      const byKey = new Map(prev.map((row) => [row.key, { ...row }]));
      for (const pair of pairs) {
        const existing = byKey.get(pair.key);
        if (existing) {
          byKey.set(pair.key, { ...existing, value: pair.value });
        } else {
          byKey.set(pair.key, {
            key: pair.key,
            value: pair.value,
            required: requiredSet.has(pair.key),
          });
        }
      }
      return Array.from(byKey.values()).sort(
        (a, b) => Number(b.required) - Number(a.required) || a.key.localeCompare(b.key),
      );
    });
  }, [requiredSet]);

  const persistSecrets = useCallback(async (pairs: Array<{ key: string; value: string }>) => {
    if (pairs.length === 0) return;
    await callSecretsApi({ action: 'upsert', secrets: pairs });
    for (const pair of pairs) knownSetKeysRef.current.add(pair.key);
    // Optimistically mark set so Continue / remount does not look empty if list lags.
    const meta = buildMeta(pairs.map((pair) => ({ key: pair.key, is_set: true, required: requiredSet.has(pair.key) })));
    publishMeta(meta);
    clearDraftsAfterSaveRef.current = true;
    mergeMetaIntoDrafts(meta, true);
  }, [buildMeta, callSecretsApi, mergeMetaIntoDrafts, publishMeta, requiredSet]);

  const applyBulkPaste = useCallback((andSave: boolean, rawText?: string) => {
    const text = rawText ?? bulkPaste;
    const { pairs, skipped } = parseEnvSecretBlock(text);
    if (pairs.length === 0) {
      setError('Paste KEY=VALUE lines (one per line), like a .env file.');
      setBulkHint(null);
      return;
    }

    applyPairsToDrafts(pairs);
    setBulkPaste('');
    setError(null);
    const skipNote = skipped.length > 0 ? ` Skipped ${skipped.length} invalid/empty line(s).` : '';
    setBulkHint(
      `Loaded ${pairs.length} secret${pairs.length === 1 ? '' : 's'} into the form below.${skipNote} `
      + (andSave ? 'Saving to AWS…' : 'Click “Save & continue” or “Save to AWS”.'),
    );

    if (!andSave) return;

    void (async () => {
      if (!hasAwsCredentials) return;
      setSaving(true);
      setError(null);
      try {
        await persistSecrets(pairs);
        setBulkHint(`Saved ${pairs.length} secret${pairs.length === 1 ? '' : 's'} to AWS Secrets Manager.${skipNote}`);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save secrets');
      } finally {
        setSaving(false);
      }
    })();
  }, [applyPairsToDrafts, bulkPaste, hasAwsCredentials, persistSecrets, refresh]);

  const saveDrafts = async () => {
    if (!hasAwsCredentials) return;
    const toSave = drafts
      .map((row) => ({ key: row.key.trim(), value: row.value }))
      .filter((row) => row.key && row.value);
    if (toSave.length === 0) {
      setError('Enter or paste at least one secret value to save.');
      return false;
    }
    setSaving(true);
    setError(null);
    try {
      await persistSecrets(toSave);
      setNewKey('');
      setNewValue('');
      setBulkHint(`Saved ${toSave.length} secret${toSave.length === 1 ? '' : 's'} to AWS.`);
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save secrets');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleContinue = async () => {
    if (!hasAwsCredentials) {
      onBackToAwsConfig?.();
      return;
    }
    if (!canContinueToDeploy) return;
    const toSave = drafts
      .map((row) => ({ key: row.key.trim(), value: row.value }))
      .filter((row) => row.key && row.value);
    if (toSave.length > 0) {
      setSaving(true);
      setError(null);
      try {
        await persistSecrets(toSave);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save secrets before continuing');
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    await onContinueToDeploy();
  };

  const deleteKey = async (key: string) => {
    if (!hasAwsCredentials || !key) return;
    setSaving(true);
    setError(null);
    try {
      const inAws = remote.some((row) => row.key === key && row.is_set) || knownSetKeysRef.current.has(key);
      if (inAws) {
        await callSecretsApi({ action: 'delete', key });
        knownSetKeysRef.current.delete(key);
        await refresh();
      } else {
        setDrafts((prev) => prev.filter((row) => row.key !== key));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete secret');
    } finally {
      setSaving(false);
    }
  };

  const addRow = () => {
    const key = newKey.trim();
    if (!key || !isValidEnvSecretKey(key)) {
      setError('Secret keys must be env-style names (letters, numbers, underscore).');
      return;
    }
    if (drafts.some((row) => row.key === key)) {
      setError(`Key ${key} already exists.`);
      return;
    }
    setDrafts((prev) => [...prev, { key, value: newValue, required: requiredSet.has(key) }]);
    setNewKey('');
    setNewValue('');
    setError(null);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <StageHeader
        title="App Secrets"
        description={`Store OAuth and API keys in your AWS Secrets Manager for ${projectName}. Values are write-only after save — never committed to git or Terraform.`}
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Surface className="space-y-4 xl:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="font-mono text-xs text-zinc-500">Prefix: {secretsPrefix || '—'}</div>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading || !hasAwsCredentials}
              className={`${secondaryButtonClass(loading || !hasAwsCredentials)} inline-flex items-center gap-2`}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>

          {!hasAwsCredentials && (
            <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              Complete AWS Config with access key and secret key first.
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</div>
          )}

          {missingRequired.length > 0 && (
            <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              Suggested secrets not set yet: {missingRequired.join(', ')}. You can continue anyway — login/features that need them may fail until you add them later.
            </div>
          )}

          {pendingSaveCount > 0 && (
            <div className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
              {pendingSaveCount} secret{pendingSaveCount === 1 ? '' : 's'} ready in the form. “Save & continue” will store them in AWS, then open Deploy.
            </div>
          )}

          <div className="space-y-2 rounded-md border border-white/10 bg-[#09090b] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Paste all secrets</span>
              <span className="text-[11px] text-zinc-600">Paste fills the form automatically</span>
            </div>
            <textarea
              value={bulkPaste}
              onChange={(event) => {
                setBulkPaste(event.target.value);
                setBulkHint(null);
              }}
              onPaste={(event) => {
                const text = event.clipboardData.getData('text');
                if (!text.includes('=')) return;
                event.preventDefault();
                setBulkPaste(text);
                applyBulkPaste(false, text);
              }}
              placeholder={'DB_HOST=...\nDB_PASSWORD=...\nGOOGLE_CLIENT_ID=...\nGOOGLE_CLIENT_SECRET=...'}
              rows={6}
              spellCheck={false}
              className="w-full resize-y rounded-md border border-white/10 bg-black px-3 py-2 font-mono text-sm leading-relaxed text-zinc-200 outline-none focus:border-white/25"
              autoComplete="off"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => applyBulkPaste(false)}
                disabled={!bulkPaste.trim() || saving}
                className={`${secondaryButtonClass(!bulkPaste.trim() || saving)} inline-flex items-center gap-2`}
              >
                Fill form
              </button>
              <button
                type="button"
                onClick={() => applyBulkPaste(true)}
                disabled={!bulkPaste.trim() || saving || !hasAwsCredentials}
                className={`${accentButtonClass(!bulkPaste.trim() || saving || !hasAwsCredentials)} inline-flex items-center gap-2`}
              >
                {saving ? 'Saving…' : 'Paste & save to AWS'}
              </button>
            </div>
            {bulkHint && (
              <div className="text-xs text-zinc-300">{bulkHint}</div>
            )}
          </div>

          <div className="space-y-3">
            {drafts.map((row) => {
              const meta = remote.find((item) => item.key === row.key);
              const filled = Boolean(row.value.trim());
              const saved = Boolean(meta?.is_set) || knownSetKeysRef.current.has(row.key);
              return (
                <div key={row.key} className="grid grid-cols-1 gap-2 rounded-md border border-white/10 bg-[#09090b] p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-zinc-200">{row.key}</span>
                      {row.required && (
                        <span className="rounded border border-amber-500/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
                          Suggested
                        </span>
                      )}
                    </div>
                    <div className={`mt-1 text-[11px] ${filled || saved ? 'text-emerald-400' : 'text-zinc-500'}`}>
                      {rowStatusLabel(row, saved)}
                    </div>
                  </div>
                  <input
                    type={filled ? 'text' : 'password'}
                    value={row.value}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDrafts((prev) => prev.map((item) => (item.key === row.key ? { ...item, value } : item)));
                    }}
                    placeholder={saved ? 'Enter new value to rotate' : 'Enter secret value'}
                    className="w-full rounded-md border border-white/10 bg-black px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:border-white/25"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => void deleteKey(row.key)}
                    disabled={saving || (!saved && !row.value)}
                    className="inline-flex items-center justify-center rounded-md border border-white/10 px-3 py-2 text-zinc-400 hover:border-red-500/30 hover:text-red-300 disabled:opacity-40"
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
            {drafts.length === 0 && !loading && (
              <div className="rounded-md border border-dashed border-white/10 px-3 py-6 text-center text-sm text-zinc-500">
                No secrets detected yet. Paste a .env block above or add keys manually.
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 border-t border-white/10 pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
            <input
              value={newKey}
              onChange={(event) => setNewKey(event.target.value)}
              placeholder="NEW_SECRET_KEY"
              className="w-full rounded-md border border-white/10 bg-[#09090b] px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:border-white/25"
            />
            <input
              type="password"
              value={newValue}
              onChange={(event) => setNewValue(event.target.value)}
              placeholder="value"
              className="w-full rounded-md border border-white/10 bg-[#09090b] px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:border-white/25"
              autoComplete="off"
            />
            <button type="button" onClick={addRow} className={`${secondaryButtonClass(false)} inline-flex items-center justify-center gap-2`}>
              <Plus className="h-4 w-4" /> Add
            </button>
          </div>

          <div className="flex flex-wrap gap-3 pt-2">
            <button
              type="button"
              onClick={() => void saveDrafts()}
              disabled={saving || !hasAwsCredentials || pendingSaveCount === 0}
              className={`${secondaryButtonClass(saving || !hasAwsCredentials || pendingSaveCount === 0)} min-w-[140px]`}
            >
              {saving ? 'Saving…' : pendingSaveCount > 0 ? `Save ${pendingSaveCount} to AWS` : 'Save to AWS'}
            </button>
            <button
              type="button"
              onClick={() => void handleContinue()}
              disabled={!continueEnabled}
              className={`${accentButtonClass(!continueEnabled)} min-w-[180px]`}
            >
              {saving
                ? 'Saving…'
                : !hasAwsCredentials
                  ? 'Re-enter AWS credentials'
                  : pendingSaveCount > 0
                    ? 'Save & continue to Deploy'
                    : 'Continue to Deploy'}
            </button>
          </div>
          {proceedBlocker && (
            <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              {proceedBlocker}
            </div>
          )}
        </Surface>

        <div className="space-y-4">
          <Surface>
            <SurfaceLabel>How it works</SurfaceLabel>
            <ul className="mt-2 space-y-2 text-xs leading-relaxed text-zinc-400">
              <li>Paste a full <span className="font-mono text-zinc-300">.env</span> block — rows fill immediately.</li>
              <li>Use <span className="text-zinc-300">Continue to Deploy</span> anytime — secrets are optional. Save what you have; add more later if needed.</li>
              <li>After save, values stay marked as set (plaintext is cleared from this page).</li>
            </ul>
          </Surface>
          {(publicAppUrl || oauthCallbackPaths.length > 0) && (
            <Surface>
              <SurfaceLabel>OAuth callbacks</SurfaceLabel>
              {publicAppUrl ? (
                <p className="mt-2 break-all font-mono text-xs text-zinc-300">{publicAppUrl}</p>
              ) : (
                <p className="mt-2 text-xs text-zinc-500">Public URL appears on Outputs after the first deploy.</p>
              )}
              {oauthCallbackPaths.length > 0 && (
                <ul className="mt-3 space-y-1 font-mono text-[11px] text-zinc-400">
                  {oauthCallbackPaths.map((path) => (
                    <li key={path}>{publicAppUrl ? `${publicAppUrl.replace(/\/$/, '')}${path}` : path}</li>
                  ))}
                </ul>
              )}
            </Surface>
          )}
        </div>
      </div>
    </div>
  );
}
