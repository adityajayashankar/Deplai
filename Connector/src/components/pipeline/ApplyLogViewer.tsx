'use client';

import { useCallback, useEffect, useState } from 'react';
import { Callout, LogConsole, Panel, ProgressBar } from '@/features/deployment/deployment-ui';
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
  onLogsChange?: (logs: string[]) => void;
  hideUi?: boolean;
}

function isFailedStatus(status: unknown): boolean {
  return String(status || '').trim().toLowerCase() === 'failed';
}

function statusMessageForPhase(phase: string, errorMessage?: string | null): string {
  if (errorMessage) return errorMessage;
  return TERRAFORM_APPLY_STATUS_LABEL[normalizeProcessPhase(phase)] || 'Processing deployment…';
}

function toLogLines(logs: string[]) {
  return logs.map((line) => ({
    text: line,
    tone: line.startsWith('✗') ? 'danger' as const : line.startsWith('✓') ? 'ok' as const : 'neutral' as const,
  }));
}

export function ApplyLogViewer({
  runId,
  onComplete,
  onError,
  onStatusChange,
  onLogsChange,
  hideUi = false,
}: ApplyLogViewerProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<RunStatus>('pending');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const reportStatus = useCallback((nextStatus: string, message?: string | null) => {
    onStatusChange?.(nextStatus, message ?? null);
  }, [onStatusChange]);

  const updateLogs = useCallback((next: string[]) => {
    setLogs(next);
    onLogsChange?.(next);
  }, [onLogsChange]);

  useEffect(() => {
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/pipeline/iac-ws-proxy/${runId}`;

    let ws: WebSocket | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    let consecutiveErrors = 0;

    const finishError = (message: string) => {
      if (settled) return;
      settled = true;
      if (pollInterval) clearInterval(pollInterval);
      ws?.close();
      setErrorMessage(message);
      setStatus('failed');
      reportStatus('failed', message);
      onError(message);
    };

    const finishComplete = (outputs: object, keypair?: object | null) => {
      if (settled) return;
      settled = true;
      if (pollInterval) clearInterval(pollInterval);
      ws?.close();
      setStatus('completed');
      reportStatus('completed', TERRAFORM_APPLY_STATUS_LABEL.completed);
      onComplete(outputs, keypair ?? null);
    };

    const applyPayload = (data: {
      logs?: string[];
      status?: string;
      outputs?: object;
      keypair?: object | null;
      error?: string | null;
    }) => {
      if (Array.isArray(data.logs)) {
        updateLogs(data.logs);
      }
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
    }, 2000);

    // The Next.js iac-ws-proxy route cannot upgrade WebSockets, so polling is the
    // reliable completion path. Keep WS as a best-effort live log stream.
    try {
      ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'log') {
          setLogs((prev) => {
            const next = [...prev, msg.data];
            onLogsChange?.(next);
            return next;
          });
        }
        if (msg.type === 'status') {
          setStatus(msg.data as RunStatus);
          reportStatus(msg.data, statusMessageForPhase(msg.data, msg.error));
          if (isFailedStatus(msg.data)) {
            finishError(msg.error || 'Apply failed');
          }
        }
        if (msg.type === 'done') {
          setStatus(msg.data as RunStatus);
          if (msg.data === 'completed') {
            finishComplete(msg.outputs, msg.keypair ?? null);
          } else {
            finishError(msg.error ?? 'Apply failed');
          }
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    } catch {
      // Polling already started.
    }

    return () => {
      settled = true;
      ws?.close();
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [onComplete, onError, onLogsChange, reportStatus, runId, updateLogs]);

  if (hideUi) {
    return null;
  }

  const normalizedPhase = normalizeProcessPhase(status);
  const progress = status === 'failed'
    ? 100
    : progressForProcessPhase(status, TERRAFORM_APPLY_STEPS);
  const streaming = status !== 'completed' && status !== 'failed';

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
      <LogConsole
        lines={toLogLines(logs)}
        streaming={streaming}
        emptyLabel="Waiting for output…"
        maxHeight="16rem"
      />
      {status === 'failed' && (
        <Callout tone="danger">
          {errorMessage || 'Deployment failed. See logs above for details.'}
        </Callout>
      )}
    </Panel>
  );
}
