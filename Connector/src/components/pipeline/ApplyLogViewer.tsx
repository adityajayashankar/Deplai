'use client';

import { useEffect, useRef, useState } from 'react';

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

export function ApplyLogViewer({ runId, onComplete, onError }: ApplyLogViewerProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<RunStatus>('pending');
  const logEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom as logs arrive
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    // Try WebSocket first (real-time), fall back to polling
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/pipeline/iac-ws-proxy/${runId}`;

    let ws: WebSocket | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    function startPolling() {
      pollInterval = setInterval(async () => {
        try {
          const res = await fetch(`/api/pipeline/iac-status/${runId}`);
          const data = await res.json();

          if (data.logs) {
            setLogs(data.logs);
          }
          setStatus(data.status as RunStatus);

          if (data.status === 'completed') {
            clearInterval(pollInterval!);
            onComplete(data.outputs, data.keypair ?? null);
          }
          if (data.status === 'failed') {
            clearInterval(pollInterval!);
            onError(data.error ?? 'Unknown error');
          }
        } catch {
          // silently retry
        }
      }, 3000);
    }

    try {
      ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'log') {
          setLogs((prev) => [...prev, msg.data]);
        }
        if (msg.type === 'status') {
          setStatus(msg.data as RunStatus);
        }
        if (msg.type === 'done') {
          setStatus(msg.data as RunStatus);
          if (msg.data === 'completed') {
            onComplete(msg.outputs, msg.keypair ?? null);
          } else {
            onError(msg.error ?? 'Apply failed');
          }
        }
      };

      ws.onerror = () => {
        ws?.close();
        startPolling();
      };
    } catch {
      startPolling();
    }

    return () => {
      ws?.close();
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [runId, onComplete, onError]);

  const currentStep = STATUS_STEPS.indexOf(status);

  return (
    <div className="flex flex-col gap-4">
      {/* Progress stepper */}
      <div className="flex items-center gap-2 flex-wrap">
        {STATUS_STEPS.filter((s) => s !== 'pending').map((step, i) => {
          const stepIndex = STATUS_STEPS.indexOf(step);
          const done = currentStep > stepIndex;
          const active = currentStep === stepIndex;
          return (
            <div key={step} className="flex items-center gap-2">
              <div
                className={`
                w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold
                ${done ? 'bg-green-500 text-white' : ''}
                ${active ? 'bg-blue-500 text-white animate-pulse' : ''}
                ${!done && !active ? 'bg-gray-200 text-gray-500' : ''}
              `}
              >
                {done ? '✓' : i + 1}
              </div>
              <span className={`text-sm ${active ? 'font-semibold' : 'text-gray-500'}`}>
                {STATUS_LABEL[step]}
              </span>
              {i < STATUS_STEPS.length - 2 && (
                <div className={`h-px w-6 ${done ? 'bg-green-500' : 'bg-gray-200'}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Terminal log viewer */}
      <div className="bg-gray-950 rounded-lg p-4 h-64 overflow-y-auto font-mono text-xs text-green-400">
        {logs.length === 0 && <span className="text-gray-500">Waiting for output...</span>}
        {logs.map((line, i) => (
          <div
            key={i}
            className={
              line.startsWith('✗')
                ? 'text-red-400'
                : line.startsWith('✓')
                  ? 'text-green-300'
                  : ''
            }
          >
            {line}
          </div>
        ))}
        <div ref={logEndRef} />
      </div>

      {status === 'failed' && (
        <p className="text-red-500 text-sm">Deployment failed. See logs above for details.</p>
      )}
    </div>
  );
}
