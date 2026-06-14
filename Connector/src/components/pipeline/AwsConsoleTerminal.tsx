'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

interface AwsConsoleTerminalProps {
  instanceId: string;
  publicIp?: string;
  privateKey?: string;
  region: string;
  projectName?: string;
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

export function AwsConsoleTerminal({
  instanceId,
  publicIp,
  privateKey,
  region,
  projectName = 'app',
  onSimulationComplete,
}: AwsConsoleTerminalProps) {
  const [lines, setLines] = useState<string[]>([]);
  const terminalRef = useRef<HTMLDivElement>(null);
  const [isComplete, setIsComplete] = useState(false);

  // Auto-scroll terminal when new lines arrive
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [lines]);

  const startStream = useCallback(async (signal: AbortSignal, ip: string, key: string) => {
    setLines([`[System] Initializing secure SSH tunnel to ${ip}...`]);
    try {
      const response = await fetch('/api/ec2/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ipAddress: ip, privateKey: key }),
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
  }, [onSimulationComplete]);

  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout>;

    const tryConnect = () => {
      if (controller.signal.aborted) return;

      if (!isValidIp(publicIp) || !privateKey || privateKey.trim() === '' || privateKey.trim() === 'n/a') {
        // Instance not yet ready — show status and retry in 10s
        setLines([
          `[System] Waiting for EC2 instance to become reachable...`,
          `[System] Public IP: ${publicIp || 'pending'} — will retry automatically every 10s.`,
        ]);
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
  }, [publicIp, privateKey, startStream]);

  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-[#0d1117] shadow-lg overflow-hidden my-4">
      <div className="flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-gray-700">
        <div className="flex items-center gap-2 text-gray-300 text-xs font-semibold font-mono">
          <span className="text-orange-400">AWS</span> Console Terminal - {instanceId}
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full bg-gray-600" />
          <div className="w-3 h-3 rounded-full bg-gray-600" />
          <div className="w-3 h-3 rounded-full bg-gray-600" />
        </div>
      </div>
      <div
        ref={terminalRef}
        className="p-4 font-mono text-xs leading-relaxed text-gray-300 h-64 overflow-y-auto"
        style={{ scrollbarWidth: 'thin', scrollbarColor: '#30363d transparent' }}
      >
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all min-h-[1.25rem]">
            {line}
          </div>
        ))}
        {!isComplete && (
          <div className="flex gap-2">
            <span className="text-gray-400 animate-pulse">_</span>
          </div>
        )}
      </div>
    </div>
  );
}
