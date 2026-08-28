'use client';

import { useState } from 'react';
import { Callout, Panel, StatusPill, buttonClass } from '@/features/deployment/deployment-ui';

interface OutputEntry {
  key: string;
  label: string;
  value: string | string[] | number | boolean;
}

interface ResourceCardProps {
  runId: string;
  serviceType: string;
  outputs: {
    service_type: string;
    deployed_at: string;
    outputs: OutputEntry[];
  };
  keypair?: { private_key_pem: string; keypair_name: string } | null;
  awsCredentials: { access_key_id: string; secret_access_key: string; region: string };
  onDestroyed: () => void;
}

export function ResourceCard({
  runId,
  serviceType,
  outputs,
  keypair,
  awsCredentials,
  onDestroyed,
}: ResourceCardProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const [destroying, setDestroying] = useState(false);

  async function copyToClipboard(key: string, value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  function downloadPem() {
    if (!keypair) return;
    const blob = new Blob([keypair.private_key_pem], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${keypair.keypair_name}.pem`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDestroy() {
    if (
      !confirm(
        `Destroy all ${serviceType.toUpperCase()} resources for this deployment? This cannot be undone.`
      )
    )
      return;
    setDestroying(true);
    await fetch(`/api/pipeline/iac-status/${runId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aws_credentials: awsCredentials }),
    });
    onDestroyed();
  }

  const serviceTone: Record<string, 'accent' | 'ok' | 'info' | 'agent' | 'warn' | 'danger' | 'neutral'> = {
    ec2: 'warn',
    s3: 'ok',
    rds: 'info',
    ecs: 'agent',
    vpc: 'neutral',
    lambda: 'warn',
    elasticache: 'danger',
    alb: 'accent',
  };

  return (
    <Panel padded={false} elevation="raised" glow>
      <div className="flex items-center justify-between border-b border-[var(--dw-border)] px-6 py-4">
        <div className="flex items-center gap-3">
          <StatusPill tone={serviceTone[serviceType] ?? 'neutral'}>{serviceType}</StatusPill>
          <span className="text-[12.5px] text-[var(--dw-muted)]">
            Deployed {new Date(outputs.deployed_at).toLocaleString()}
          </span>
        </div>
        <StatusPill tone="ok" live>
          Active
        </StatusPill>
      </div>

      <div className="grid grid-cols-1 gap-0 divide-y divide-[var(--dw-border)] sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        {outputs.outputs.map(({ key, label, value }) => (
          <div key={key} className="group flex items-start justify-between gap-2 px-6 py-4 transition-colors hover:bg-neutral-100">
            <div className="min-w-0">
              <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--dw-faint)]">{label}</p>
              <p className="break-all font-mono text-[13px] text-[var(--dw-fg-soft)]">
                {Array.isArray(value) ? value.join(', ') : String(value)}
              </p>
            </div>
            <button
              onClick={() => copyToClipboard(key, String(value))}
              className={`${buttonClass(copied === key ? 'secondary' : 'ghost', { size: 'sm' })} shrink-0 ${copied === key ? '' : 'opacity-0 group-hover:opacity-100'}`}
            >
              {copied === key ? 'Copied' : 'Copy'}
            </button>
          </div>
        ))}
      </div>

      {keypair && (
        <div className="mx-6 my-5">
          <Callout tone="warn" title="Private key — download now. This will not be shown again.">
            <p className="mb-3 text-[12px]">
              Key pair: <span className="rounded-none border-[3px] border-black bg-white px-1.5 py-0.5 font-mono text-[var(--dw-warn)]">{keypair.keypair_name}</span>
            </p>
            <button onClick={downloadPem} className={buttonClass('primary', { size: 'sm' })}>
              Download .pem file
            </button>
          </Callout>
        </div>
      )}

      <div className="mt-auto flex items-center justify-between border-t border-[var(--dw-border)] px-6 py-4">
        <span className="font-mono text-[11px] tracking-wide text-[var(--dw-faint)]">Run ID: {runId}</span>
        <button
          onClick={handleDestroy}
          disabled={destroying}
          className={buttonClass('danger', { size: 'sm', disabled: destroying })}
        >
          {destroying ? 'Destroying…' : 'Destroy resources'}
        </button>
      </div>
    </Panel>
  );
}
