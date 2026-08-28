'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CircleDashed, RefreshCw, RotateCcw, Square, Terminal } from 'lucide-react';
import {
  Callout,
  Chip,
  Panel,
  PanelHeader,
  SectionLabel,
  StatusPill,
  buttonClass,
  fieldClass,
  fieldLabelClass,
  type Tone,
} from '@/features/deployment/deployment-ui';
import { coerceHttpAppPort } from '@/features/deployment/http-ports';

type TimelineStep = {
  id: string;
  label: string;
  events: string[];
};

const STEPS: TimelineStep[] = [
  { id: 'infra', label: 'Infrastructure Ready', events: [] },
  { id: 'env', label: 'Environment Validated', events: ['TARGET_VALIDATED'] },
  { id: 'artifact', label: 'Artifact Validated', events: ['ARTIFACT_VALIDATED', 'BLUEPRINT_VALIDATED', 'CONTRACT_VALIDATED'] },
  { id: 'lock', label: 'Environment Locked', events: ['LOCK_ACQUIRED'] },
  { id: 'host', label: 'Host Ready', events: ['SSM_CONNECTIVITY_OK', 'HOST_DISCOVERY_COMPLETE', 'HOST_PREPARATION', 'HOST_READY', 'PREFLIGHT_READY', 'PREFLIGHT_PASSED'] },
  { id: 'pull', label: 'Artifact Pulled', events: ['ECR_AUTHENTICATED', 'ARTIFACT_PULL_STARTED', 'IMAGE_PULL_COMPLETE', 'ARTIFACT_PULL_COMPLETED'] },
  { id: 'start', label: 'Application Started', events: ['APPLICATION_STOPPED', 'APPLICATION_STARTING', 'APPLICATION_STARTED', 'RUNTIME_VERIFIED'] },
  { id: 'health', label: 'Health Check', events: ['HEALTH_CHECK_STARTED', 'HEALTH_CHECK_PASSED', 'HEALTH_CHECK_FAILED'] },
  { id: 'external', label: 'External Endpoint', events: ['EXTERNAL_ENDPOINT_VERIFIED'] },
  { id: 'smoke', label: 'Smoke Test', events: ['SMOKE_TEST_STARTED', 'SMOKE_TEST_PASSED'] },
  { id: 'dast', label: 'Post-Deploy Security', events: ['DAST_STARTED', 'DEPLOYMENT_VERIFIED'] },
  { id: 'done', label: 'Deployment Complete', events: ['DEPLOYMENT_COMPLETED', 'ROLLBACK_COMPLETED', 'ROLLBACK_FAILED', 'DEPLOYMENT_FAILED'] },
];

type DeployRecord = {
  deployment_id?: string;
  status?: string;
  stage?: string;
  result?: string;
  result_class?: string;
  plan_preview?: Record<string, unknown>;
  snapshot?: Record<string, unknown> | null;
  snapshot_hash?: string;
  previous_digest?: string;
  error?: { code?: string; user_message?: string; recommended_action?: string } | null;
  events?: Array<{ event?: string; timestamp?: string; snapshot_hash?: string }>;
  public_endpoint?: string;
};

function toneFor(status?: string, result?: string): Tone {
  const value = String(status || '').toUpperCase();
  const klass = String(result || '').toUpperCase();
  if (value === 'COMPLETED' && klass === 'SUCCESS') return 'ok';
  if (value === 'ROLLED_BACK' || klass === 'ROLLED_BACK') return 'warn';
  if (value === 'FAILED' || value === 'CANCELLED' || klass === 'ROLLBACK_FAILED' || klass === 'SECURITY_BLOCKED') return 'danger';
  if (value && value !== 'CREATED') return 'accent';
  return 'neutral';
}

function stepState(step: TimelineStep, events: string[], status?: string): 'done' | 'live' | 'pending' | 'error' {
  if (step.id === 'infra') return 'done';
  const hit = step.events.some((name) => events.includes(name));
  if (step.events.includes('HEALTH_CHECK_FAILED') && events.includes('HEALTH_CHECK_FAILED') && step.id === 'health') return 'error';
  if (step.events.includes('ROLLBACK_FAILED') && events.includes('ROLLBACK_FAILED') && step.id === 'done') return 'error';
  if (hit && (step.id !== 'done' || ['COMPLETED', 'ROLLED_BACK'].includes(String(status || '').toUpperCase()))) return 'done';
  const live = ['APPLICATION_DEPLOYING', 'APPLICATION_STARTED', 'HOST_READY', 'ARTIFACT_READY'].includes(String(status || ''));
  if (live && !hit) {
    if (step.id === 'start' && String(status).includes('APPLICATION')) return 'live';
    if (step.id === 'health' && status === 'APPLICATION_STARTED') return 'live';
  }
  return hit ? 'done' : 'pending';
}

