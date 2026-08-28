'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';

import { appBtnInk, appBtnPaper, appFocusRing, appPaper } from '@/features/workspace/theme';

const GITHUB_APP_INSTALL_URL =
  process.env.NEXT_PUBLIC_GITHUB_APP_INSTALL_URL
  || (process.env.NEXT_PUBLIC_GITHUB_APP_SLUG
    ? `https://github.com/apps/${process.env.NEXT_PUBLIC_GITHUB_APP_SLUG}/installations/new`
    : 'https://github.com/apps/deplai-app/installations/new');

const focusRing = appFocusRing;

type IntegrationId = 'github' | 'gitlab' | 'slack' | 'linear' | 'jira';

type Installation = {
  id: string;
  installation_id: number;
  account_login: string;
  account_type: string;
  installed_at: string | null;
};

const COMING_SOON: Array<{ id: Exclude<IntegrationId, 'github'>; name: string; blurb: string }> = [
  { id: 'gitlab', name: 'GitLab', blurb: 'Import groups and projects' },
  { id: 'slack', name: 'Slack', blurb: 'Deploy and scan alerts' },
  { id: 'linear', name: 'Linear', blurb: 'Open issues from findings' },
  { id: 'jira', name: 'Jira', blurb: 'Sync tickets from scans' },
];

function BrandMark({ id, className }: { id: IntegrationId; className?: string }) {
  if (id === 'github') {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
        <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.207 11.387.6.111.793-.26.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.84 1.237 1.84 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.5 11.5 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12 24 5.37 18.627 0 12 0Z" />
      </svg>
    );
  }
  if (id === 'gitlab') {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
        <path d="m23.855 9.417-.015-.038L20.24.558a.828.828 0 0 0-.316-.393.837.837 0 0 0-.96.06.82.82 0 0 0-.273.386L16.2 7.945H7.816L5.324.611a.82.82 0 0 0-.274-.386.837.837 0 0 0-.96-.06.828.828 0 0 0-.316.393L.176 9.351l-.015.038a6.017 6.017 0 0 0 1.995 6.946l.021.016 4.933 3.694 2.44 1.847 1.485 1.123a1.004 1.004 0 0 0 1.22 0l1.486-1.123 2.44-1.847 4.932-3.694.021-.016a6.017 6.017 0 0 0 1.995-6.946" />
      </svg>
    );
  }
  if (id === 'slack') {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
        <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52Zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313ZM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834Zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312Zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834Zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312Zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52Zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313Z" />
      </svg>
    );
  }
  if (id === 'linear') {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
        <path d="M3.04 16.1 16.1 3.04A9.7 9.7 0 0 0 12 1.75 10.25 10.25 0 0 0 1.75 12c0 1.5.32 2.92.9 4.2l.39-.1ZM4.7 18.2A10.22 10.22 0 0 0 12 22.25 10.25 10.25 0 0 0 22.25 12c0-2.17-.68-4.18-1.84-5.83L4.7 18.2Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.004-1.005Zm5.723-5.731H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.787a1.005 1.005 0 0 0-1.001-1.005ZM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.005 1.005 0 0 0 23.013 0Z" />
    </svg>
  );
}

function manageInstallUrl(install: Installation): string {
  if (install.account_type === 'Organization') {
    return `https://github.com/organizations/${encodeURIComponent(install.account_login)}/settings/installations/${install.installation_id}`;
  }
  return `https://github.com/settings/installations/${install.installation_id}`;
}

