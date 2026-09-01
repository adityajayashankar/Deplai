'use client';

import { Building2, Check, Loader2, LogIn } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LOGIN_HREF } from '@/lib/auth-providers';
import { appBtnInk, appBtnPaper, appPaper } from '@/features/workspace/theme';

export default function AcceptInvitationApp({ token }: { token: string }) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'loading' | 'accepted' | 'error' | 'login'>('idle');
  const [message, setMessage] = useState('');

  const accept = async () => {
    setState('loading');
    const response = await fetch(`/api/v1/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST' }).catch(() => null);
    if (!response) {
      setState('error');
      setMessage('DeplAI could not reach the invitation service. Try again.');
      return;
    }
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (response.status === 401) {
      setState('login');
      setMessage('Sign in with the invited email address, then return to this link.');
      return;
    }
    if (!response.ok) {
      setState('error');
      setMessage(payload.error || 'This invitation is invalid or no longer available.');
      return;
    }
    setState('accepted');
    setMessage('You joined the organization. Your active organization has been updated.');
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f2f2f2] p-6 font-sans text-black">
      <section className={`${appPaper} w-full max-w-lg p-7`}>
        <div className="flex h-12 w-12 items-center justify-center border-[3px] border-black bg-black text-white"><Building2 className="h-5 w-5" /></div>
        <p className="mt-6 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-500">Organization invitation</p>
        <h1 className="mt-2 font-display text-2xl font-semibold">Join a DeplAI organization</h1>
        <p className="mt-3 text-[13px] leading-relaxed text-neutral-600">Accepting adds your signed-in account to the organization with the role chosen by its administrator. The invitation is single-use and email-bound.</p>
        {message ? <div className={`mt-5 border-[3px] border-black p-4 text-[12px] font-bold ${state === 'accepted' ? 'bg-emerald-100' : state === 'error' ? 'bg-red-100' : 'bg-amber-100'}`}>{message}</div> : null}
        <div className="mt-6 flex flex-wrap gap-3">
          {state === 'accepted' ? <button className={appBtnInk} onClick={() => router.push('/dashboard/organization')}><Check className="h-4 w-4" /> Open organization</button> : state === 'login' ? <a className={appBtnInk} href={LOGIN_HREF}><LogIn className="h-4 w-4" /> Sign in</a> : <button className={appBtnInk} disabled={state === 'loading'} onClick={() => void accept()}>{state === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Accept invitation</button>}
          <button className={appBtnPaper} onClick={() => router.push('/dashboard')}>Back to dashboard</button>
        </div>
      </section>
    </main>
  );
}
