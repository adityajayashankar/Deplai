'use client';

import { useState } from 'react';

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

  const serviceColors: Record<string, string> = {
    ec2: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
    s3: 'bg-green-500/10 text-green-400 border-green-500/20',
    rds: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    ecs: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    vpc: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
    lambda: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
    elasticache: 'bg-red-500/10 text-red-400 border-red-500/20',
    alb: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
  };

  return (
    <div className="rounded-xl border border-[#1A1A1A] bg-[#0A0A0A] shadow-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#1A1A1A]">
        <div className="flex items-center gap-3">
          <span
            className={`px-3 py-1 rounded-full text-[11px] font-bold uppercase border ${
              serviceColors[serviceType] ?? 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20'
            }`}
          >
            {serviceType}
          </span>
          <span className="text-sm text-zinc-500 font-medium">
            Deployed {new Date(outputs.deployed_at).toLocaleString()}
          </span>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
          <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full shadow-[0_0_8px_rgba(52,211,153,0.5)]" />
          Active
        </span>
      </div>

      {/* Output key-value grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-0 divide-y sm:divide-y-0 sm:divide-x divide-[#1A1A1A]">
        {outputs.outputs.map(({ key, label, value }) => (
          <div key={key} className="px-6 py-4 flex items-start justify-between gap-2 group hover:bg-[#111111] transition-colors duration-200">
            <div>
              <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-semibold mb-1">{label}</p>
              <p className="text-sm font-mono text-zinc-200 break-all">
                {Array.isArray(value) ? value.join(', ') : String(value)}
              </p>
            </div>
            <button
              onClick={() => copyToClipboard(key, String(value))}
              className={`shrink-0 text-[11px] font-medium px-2 py-1 rounded transition-colors ${
                copied === key 
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                  : 'bg-[#1A1A1A] text-zinc-400 border border-[#2A2A2A] hover:text-zinc-200 hover:border-[#3A3A3A] opacity-0 group-hover:opacity-100'
              }`}
            >
              {copied === key ? 'Copied' : 'Copy'}
            </button>
          </div>
        ))}
      </div>

      {/* Keypair section — EC2 only, shown once with prominent warning */}
      {keypair && (
        <div className="mx-6 my-5 rounded-xl bg-amber-500/10 border border-amber-500/20 p-5 backdrop-blur-sm">
          <p className="text-sm font-semibold text-amber-400 flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
            Private Key — Download now. This will not be shown again.
          </p>
          <p className="text-xs text-amber-200/70 mt-2 mb-4">
            Key pair: <span className="font-mono bg-amber-500/10 px-1.5 py-0.5 rounded text-amber-300">{keypair.keypair_name}</span>
          </p>
          <button
            onClick={downloadPem}
            className="px-5 py-2 bg-amber-500 text-amber-950 text-sm font-bold rounded-lg hover:bg-amber-400 transition-colors shadow-[0_0_15px_rgba(245,158,11,0.2)]"
          >
            Download .pem file
          </button>
        </div>
      )}

      {/* Footer */}
      <div className="px-6 py-4 border-t border-[#1A1A1A] bg-[#0A0A0A] flex justify-between items-center mt-auto">
        <span className="text-[11px] text-zinc-600 font-mono tracking-wide">Run ID: {runId}</span>
        <button
          onClick={handleDestroy}
          disabled={destroying}
          className="px-4 py-2 border border-red-500/20 bg-red-500/10 text-red-400 text-xs font-semibold uppercase tracking-wide rounded-lg hover:bg-red-500/20 hover:border-red-500/30 disabled:opacity-50 transition-colors"
        >
          {destroying ? 'Destroying...' : 'Destroy resources'}
        </button>
      </div>
    </div>
  );
}
