'use client';

import { useEffect, useState } from 'react';
import { Callout, LogConsole, Panel, ProgressBar, StatusPill } from '@/features/deployment/deployment-ui';

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
}

const STATUS_STEPS: RunStatus[] = [
  'pending',
  'selecting_params',
  'validating',
  'planning',
  'applying',
  'completed',
];

const STATUS_LABEL: Record<RunStatus, string> = {
  pending: 'Starting...',
  selecting_params: 'Selecting parameters',
  validating: 'Validating configuration',
  planning: 'Planning changes',
  applying: 'Applying to AWS',
  completed: 'Complete',
  failed: 'Failed',
};

function isFailedStatus(status: unknown): boolean {
  return String(status || '').trim().toLowerCase() === 'failed';
}

export function ApplyLogViewer({ runId, onComplete, onError }: ApplyLogViewerProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<RunStatus>('pending');

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
      onError(message);
    };

    const finishComplete = (outputs: object, keypair?: object | null) => {
      if (settled) return;
      settled = true;
      if (pollInterval) clearInterval(pollInterval);
      ws?.close();
      onComplete(outputs, keypair);
    };

    const applyPayload = (data: {
      logs?: string[];
      status?: string;
      outputs?: object;
      keypair?: object | null;
      error?: string | null;
    }) => {
      if (Array.isArray(data.logs)) {
        setLogs(data.logs);
      }
      if (data.status) {
        setStatus(data.status as RunStatus);
      }
      if (data.status === 'completed') {
        finishComplete(data.outputs || {}, data.keypair ?? null);
        return;
      }
      if (isFailedStatus(data.status)) {
        finishError(data.error || 'Unknown error');
      }
    };

    function startPolling() {
      if (pollInterval || settled) return;
      pollInterval = setInterval(async () => {
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
      }, 3000);
    }

    // The Next.js iac-ws-proxy route cannot upgrade WebSockets, so polling is the
    // reliable completion path. Keep WS as a best-effort live log stream.
    startPolling();

    try {
      ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'log') {
          setLogs((prev) => [...prev, msg.data]);
        }
        if (msg.type === 'status') {
          setStatus(msg.data as RunStatus);
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
  }, [runId, onComplete, onError]);

  const currentStep = STATUS_STEPS.indexOf(status);
  const visibleSteps = STATUS_STEPS.filter((s) => s !== 'pending');
  const progress = status === 'failed'
    ? 100
    : Math.round((Math.max(currentStep, 0) / Math.max(STATUS_STEPS.length - 1, 1)) * 100);

  return (
    <Panel className="flex flex-col gap-4" elevation="raised" glow={status === 'applying' || status === 'planning'}>
      <ProgressBar
        value={progress}
        tone={status === 'failed' ? 'danger' : status === 'completed' ? 'ok' : 'accent'}
        indeterminate={status !== 'completed' && status !== 'failed' && currentStep < 1}
      />
      <div className="flex flex-wrap items-center gap-2">
        {visibleSteps.map((step, i) => {
          const stepIndex = STATUS_STEPS.indexOf(step);
          const done = currentStep > stepIndex;
          const active = currentStep === stepIndex;
          return (
            <div key={step} className="flex items-center gap-2">
              <StatusPill
                tone={done ? 'ok' : active ? (status === 'failed' ? 'danger' : 'accent') : 'neutral'}
                live={active && status !== 'failed'}
              >
                {STATUS_LABEL[step]}
              </StatusPill>
              {i < visibleSteps.length - 1 && (
                <span
                  className={`h-px w-6 ${done ? 'bg-[var(--dw-accent)]' : 'bg-[var(--dw-border)]'}`}
                  aria-hidden="true"
                />
              )}
            </div>
          );
        })}
      </div>

      <LogConsole
        lines={logs.map((line) => ({
          text: line,
          tone: line.startsWith('✗') ? 'danger' : line.startsWith('✓') ? 'ok' : 'neutral',
        }))}
        streaming={status !== 'completed' && status !== 'failed'}
        emptyLabel="Waiting for output…"
        maxHeight="16rem"
      />

      {status === 'failed' && (
        <Callout tone="danger">Deployment failed. See logs above for details.</Callout>
      )}
    </Panel>
  );
}