export function AppDeployPanel({
  projectId,
  environmentId,
  instanceId,
  region,
  accountId,
  publicEndpoint,
  defaultImage = '',
  defaultContainerPort = '3000',
  defaultHostPort = '80',
  defaultHealthEndpoint = '/health',
  awsAccessKeyId,
  awsSecretAccessKey,
  awsSessionToken,
}: {
  projectId: string;
  environmentId: string;
  instanceId: string;
  region: string;
  accountId?: string;
  publicEndpoint?: string;
  defaultImage?: string;
  defaultContainerPort?: string;
  defaultHostPort?: string;
  defaultHealthEndpoint?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
}) {
  const [image, setImage] = useState(defaultImage);
  const [digest, setDigest] = useState('');
  const [previousDigest, setPreviousDigest] = useState('');
  const [containerPort, setContainerPort] = useState(String(coerceHttpAppPort(defaultContainerPort, 3000)));
  const [hostPort, setHostPort] = useState(defaultHostPort || '80');
  const [healthEndpoint, setHealthEndpoint] = useState(defaultHealthEndpoint || '/health');
  const [imageTouched, setImageTouched] = useState(false);
  const [digestTouched, setDigestTouched] = useState(false);
  const [hydrateNote, setHydrateNote] = useState('');
  const [hydrating, setHydrating] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [record, setRecord] = useState<DeployRecord | null>(null);
  const [logs, setLogs] = useState<Array<{ text?: string; timestamp?: string }>>([]);

  const creds = useMemo(() => ({
    aws_access_key_id: awsAccessKeyId || '',
    aws_secret_access_key: awsSecretAccessKey || '',
    aws_session_token: awsSessionToken || '',
    aws_region: region,
    account_id: accountId || '',
  }), [accountId, awsAccessKeyId, awsSecretAccessKey, awsSessionToken, region]);

  const payload = useCallback((dryRun = false) => ({
    project_id: projectId,
    environment_id: environmentId,
    instance_id: instanceId,
    region,
    image: image.trim(),
    digest: digest.trim().toLowerCase(),
    previous_digest: previousDigest.trim().toLowerCase() || undefined,
    container_port: coerceHttpAppPort(containerPort, 3000),
    host_port: Number(hostPort) || 80,
    health_endpoint: healthEndpoint || '/health',
    public_endpoint: publicEndpoint || '',
    dry_run: dryRun,
    ...creds,
  }), [containerPort, creds, digest, environmentId, healthEndpoint, hostPort, image, instanceId, previousDigest, projectId, publicEndpoint, region]);

  const refresh = useCallback(async (id: string) => {
    const response = await fetch(`/api/deploy-exec/${encodeURIComponent(id)}`);
    const data = await response.json().catch(() => ({}));
    if (response.ok) setRecord((data.deployment || data) as DeployRecord);
    if (showLogs) {
      const logsRes = await fetch(`/api/deploy-exec/${encodeURIComponent(id)}/logs`);
      const logsData = await logsRes.json().catch(() => ({}));
      setLogs(Array.isArray(logsData.logs) ? logsData.logs : []);
    }
  }, [showLogs]);

  useEffect(() => {
    if (!imageTouched && defaultImage) setImage(defaultImage);
  }, [defaultImage, imageTouched]);

  useEffect(() => {
    if (defaultContainerPort) setContainerPort(String(coerceHttpAppPort(defaultContainerPort, 3000)));
  }, [defaultContainerPort]);

  useEffect(() => {
    if (defaultHostPort) setHostPort(defaultHostPort);
  }, [defaultHostPort]);

  useEffect(() => {
    if (defaultHealthEndpoint) setHealthEndpoint(defaultHealthEndpoint);
  }, [defaultHealthEndpoint]);

  useEffect(() => {
    if (!projectId) return undefined;
    let cancelled = false;
    setHydrating(true);
    void (async () => {
      try {
        const response = await fetch('/api/deploy-exec/defaults', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            environment_id: environmentId,
            image: defaultImage,
            ...creds,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (!response.ok) {
          setHydrateNote(String(data.note || data.error || 'Could not load artifact defaults.'));
          return;
        }
        if (!imageTouched && data.image) setImage(String(data.image));
        if (!digestTouched && data.digest) setDigest(String(data.digest));
        if (data.previous_digest) setPreviousDigest(String(data.previous_digest));
        setHydrateNote(
          String(
            data.note
            || (data.digest
              ? 'Filled from this environment and the latest ECR image.'
              : defaultImage
                ? 'No image in ECR yet. Redeploy infrastructure to build the app on the instance from your repository. This panel is optional until DeplAI has pushed an image.'
                : 'Waiting for an ECR repository URL from this environment.'),
          ),
        );
      } catch (reason) {
        if (!cancelled) setHydrateNote(reason instanceof Error ? reason.message : '');
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [creds, defaultImage, environmentId, projectId]);

  useEffect(() => {
    const id = String(record?.deployment_id || '').trim();
    const status = String(record?.status || '').toUpperCase();
    if (!id || ['COMPLETED', 'FAILED', 'CANCELLED', 'ROLLED_BACK', 'ROLLBACK_FAILED'].includes(status)) return undefined;
    const timer = window.setInterval(() => {
      void refresh(id);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [record?.deployment_id, record?.status, refresh]);

  async function run(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = data.detail && typeof data.detail === 'object' ? data.detail as { user_message?: string; technical_message?: string } : null;
        throw new Error(detail?.user_message || detail?.technical_message || (typeof data.detail === 'string' ? data.detail : '') || data.error || 'Deployment failed');
      }
      setRecord(data.deployment || data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Deployment failed');
    } finally {
      setBusy(false);
    }
  }

  const events = (record?.events || []).map((item) => String(item.event || ''));
  const status = String(record?.status || '');
  const preview = record?.plan_preview || null;
  const snapshot = record?.snapshot || null;
  const canAct = Boolean(record?.deployment_id);
  const result = String(record?.result_class || record?.result || '');
  const running = Boolean(status) && !['COMPLETED', 'FAILED', 'CANCELLED', 'ROLLED_BACK', 'ROLLBACK_FAILED', ''].includes(status.toUpperCase());
  const inputsLocked = busy || running;
  const digestReady = /^sha256:[a-f0-9]{64}$/i.test(digest.trim());

  return (
    <Panel className="mt-6 space-y-5" elevation="raised">
      <PanelHeader
        title="Application deploy"
        icon={<Terminal className="h-3.5 w-3.5" />}
        tone="info"
        actions={<StatusPill tone={toneFor(status, result)} live={running}>{status || 'idle'}{result ? ` · ${result}` : ''}</StatusPill>}
      />
      <Callout tone="info">
        Infrastructure is live. First deploy already builds and starts the app on this instance from your repository — no Docker push and no PEM. Use this panel later only if you have an immutable ECR image to roll forward.
      </Callout>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="block">
          <span className={fieldLabelClass()}>ECR image URI</span>
          <input className={fieldClass(inputsLocked)} disabled={inputsLocked} value={image} onChange={(event) => { setImageTouched(true); setImage(event.target.value); }} placeholder="Filled from this environment’s ECR repository" />
        </label>
        <label className="block">
          <span className={fieldLabelClass()}>Immutable digest</span>
          <input className={fieldClass(inputsLocked)} disabled={inputsLocked} value={digest} onChange={(event) => { setDigestTouched(true); setDigest(event.target.value); }} placeholder="Filled from the latest image in ECR" />
        </label>
        <label className="block">
          <span className={fieldLabelClass()}>Previous digest (rollback)</span>
          <input className={fieldClass(inputsLocked)} disabled={inputsLocked} value={previousDigest} onChange={(event) => setPreviousDigest(event.target.value)} placeholder="Filled from the last successful deploy" />
        </label>
        <label className="block">
          <span className={fieldLabelClass()}>Health endpoint</span>
          <input className={fieldClass(inputsLocked)} disabled={inputsLocked} value={healthEndpoint} onChange={(event) => setHealthEndpoint(event.target.value)} />
        </label>
        <label className="block">
          <span className={fieldLabelClass()}>Container port</span>
          <input className={fieldClass(inputsLocked)} disabled={inputsLocked} value={containerPort} onChange={(event) => setContainerPort(event.target.value)} />
        </label>
        <label className="block">
          <span className={fieldLabelClass()}>Host port</span>
          <input className={fieldClass(inputsLocked)} disabled={inputsLocked} value={hostPort} onChange={(event) => setHostPort(event.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Chip>Environment {environmentId}</Chip>
        <Chip>Target EC2</Chip>
        <Chip>{instanceId}</Chip>
        <Chip>{region}</Chip>
        {hydrating ? <Chip>Loading artifact…</Chip> : null}
      </div>
      {hydrateNote ? <Callout tone="info">{hydrateNote}</Callout> : null}
      {preview || snapshot ? (
        <div className="space-y-1 text-[12px] text-[var(--dw-muted)]">
          <SectionLabel>Frozen plan</SectionLabel>
          <div>Account: {String(snapshot?.target && typeof snapshot.target === 'object' ? (snapshot.target as { account_id?: string }).account_id : preview?.account_id || accountId || '')} · Region: {String(preview?.region || region)}</div>
          <div>Artifact: {String(preview?.artifact || snapshot?.image || '')}</div>
          <div>Digest: {String(preview?.digest || snapshot?.digest || digest || '')}</div>
          <div>Previous: {String(preview?.previous_version || snapshot?.previous_digest || record?.previous_digest || previousDigest || 'none')}</div>
          <div>Execution: {String(preview?.execution || 'AWS SSM')} · Strategy: {String(preview?.strategy || 'Replace')}</div>
          <div>Health: {String(preview?.health_check || '/health')} · Rollback: {String(preview?.rollback || '')}</div>
          {record?.snapshot_hash ? <div>Snapshot: {String(record.snapshot_hash).slice(0, 16)}…</div> : null}
        </div>
      ) : null}
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {record?.error?.user_message ? (
        <Callout tone="danger" title={record.error.code || 'Deployment failed'}>
          <div>{record.error.user_message}</div>
          {record.error.recommended_action ? <div className="mt-1">{record.error.recommended_action}</div> : null}
        </Callout>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || running} onClick={() => void run('/api/deploy-exec/preflight', payload(true))} className={buttonClass('secondary', { disabled: busy || running })}>
          Preflight
        </button>
        <button type="button" disabled={busy || running || !image || !digestReady} onClick={() => void run('/api/deploy-exec', payload(false))} className={buttonClass('primary', { disabled: busy || running || !image || !digestReady })}>
          {busy ? <CircleDashed className="h-4 w-4 animate-spin" /> : null}
          Deploy image
        </button>
        <button type="button" disabled={busy || !canAct || !running} onClick={() => void run(`/api/deploy-exec/${record?.deployment_id}/cancel`, creds)} className={buttonClass('danger', { disabled: busy || !canAct || !running })}>
          <Square className="h-3.5 w-3.5" /> Cancel
        </button>
        <button type="button" disabled={busy || !canAct || running} onClick={() => void run(`/api/deploy-exec/${record?.deployment_id}/retry`, creds)} className={buttonClass('secondary', { disabled: busy || !canAct || running })}>
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </button>
        <button type="button" disabled={busy || !canAct || running || !previousDigest} onClick={() => void run(`/api/deploy-exec/${record?.deployment_id}/rollback`, creds)} className={buttonClass('secondary', { disabled: busy || !canAct || running || !previousDigest })}>
          <RotateCcw className="h-3.5 w-3.5" /> Rollback
        </button>
        <button type="button" disabled={!canAct} onClick={() => { setShowLogs(true); if (record?.deployment_id) void refresh(record.deployment_id); }} className={buttonClass('ghost', { disabled: !canAct })}>
          View logs
        </button>
      </div>
      <div className="space-y-2">
        <SectionLabel>Execution timeline</SectionLabel>
        <ol className="space-y-2">
          {STEPS.map((step) => {
            const state = stepState(step, events, status);
            return (
              <li key={step.id} className="flex items-start gap-3 text-[13px]">
                {state === 'done' ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-[var(--dw-ok)]" /> : state === 'live' ? <CircleDashed className="mt-0.5 h-4 w-4 animate-spin text-[var(--dw-accent)]" /> : <span className="mt-1 h-2.5 w-2.5 rounded-full border border-black" />}
                <div>
                  <div className={state === 'error' ? 'text-[var(--dw-danger)]' : 'text-[var(--dw-fg)]'}>{step.label}</div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      {showLogs ? (
        <div className="max-h-48 overflow-auto font-mono text-[11px] text-[var(--dw-muted)]">
          {logs.length === 0 ? <div>No logs yet.</div> : logs.map((line, index) => (
            <div key={`${line.timestamp}-${index}`}>{line.text}</div>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
