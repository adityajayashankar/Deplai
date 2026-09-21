'use client';
import { useEffect, useState } from 'react';
import type { SecretMetadata } from '@/lib/deplai-build/secrets';
import { appBtnInk, appInput, appPaper } from '@/features/workspace/theme';

export default function SecretEntry({ sessionId, projectId, organizationId }: { sessionId: string; projectId: string; organizationId: string }) {
  const [secrets, setSecrets] = useState<SecretMetadata[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const url = `/api/build/secrets?${new URLSearchParams({ session_id: sessionId, project_id: projectId, organization_id: organizationId })}`;
  const scoped = Boolean(sessionId && projectId && organizationId);
  useEffect(() => {
    if (!scoped) return;
    let active = true;
    fetch(url, { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error();
      const data = await response.json(); if (active) setSecrets(data.secrets);
    }).catch(() => { if (active) setMessage('Unable to load secret requirements. Verify your BuildSession access.'); });
    return () => { active = false; };
  }, [url, scoped]);
  return <main className="h-full overflow-y-auto p-8 text-black">
    <h1 className="text-3xl font-semibold">Build secrets</h1>
    <p className="mt-3 text-sm">Enter credentials here, never in agent chat. Saved values cannot be displayed.</p>
    {!scoped && <p className="mt-6">Secret entry becomes available for a BuildSession with declared credential requirements. Build creation is not available yet.</p>}
    <p role="status" className="mt-4">{message}</p>
    {secrets.map(secret => <form key={secret.reference} className={`${appPaper} mt-5 p-5`} onSubmit={async event => {
      event.preventDefault(); const form = event.currentTarget;
      const value = String(new FormData(form).get('value') || '');
      form.reset(); setBusy(true); setMessage('');
      try {
        const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference: secret.reference, value }) });
        if (!response.ok) throw new Error();
        const data = await response.json(); setSecrets(previous => previous.map(s => s.reference === secret.reference ? data.secret : s));
        setMessage('Secret saved. Only authorized services can receive it.');
      } catch { setMessage('Secret was not saved. Verify access and vault configuration, then enter it again.'); }
      finally { setBusy(false); }
    }}>
      <h2 className="text-lg font-semibold">{secret.name}</h2>
      <p className="mt-2 text-sm">{secret.purpose}</p>
      <p className="mt-2 text-sm">{secret.configured ? 'Configured' : 'Not configured'} · Consumers: {secret.consumers.join(', ')}</p>
      {['USER_PROVIDED', 'INTEGRATION', 'DEPLOYMENT_ONLY'].includes(secret.classification) ? <>
        <label className="mt-3 block text-sm">{secret.configured ? 'Replacement value' : 'Secret value'}<input name="value" type="password" required maxLength={16384} autoComplete="new-password" className={`${appInput} mt-2 w-full`} /></label>
        <button disabled={busy} className={`${appBtnInk} mt-4`}>{busy ? 'Saving…' : 'Save secret'}</button>
      </> : <p className="mt-3 text-sm">Managed internally for this preview.</p>}
    </form>)}
    {scoped && secrets.length === 0 && !message && <p className="mt-5">No required secrets have been declared for this session.</p>}
  </main>;
}
