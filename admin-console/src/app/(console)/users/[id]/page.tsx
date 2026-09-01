'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/PageHeader';
import { adminFetch } from '@/lib/admin-api';
import { formatDate } from '@/lib/utils';

type UserDetail = {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  authentication: { passwordConfigured: boolean; mfaEnabled: boolean; provider: string };
  organizations: Array<{ id: string; name: string; role: string; status: string }>;
  projectCount: number;
  apiKey: { configured: boolean; prefix: string | null; lastUsedAt: string | null } | null;
};

export default function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const [user, setUser] = useState<UserDetail | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    adminFetch<{ user: UserDetail }>(`/api/admin/users?id=${params.id}`)
      .then((data) => setUser(data.user))
      .catch(() => setUser(null));
  }, [params.id]);

  async function revokeSessions() {
    setMessage('');
    try {
      await adminFetch('/api/auth/step-up', {
        method: 'POST',
        body: JSON.stringify({ password: prompt('Confirm owner password for step-up') || '', scope: 'user.revoke_sessions' }),
      });
      const result = await adminFetch<{ revoked: number }>('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ userId: params.id, action: 'revoke_sessions', reason }),
      });
      setMessage(`Revoked ${result.revoked} active workspace sessions.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Action failed');
    }
  }

  if (!user) return <div className="text-muted">Loading user...</div>;

  return (
    <div className="space-y-6">
      <PageHeader title={user.email} description={`User ID ${user.id}`} />
      <div className="grid gap-4 md:grid-cols-2">
        <section className="card p-4 space-y-2">
          <h2 className="font-medium">Account</h2>
          <p>Name: {user.name || '—'}</p>
          <p>Created: {formatDate(user.createdAt)}</p>
          <p>Projects: {user.projectCount}</p>
        </section>
        <section className="card p-4 space-y-2">
          <h2 className="font-medium">Security</h2>
          <p>Password configured: {user.authentication.passwordConfigured ? 'Yes' : 'No'}</p>
          <p>MFA enabled: {user.authentication.mfaEnabled ? 'Yes' : 'No'}</p>
          <p>Auth provider: {user.authentication.provider}</p>
          <p>API key: {user.apiKey?.configured ? `${user.apiKey.prefix}••••` : 'Not configured'}</p>
        </section>
      </div>
      <section className="card p-4">
        <h2 className="font-medium mb-3">Organizations</h2>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>
              {user.organizations.map((org) => (
                <tr key={org.id}><td>{org.name}</td><td>{org.role}</td><td>{org.status}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card p-4 space-y-3">
        <h2 className="font-medium">Danger zone</h2>
        <input className="input" placeholder="Reason for session revocation" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="btn btn-danger" type="button" onClick={revokeSessions}>Revoke active sessions</button>
        {message ? <p className="text-sm text-muted">{message}</p> : null}
      </section>
    </div>
  );
}
