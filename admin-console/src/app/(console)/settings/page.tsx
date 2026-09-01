'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { adminFetch } from '@/lib/admin-api';

export default function SettingsPage() {
  const [session, setSession] = useState<{ email?: string; role?: string } | null>(null);

  useEffect(() => {
    adminFetch<{ authenticated: boolean; email?: string; role?: string }>('/api/auth/step-up')
      .then((data) => setSession(data));
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Owner security and session controls." />
      <section className="card p-4 space-y-2">
        <h2 className="font-medium">Signed in as</h2>
        <p>{session?.email || '—'}</p>
        <p className="text-sm text-muted">Role: {session?.role || 'OWNER'}</p>
      </section>
      <section className="card p-4 space-y-2">
        <h2 className="font-medium">Security model</h2>
        <ul className="text-sm text-muted space-y-1 list-disc pl-5">
          <li>Console binds to localhost only in production.</li>
          <li>MFA is required before any privileged session is issued.</li>
          <li>Dangerous operations require password step-up grants.</li>
          <li>Secrets, passwords, and provider keys are never displayed.</li>
        </ul>
      </section>
    </div>
  );
}