function formatInstalled(value: string | null): string {
  if (!value) return 'Installed';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Installed';
  return `Installed ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

export default function IntegrationsApp({ embedded = false }: { embedded?: boolean }) {
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    const response = await fetch('/api/installations', { cache: 'no-store' }).catch(() => null);
    if (!response) {
      setError('Unable to reach Deplai. Check your connection and retry.');
      setInstallations([]);
      return;
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      setError(payload.error || 'Unable to load GitHub installations.');
      setInstallations([]);
      return;
    }
    const payload = await response.json().catch(() => ({})) as { installations?: Installation[] };
    setInstallations(Array.isArray(payload.installations) ? payload.installations : []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      setLoading(true);
      await load();
      if (!cancelled) setLoading(false);
    };
    void boot();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const openInstall = () => {
    window.open(GITHUB_APP_INSTALL_URL, '_blank', 'noopener,noreferrer');
  };

  const disconnect = async (install: Installation) => {
    if (confirmId !== install.id) {
      setConfirmId(install.id);
      return;
    }
    setDisconnectingId(install.id);
    setError('');
    try {
      const response = await fetch('/api/installations', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installation_id: install.id }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setError(payload.error || 'Unable to disconnect this GitHub account.');
        return;
      }
      setConfirmId(null);
      await load();
    } finally {
      setDisconnectingId(null);
    }
  };

  const connected = installations.length > 0;
  const buttonClass = `inline-flex min-h-10 items-center justify-center gap-2 px-4 py-2 text-[13px] font-bold transition duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

  return (
    <div className={embedded ? '' : 'max-w-5xl'}>
      {embedded ? null : (
        <div className="mb-8">
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Account</p>
          <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-black">Integrations</h2>
          <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-zinc-500">
            Deplai connects through the GitHub App so repositories, scans, and deployments stay in one workspace. GitLab, Slack, Linear, and Jira are on the way.
          </p>
        </div>
      )}

      <article className={`${appPaper} p-5`}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center border-[3px] border-black bg-black text-white">
              <BrandMark id="github" className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-display text-[16px] font-semibold text-black">GitHub App</h3>
                <span className={`font-mono text-[10px] font-semibold uppercase tracking-[0.16em] ${connected ? 'text-black' : 'text-neutral-500'}`}>
                  {loading ? 'Checking' : connected ? 'Active' : 'Not connected'}
                </span>
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-neutral-600">
                Install Deplai on a personal account or organization to import repositories and run deployments.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={openInstall}
            className={`${appBtnInk} shrink-0`}
          >
            {connected ? 'Add account' : 'Install GitHub App'}
          </button>
        </div>

        {error ? (
          <div className="mt-4 border-[3px] border-rose-600 bg-rose-50 px-4 py-3 text-[13px] text-rose-800">
            <p>{error}</p>
            <button type="button" onClick={() => void load()} className={`mt-2 text-[12px] font-medium underline ${focusRing}`}>
              Retry
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="mt-5 space-y-2" aria-busy="true">
            <div className="h-14 animate-pulse border-2 border-black bg-neutral-100" />
            <div className="h-14 animate-pulse border-2 border-black bg-neutral-100" />
          </div>
        ) : connected ? (
          <ul className="mt-5 border-[3px] border-black">
            {installations.map((install) => {
              const confirming = confirmId === install.id;
              const busy = disconnectingId === install.id;
              return (
                <li
                  key={install.id}
                  className="flex flex-col gap-3 border-b-[3px] border-black px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-black">@{install.account_login}</p>
                    <p className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.12em] text-neutral-500">
                      {install.account_type === 'Organization' ? 'Organization' : 'User'} · {formatInstalled(install.installed_at)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a
                      href={manageInstallUrl(install)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`${appBtnPaper}`}
                    >
                      Manage
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void disconnect(install)}
                      className={`${buttonClass} ${
                        confirming
                          ? 'border-[3px] border-black bg-rose-600 text-white shadow-[4px_4px_0_0_#000]'
                          : 'border-[3px] border-black bg-white text-rose-700 shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none'
                      }`}
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                      {busy ? 'Disconnecting…' : confirming ? 'Confirm disconnect' : 'Disconnect'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-5 border-[3px] border-dashed border-black px-4 py-5 text-[13px] text-neutral-600">
            No GitHub App installation yet. After you install it, return here and the account will show as Active.
          </p>
        )}
      </article>

      <div className="mt-6">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">Coming soon</p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {COMING_SOON.map((item) => (
            <div
              key={item.id}
              className={`${appPaper} flex flex-col items-start p-4 opacity-70`}
            >
              <BrandMark id={item.id} className="h-7 w-7 text-black" />
              <p className="mt-3 text-[14px] font-medium text-black">{item.name}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-neutral-600">{item.blurb}</p>
              <span className="mt-3 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-neutral-500">
                Coming soon
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
