'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  Callout,
  Chip,
  EmptyState,
  Panel,
  SectionLabel,
  StageHeader,
  StickyActionBar,
  accentButtonClass,
  buttonClass,
  fieldClass,
  paperInsetClass,
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
      const message = err instanceof Error ? err.message : 'Failed to list secrets';
      setError(`${message} You can skip this step if the app does not need secrets.`);
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

  const handleSkip = async () => {
    if (!hasAwsCredentials) {
      onBackToAwsConfig?.();
      return;
    }
    if (!canContinueToDeploy) return;
    await onContinueToDeploy();
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
        eyebrow="Stage 06 · Secrets (optional)"
        title="App secrets"
        description={`Optional. Store OAuth and API keys in AWS Secrets Manager for ${projectName} when the app needs them. Skip this step for static sites, blogs, or CloudFront-only deploys — values are write-only after save and never committed to git or Terraform.`}
      />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Panel className="space-y-4 xl:col-span-2" elevation="raised">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="font-mono text-[11px] text-[var(--dw-muted)]">Prefix: {secretsPrefix || '—'}</div>
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
            <Callout tone="warn">Complete AWS Config with access key and secret key first. You can still skip this step after credentials are saved.</Callout>
          )}

          {error && (
            <Callout tone="warn">{error}</Callout>
          )}

          {missingRequired.length > 0 && (
            <Callout tone="info">
              Suggested secrets not set yet: {missingRequired.join(', ')}. Skip if this app does not need them (for example a static site or CloudFront blog). Login/features that need these keys may fail until you add them later.
            </Callout>
          )}

          {pendingSaveCount > 0 && (
            <Callout tone="ok">
              {pendingSaveCount} secret{pendingSaveCount === 1 ? '' : 's'} ready in the form. “Save & continue” will store them in AWS, then open Deploy.
            </Callout>
          )}

          <div className={`space-y-2 ${paperInsetClass} p-3.5`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--dw-faint)]">Paste all secrets</span>
              <span className="text-[11px] text-[var(--dw-faint)]">Paste fills the form automatically</span>
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
              className={`${fieldClass()} resize-y leading-relaxed`}
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
              <div className="text-[12px] text-[var(--dw-fg-soft)]">{bulkHint}</div>
            )}
          </div>

          <div className="space-y-3">
            {drafts.map((row) => {
              const meta = remote.find((item) => item.key === row.key);
              const filled = Boolean(row.value.trim());
              const saved = Boolean(meta?.is_set) || knownSetKeysRef.current.has(row.key);
              return (
                <div key={row.key} className={`grid grid-cols-1 gap-2 ${paperInsetClass} p-3.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]`}>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[13px] text-[var(--dw-fg)]">{row.key}</span>
                      {row.required && (
                        <Chip tone="warn">Suggested</Chip>
                      )}
                    </div>
                    <div className={`mt-1 text-[11px] ${filled || saved ? 'text-[var(--dw-ok)]' : 'text-[var(--dw-muted)]'}`}>
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
                    className={fieldClass()}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => void deleteKey(row.key)}
                    disabled={saving || (!saved && !row.value)}
                    className={buttonClass('ghost', { disabled: saving || (!saved && !row.value) })}
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
            {drafts.length === 0 && !loading && (
              <EmptyState
                title="No secrets yet — that's fine"
                description="Skip this step for a static site or CloudFront blog. Paste a .env block or add keys only if the app needs them."
              />
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 border-t border-[var(--dw-border)] pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
            <input
              value={newKey}
              onChange={(event) => setNewKey(event.target.value)}
              placeholder="NEW_SECRET_KEY"
              className={fieldClass()}
            />
            <input
              type="password"
              value={newValue}
              onChange={(event) => setNewValue(event.target.value)}
              placeholder="value"
              className={fieldClass()}
              autoComplete="off"
            />
            <button type="button" onClick={addRow} className={`${secondaryButtonClass(false)} inline-flex items-center justify-center gap-2`}>
              <Plus className="h-4 w-4" /> Add
            </button>
          </div>
          {proceedBlocker && (
            <Callout tone="warn">{proceedBlocker}</Callout>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel>
            <SectionLabel>How it works</SectionLabel>
            <ul className="mt-2 space-y-2 text-[12.5px] leading-relaxed text-[var(--dw-muted)]">
              <li>Paste a full <span className="font-mono text-[var(--dw-fg-soft)]">.env</span> block — rows fill immediately.</li>
              <li>Secrets are optional. Use <span className="text-[var(--dw-fg)]">Skip secrets</span> for a blog or CloudFront-only deploy, or continue after saving what you have.</li>
              <li>After save, values stay marked as set (plaintext is cleared from this page).</li>
            </ul>
          </Panel>
          {(publicAppUrl || oauthCallbackPaths.length > 0) && (
            <Panel>
              <SectionLabel>OAuth callbacks</SectionLabel>
              {publicAppUrl ? (
                <p className="mt-2 break-all font-mono text-[12px] text-[var(--dw-fg-soft)]">{publicAppUrl}</p>
              ) : (
                <p className="mt-2 text-[12px] text-[var(--dw-muted)]">Public URL appears on Outputs after the first deploy.</p>
              )}
              {oauthCallbackPaths.length > 0 && (
                <ul className="mt-3 space-y-1 font-mono text-[11px] text-[var(--dw-muted)]">
                  {oauthCallbackPaths.map((path) => (
                    <li key={path}>{publicAppUrl ? `${publicAppUrl.replace(/\/$/, '')}${path}` : path}</li>
                  ))}
                </ul>
              )}
            </Panel>
          )}
        </div>
      </div>
      <StickyActionBar hint={proceedBlocker || (pendingSaveCount > 0 ? `${pendingSaveCount} unsaved value${pendingSaveCount === 1 ? '' : 's'} will be written to AWS on continue. Skip leaves them unsaved.` : 'Secrets are optional. Skip whenever you are ready to deploy.')}>
        <button
          type="button"
          onClick={() => void saveDrafts()}
          disabled={saving || !hasAwsCredentials || pendingSaveCount === 0}
          className={secondaryButtonClass(saving || !hasAwsCredentials || pendingSaveCount === 0)}
        >
          {saving ? 'Saving…' : pendingSaveCount > 0 ? `Save ${pendingSaveCount} to AWS` : 'Save to AWS'}
        </button>
        <button
          type="button"
          onClick={() => void handleSkip()}
          disabled={!continueEnabled}
          className={secondaryButtonClass(!continueEnabled)}
        >
          Skip secrets
        </button>
        <button
          type="button"
          onClick={() => void handleContinue()}
          disabled={!continueEnabled}
          className={accentButtonClass(!continueEnabled)}
        >
          {saving
            ? 'Saving…'
            : !hasAwsCredentials
              ? 'Re-enter AWS credentials'
              : pendingSaveCount > 0
                ? 'Save & continue to deploy'
                : 'Continue to deploy'}
        </button>
      </StickyActionBar>
    </div>
  );
}
