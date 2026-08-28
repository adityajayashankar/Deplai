'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

interface AwsConsoleTerminalProps {
  instanceId: string;
  publicIp?: string;
  privateKey?: string;
  region: string;
  projectId?: string;
  projectName?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  onSimulationComplete?: () => void;
}

/** Returns true only when the value looks like a real routable IP, not a placeholder. */
function isValidIp(ip: string | undefined | null): ip is string {
  if (!ip) return false;
  const trimmed = ip.trim();
  if (!trimmed || trimmed === 'n/a' || trimmed === 'N/A' || trimmed === 'null' || trimmed === 'undefined') return false;
  // Must start with a digit (IPv4) or look like a hostname with dots
  return /^[\d.]+$/.test(trimmed) || (trimmed.includes('.') && trimmed.length > 4);
}

function hasUsablePrivateKey(privateKey?: string): boolean {
  const trimmed = String(privateKey || '').trim();
  if (!trimmed || trimmed === 'n/a' || trimmed === 'N/A') return false;
  return trimmed.includes('BEGIN') && trimmed.includes('PRIVATE KEY');
}

function connectUrl(region: string, instanceId: string): string {
  return `https://${region}.console.aws.amazon.com/ec2/home?region=${encodeURIComponent(region)}#ConnectToInstance:instanceId=${encodeURIComponent(instanceId)}`;
}

function waitingLines(publicIp?: string): string[] {
  return [
    '[System] Waiting for EC2 instance to become reachable...',
    `[System] Public IP: ${publicIp || 'pending'} — will retry automatically every 10s.`,
  ];
}

function missingKeyLines(publicIp?: string, instanceId?: string): string[] {
  return [
    '[System] This panel is a log tail, not a shell — you cannot type here.',
    `[System] Public IP: ${publicIp || 'pending'}. Instance: ${instanceId || 'unknown'}.`,
    '[System] No private PEM is available in this session. This deploy reused an existing EC2 key pair, and AWS never stores that private key.',
    '[System] Open Session Manager in AWS (Connect → Session Manager) to read /var/log/deplai-bootstrap-status.json and /var/log/cloud-init-output.log.',
  ];
}

function sameLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

export function AwsConsoleTerminal({
  instanceId,
  publicIp,
  privateKey,
  region,
  projectId,
  projectName = 'app',
  awsAccessKeyId,
  awsSecretAccessKey,
  awsSessionToken,
  onSimulationComplete,
}: AwsConsoleTerminalProps) {
  const [lines, setLines] = useState<string[]>([]);
  const terminalRef = useRef<HTMLDivElement>(null);
  const [isComplete, setIsComplete] = useState(false);

  const stickToBottomRef = useRef(true);

  const onTerminalScroll = useCallback(() => {
    const node = terminalRef.current;
    if (!node) return;
    stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
  }, []);

  // Keep the log pinned inside the terminal only. Never scroll the page.
  useEffect(() => {
    const node = terminalRef.current;
    if (!node || !stickToBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [lines]);

  const startStream = useCallback(async (signal: AbortSignal, ip: string, key: string) => {
    setLines([`[System] Initializing secure SSH tunnel to ${ip}...`]);
    try {
      const response = await fetch('/api/ec2/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ipAddress: ip,
          privateKey: key,
          projectId,
          instanceId,
          aws_access_key_id: awsAccessKeyId,
          aws_secret_access_key: awsSecretAccessKey,
          aws_session_token: awsSessionToken,
          aws_region: region,
        }),
        signal,
      });

      if (!response.ok) {
        throw new Error(`SSH stream returned ${response.status}: ${await response.text()}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          setLines(prev => {
            const chunks = text.split('\n');
            if (prev.length > 0) {
              const lastIndex = prev.length - 1;
              const updated = [...prev];
              updated[lastIndex] = updated[lastIndex] + chunks[0];
              return [...updated, ...chunks.slice(1)];
            }
            return chunks;
          });
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!signal.aborted) {
        setLines(prev => [...prev, `[System] Connection terminated: ${errMsg}`]);
      }
    } finally {
      if (!signal.aborted) {
        setIsComplete(true);
        if (onSimulationComplete) onSimulationComplete();
      }
    }
  }, [awsAccessKeyId, awsSecretAccessKey, awsSessionToken, instanceId, onSimulationComplete, projectId, region]);

  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout>;

    const tryConnect = () => {
      if (controller.signal.aborted) return;

      if (!hasUsablePrivateKey(privateKey)) {
        const blocked = missingKeyLines(publicIp, instanceId);
        setLines((prev) => (sameLines(prev, blocked) ? prev : blocked));
        setIsComplete(true);
        return;
      }

      if (!isValidIp(publicIp) || !projectId || !awsAccessKeyId || !awsSecretAccessKey) {
        const waiting = waitingLines(publicIp);
        setLines((prev) => (sameLines(prev, waiting) ? prev : waiting));
        retryTimer = setTimeout(tryConnect, 10_000);
        return;
      }

      void startStream(controller.signal, publicIp, privateKey);
    };

    tryConnect();

    return () => {
      controller.abort();
      clearTimeout(retryTimer);
    };
  }, [awsAccessKeyId, awsSecretAccessKey, instanceId, privateKey, projectId, publicIp, startStream]);

  return (
    <div
      className="dw-no-scroll-anchor my-4 overflow-hidden rounded-none dw-panel"
      style={{ overflowAnchor: 'none' }}
      data-no-scroll-anchor="true"
    >
      <div className="flex items-center justify-between border-b-[3px] border-black bg-white px-4 py-2.5">
        <div className="flex items-center gap-2 font-mono text-[11.5px] font-semibold text-black">
          <span className="text-black">AWS</span>
          Console terminal — {projectName} / {instanceId}
        </div>
        <div className="flex items-center gap-3">
          <a
            href={connectUrl(region, instanceId)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[11px] font-semibold text-black underline underline-offset-2"
          >
            Open Session Manager
          </a>
          <StatusLiveDots complete={isComplete} />
        </div>
      </div>
      <div
        ref={terminalRef}
        onScroll={onTerminalScroll}
        className="dw-scrollbar dw-no-scroll-anchor dw-panel-recessed h-64 overflow-y-auto p-4 font-mono text-[12px] leading-relaxed text-[var(--dw-fg-soft)] overscroll-contain"
        style={{ overflowAnchor: 'none' }}
      >
        {lines.map((line, i) => (
          <div key={i} className="min-h-[1.25rem] whitespace-pre-wrap break-all">
            {line}
          </div>
        ))}
        {!isComplete && (
          <span className="dw-caret inline-block h-3.5 w-[7px] bg-[var(--dw-accent)]" />
        )}
      </div>
    </div>
  );
}

function StatusLiveDots({ complete }: { complete: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${complete ? 'bg-[var(--dw-ok)]' : 'dw-pulse bg-[var(--dw-accent)]'}`} />
      <span className="h-2 w-2 rounded-full bg-[var(--dw-border-strong)]" />
      <span className="h-2 w-2 rounded-full bg-[var(--dw-border)]" />
    </div>
  );
}
