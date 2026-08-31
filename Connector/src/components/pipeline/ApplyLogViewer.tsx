'use client';

import { useCallback, useEffect, useState } from 'react';
import { Callout, Panel, ProgressBar } from '@/features/deployment/deployment-ui';
import {
  ProcessStatusTrack,
  TERRAFORM_APPLY_STEPS,
  TERRAFORM_APPLY_STATUS_LABEL,
  normalizeProcessPhase,
  progressForProcessPhase,
} from '@/components/pipeline/ProcessStatusTrack';

type RunStatus =
  | 'pending'
  | 'selecting_params'
  | 'validating'
  | 'planning'
  | 'applying'
  | 'completed'
  | 'failed';

interface ApplyLogViewerProps {
  runId: string;
  onComplete: (outputs: object, keypair?: object | null) => void;
  onError: (error: string) => void;
  onStatusChange?: (status: string, message?: string | null) => void;
  hideUi?: boolean;
}

function isFailedStatus(status: unknown): boolean {
  return String(status || '').trim().toLowerCase() === 'failed';
}

function statusMessageForPhase(phase: string, errorMessage?: string | null): string {
  if (errorMessage) return errorMessage;
  return TERRAFORM_APPLY_STATUS_LABEL[normalizeProcessPhase(phase)] || 'Processing deployment…';
}

export function ApplyLogViewer({
  runId,
  onComplete,
  onError,
  onStatusChange,
  hideUi = false,
}: ApplyLogViewerProps) {
  const [status, setStatus] = useState<RunStatus>('pending');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const reportStatus = useCallback((nextStatus: string, message?: string | null) => {
    onStatusChange?.(nextStatus, message ?? null);
  }, [onStatusChange]);

  useEffect(() => {
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    let consecutiveErrors = 0;

    const finishError = (message: string) => {
      if (settled) return;
      settled = true;
      if (pollInterval) clearInterval(pollInterval);
      setErrorMessage(message);
      setStatus('failed');
      reportStatus('failed', message);
      onError(message);
    };

    const finishComplete = (outputs: object, keypair?: object | null) => {
      if (settled) return;
      settled = true;
      if (pollInterval) clearInterval(pollInterval);
      setStatus('completed');
      reportStatus('completed', TERRAFORM_APPLY_STATUS_LABEL.completed);
      onComplete(outputs, keypair ?? null);
    };

    const applyPayload = (data: {
      status?: string;
      outputs?: object;
      keypair?: object | null;
      error?: string | null;
    }) => {
      if (data.status) {
        const nextStatus = data.status as RunStatus;
        setStatus(nextStatus);
        reportStatus(nextStatus, statusMessageForPhase(nextStatus, data.error));
      }
      if (data.status === 'completed') {
        finishComplete(data.outputs || {}, data.keypair ?? null);
        return;
      }
      if (isFailedStatus(data.status)) {
        finishError(data.error || 'Unknown error');
      }
    };

    const pollOnce = async () => {
      try {
        const res = await fetch(`/api/pipeline/iac-status/${runId}`);
        if (!res.ok) {
          consecutiveErrors++;
          if (consecutiveErrors >= 5) {
            finishError(`Backend status check failed repeatedly (${res.status}).`);
          }
          return;
        }

        consecutiveErrors = 0;
        const data = await res.json();
        applyPayload(data);
      } catch {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          finishError('Network error checking status repeatedly.');
        }
      }
    };

    void pollOnce();
    pollInterval = setInterval(() => {
      void pollOnce();
    }, 3000);

    return () => {
      settled = true;
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [onComplete, onError, reportStatus, runId]);

  if (hideUi) {
    return null;
  }

  const normalizedPhase = normalizeProcessPhase(status);
  const progress = status === 'failed'
    ? 100
    : progressForProcessPhase(status, TERRAFORM_APPLY_STEPS);

  return (
    <Panel className="flex flex-col gap-4" elevation="raised" glow={status === 'applying' || status === 'planning'}>
      <ProgressBar
        value={progress}
        tone={status === 'failed' ? 'danger' : status === 'completed' ? 'ok' : 'accent'}
        indeterminate={status !== 'completed' && status !== 'failed' && normalizedPhase === 'starting'}
      />
      <ProcessStatusTrack
        steps={TERRAFORM_APPLY_STEPS}
        activePhase={status}
        failed={status === 'failed'}
        statusMessage={statusMessageForPhase(status, errorMessage)}
      />
      {status === 'failed' && (
        <Callout tone="danger">
          {errorMessage || 'Deployment failed. Check workspace sessions or contact your operator for backend logs.'}
        </Callout>
      )}
    </Panel>
  );
}
