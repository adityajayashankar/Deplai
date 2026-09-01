'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function MfaPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState(searchParams.get('error') || '');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (searchParams.get('error')) return;
    fetch('/api/auth/mfa/status', { credentials: 'same-origin' })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.pending) {
          setError('Login session expired. Please sign in again.');
        }
      })
      .catch(() => setError('Login session expired. Please sign in again.'));
  }, [searchParams]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/auth/mfa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          code: code || undefined,
          recoveryCode: recoveryCode || undefined,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401 && payload.error?.includes('expired')) {
          throw new Error('Login session expired. Go back to login and try again.');
        }
        throw new Error(payload.error || 'MFA verification failed');
      }
      router.push('/overview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'MFA verification failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={onSubmit} className="card w-full max-w-md p-8 space-y-5">
        <div>
          <h1 className="text-2xl font-[family-name:var(--font-display)] font-semibold">Verify MFA</h1>
          <p className="text-sm text-muted mt-2">Enter your authenticator code or a one-time recovery code.</p>
        </div>
        {error ? (
          <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger space-y-2">
            <p>{error}</p>
            {error.includes('expired') || error.includes('sign in') ? (
              <a href="/login" className="text-accent underline">Back to login</a>
            ) : null}
          </div>
        ) : null}
        <label className="block space-y-2">
          <span className="text-sm text-muted">Authenticator code</span>
          <input className="input" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
        </label>
        <label className="block space-y-2">
          <span className="text-sm text-muted">Recovery code</span>
          <input className="input" value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} placeholder="Optional" />
        </label>
        <button className="btn btn-primary w-full" type="submit" disabled={loading}>
          {loading ? 'Verifying...' : 'Verify and enter console'}
        </button>
      </form>
    </div>
  );
}
