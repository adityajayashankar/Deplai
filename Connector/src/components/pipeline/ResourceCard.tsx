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
    ec2: 'bg-orange-100 text-orange-800',
    s3: 'bg-green-100 text-green-800',
    rds: 'bg-blue-100 text-blue-800',
    ecs: 'bg-purple-100 text-purple-800',
    vpc: 'bg-gray-100 text-gray-800',
    lambda: 'bg-yellow-100 text-yellow-800',
    elasticache: 'bg-red-100 text-red-800',
    alb: 'bg-indigo-100 text-indigo-800',
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <span
            className={`px-3 py-1 rounded-full text-xs font-bold uppercase ${
              serviceColors[serviceType] ?? 'bg-gray-100 text-gray-800'
            }`}
          >
            {serviceType}
          </span>
          <span className="text-sm text-gray-500">
            Deployed {new Date(outputs.deployed_at).toLocaleString()}
          </span>
        </div>
        <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
          <span className="w-2 h-2 bg-green-500 rounded-full" />
          Active
        </span>
      </div>

      {/* Output key-value grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-0 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">
        {outputs.outputs.map(({ key, label, value }) => (
          <div key={key} className="px-6 py-3 flex items-start justify-between gap-2">
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wide">{label}</p>
              <p className="text-sm font-mono text-gray-900 break-all mt-0.5">
                {Array.isArray(value) ? value.join(', ') : String(value)}
              </p>
            </div>
            <button
              onClick={() => copyToClipboard(key, String(value))}
              className="shrink-0 text-xs text-gray-400 hover:text-gray-700 mt-1"
            >
              {copied === key ? '✓' : 'Copy'}
            </button>
          </div>
        ))}
      </div>

      {/* Keypair section — EC2 only, shown once with prominent warning */}
      {keypair && (
        <div className="mx-6 my-4 rounded-lg bg-amber-50 border border-amber-200 p-4">
          <p className="text-sm font-semibold text-amber-800">
            ⚠ Private Key — Download now. This will not be shown again.
          </p>
          <p className="text-xs text-amber-600 mt-1 mb-3">
            Key pair: <span className="font-mono">{keypair.keypair_name}</span>
          </p>
          <button
            onClick={downloadPem}
            className="px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700"
          >
            Download .pem file
          </button>
        </div>
      )}

      {/* Footer */}
      <div className="px-6 py-4 border-t border-gray-100 flex justify-between items-center">
        <span className="text-xs text-gray-400 font-mono">Run ID: {runId}</span>
        <button
          onClick={handleDestroy}
          disabled={destroying}
          className="px-4 py-2 bg-red-50 text-red-600 text-sm font-medium rounded-lg hover:bg-red-100 disabled:opacity-50"
        >
          {destroying ? 'Destroying...' : 'Destroy resources'}
        </button>
      </div>
    </div>
  );
}
