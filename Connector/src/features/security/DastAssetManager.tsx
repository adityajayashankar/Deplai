'use client';

import { useCallback, useEffect, useState } from 'react';
import { appBtnInk, appBtnPaper, appInput, secPaper } from '@/features/workspace/theme';

export type DastAsset = {
  id: string;
  project_id: string;
  target_url: string;
  hostname: string;
  scheme: string;
  environment: string;
  scope_mode: string;
  status: string;
  verification_method: string | null;
  verified_at: string | null;
  expires_at: string | null;
  dns_name?: string;
  verification_token?: string;
  txt_value?: string;
  http_path?: string;
};

export type DastScanProfile = 'BASELINE' | 'FULL' | 'API';

function statusLabel(status: string): string {
  switch (status) {
    case 'VERIFIED': return 'Verified';
    case 'PENDING': return 'Pending verification';
    case 'EXPIRED': return 'Verification expired';
    case 'REVOKED': return 'Revoked';
    case 'REJECTED': return 'Unauthorized';
    default: return status;
  }
}

export function DastAssetManager({
  projectId,
  selectedId,
  onSelect,
  profile,
  onProfileChange,
  compact,
}: {
  projectId: string;
  selectedId: string;
  onSelect: (asset: DastAsset | null) => void;
  profile: DastScanProfile;
  onProfileChange: (value: DastScanProfile) => void;
  compact?: boolean;
}) {
  const [assets, setAssets] = useState<DastAsset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [environment, setEnvironment] = useState('production');
  const [scopeMode, setScopeMode] = useState<'VERIFIED_HOST' | 'VERIFIED_DOMAIN'>('VERIFIED_HOST');

  const refresh = useCallback(async () => {
    if (!projectId) return;
    const response = await fetch(`/api/dast/assets?project_id=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
    const body = await response.json().catch(() => ({})) as { assets?: DastAsset[]; error?: string };
    if (!response.ok) {
      setError(body.error || 'Unable to load DAST targets.');
      return;
    }
    const rows = Array.isArray(body.assets) ? body.assets : [];
    setAssets(rows);
    setError(null);
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = assets.find((item) => item.id === selectedId) || null;

  async function addTarget() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/dast/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          target_url: url.trim(),
          environment,
          scope_mode: scopeMode,
        }),
      });
      const body = await response.json().catch(() => ({})) as { asset?: DastAsset; error?: string; code?: string };
      if (!response.ok) {
        setError(body.error || 'This target could not be added.');
        return;
      }
      setUrl('');
      await refresh();
      if (body.asset) onSelect(body.asset);
    } finally {
      setBusy(false);
    }
  }

  async function act(path: string, payload?: Record<string, string>) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/dast/assets/${encodeURIComponent(selected.id)}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setError(body.error || 'Request failed.');
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className={`${secPaper} p-6`}>
        <h3 className="text-sm font-semibold text-black">Verified targets</h3>
        <p className="mt-2 text-sm text-neutral-600">
          Dynamic testing only runs against a target associated with this project after ownership is verified. Public websites you do not own are rejected.
        </p>
        {assets.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">No targets yet. Add a URL you control, then complete DNS or HTTP verification.</p>
        ) : (
          <div className="mt-4 space-y-2">
            {assets.map((asset) => (
              <button
                key={asset.id}
                type="button"
                onClick={() => onSelect(asset)}
                className={`w-full border-[2px] px-3 py-3 text-left ${selectedId === asset.id ? 'border-black bg-neutral-50' : 'border-black/15 bg-white'}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-mono text-sm text-black">{asset.target_url}</p>
                    <p className="mt-1 text-[11px] uppercase tracking-wider text-neutral-500">
                      {statusLabel(asset.status)} · {asset.scope_mode.replace('_', ' ')} · {asset.environment}
                    </p>
                  </div>
                  {asset.status === 'VERIFIED' ? <span className="text-xs font-semibold text-emerald-700">Verified</span> : null}
                </div>
              </button>
            ))}
          </div>
        )}
        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      </div>

      <div className={`${secPaper} p-6`}>
        <h3 className="text-sm font-semibold text-black">Add target</h3>
        <label className="mt-4 mb-1 block font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500" htmlFor="dast-add-url">
          Target URL
        </label>
        <input id="dast-add-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://app.example.com" className={appInput} />
        <div className={`mt-3 grid gap-3 ${compact ? '' : 'sm:grid-cols-2'}`}>
          <label className="block font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">
            Environment
            <select value={environment} onChange={(event) => setEnvironment(event.target.value)} className={`mt-1 ${appInput}`}>
              <option value="production">Production</option>
              <option value="staging">Staging</option>
              <option value="preview">Preview</option>
            </select>
          </label>
          <label className="block font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">
            Scope
            <select value={scopeMode} onChange={(event) => setScopeMode(event.target.value as 'VERIFIED_HOST' | 'VERIFIED_DOMAIN')} className={`mt-1 ${appInput}`}>
              <option value="VERIFIED_HOST">Exact host</option>
              <option value="VERIFIED_DOMAIN">Domain and subdomains</option>
            </select>
          </label>
        </div>
        <button type="button" disabled={busy || !url.trim() || !projectId} onClick={() => void addTarget()} className={`mt-4 ${appBtnPaper}`}>
          Add target
        </button>
      </div>

      {selected ? (
        <div className={`${secPaper} p-6`}>
          <h3 className="text-sm font-semibold text-black">{selected.hostname}</h3>
          <p className="mt-2 text-sm text-neutral-600">
            {statusLabel(selected.status)}
            {selected.verification_method ? ` · Method: ${selected.verification_method === 'DNS_TXT' ? 'DNS TXT' : 'HTTP file'}` : ''}
            {selected.verified_at ? ` · Verified: ${new Date(selected.verified_at).toLocaleDateString()}` : ''}
            {selected.expires_at ? ` · Expires: ${new Date(selected.expires_at).toLocaleDateString()}` : ''}
          </p>
          <p className="mt-1 text-xs text-neutral-500">Scope: {selected.scope_mode === 'VERIFIED_DOMAIN' ? `${selected.hostname} and subdomains` : selected.hostname}</p>
          {selected.status === 'PENDING' ? (
            <div className="mt-4 space-y-2 bg-neutral-50 p-4 font-mono text-xs text-black">
              <p>Verification required</p>
              <p>Add this TXT record:</p>
              <p>{selected.dns_name || `_deplai-verify.${selected.hostname}`}</p>
              <p>TXT: {selected.txt_value || 'deplai-domain-verification=********'}</p>
              {selected.http_path ? <p>Or HTTPS file: {selected.http_path}</p> : null}
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => void act('verify', { method: 'DNS_TXT' })} className={appBtnInk}>Verify DNS</button>
            <button type="button" disabled={busy} onClick={() => void act('verify', { method: 'HTTP' })} className={appBtnPaper}>Verify HTTP</button>
            <button type="button" disabled={busy} onClick={() => void refresh()} className={appBtnPaper}>Refresh status</button>
            <button type="button" disabled={busy} onClick={() => void act('revoke')} className={appBtnPaper}>Revoke</button>
          </div>
        </div>
      ) : null}

      <div className={`${secPaper} p-6`}>
        <h3 className="text-sm font-semibold text-black">Scan type</h3>
        <p className="mt-2 text-sm text-neutral-600">Passive DAST discovers issues without active attacks. Active DAST is explicit and may change application state.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {([
            ['BASELINE', 'Passive DAST'],
            ['FULL', 'Active DAST'],
            ['API', 'API DAST'],
          ] as Array<[DastScanProfile, string]>).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => onProfileChange(id)}
              className={`border-[2px] px-3 py-2 text-sm ${profile === id ? 'border-black bg-black text-white' : 'border-black/20 bg-white text-black'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
