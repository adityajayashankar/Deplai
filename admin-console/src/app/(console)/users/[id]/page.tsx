'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
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
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    adminFetch<{ user: UserDetail }>(`/api/admin/users?id=${params.id}`)
      .then((data) => setUser(data.user))
      .catch((error) => setLoadError(error instanceof Error ? error.message : 'Could not load user'));
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

  if (!user) return <div role="status">{loadError || 'Loading user...'}</div>;

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
          <p>Login security is managed by the identity provider. Password and MFA status are not available here.</p>
          <p>Auth provider: {user.authentication.provider}</p>
          <p>API key: {user.apiKey?.configured ? `${user.apiKey.prefix}••••` : 'Not configured'}</p>
        </section>
      </div>
      <section className="card p-4">
        <h2 className="font-medium mb-3">Upgrade / manage organization access</h2>
        <p className="text-sm text-muted mb-3">Open an organization to grant a complimentary tier, adjust credits, or suspend access. Tier access is shared by all its members.</p>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {user.organizations.map((org) => (
                <tr key={org.id}><td><Link className="text-accent underline" href={`/organizations/${org.id}`}>{org.name}</Link></td><td>{org.role}</td><td>{org.status}</td><td><Link className="btn btn-outline" href={`/organizations/${org.id}`}>Upgrade / manage access</Link></td></tr>
              ))}
            </tbody>
          </table>
        </div>
        {!user.organizations.length ? <p className="text-sm text-muted mt-3">This user needs to create or join an organization in DeplAI before you can grant tier access.</p> : null}
      </section>
      <section className="card p-4 space-y-3">
        <h2 className="font-medium">Danger zone</h2>
        <input className="input" placeholder="Reason for session revocation" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="btn btn-danger" type="button" disabled={!reason.trim()} onClick={revokeSessions}>Revoke workspace sessions</button>
        <p className="text-sm text-muted">This affects saved workspace sessions; it does not sign the user out of GitHub or revoke their login cookie.</p>
        {message ? <p className="text-sm text-muted">{message}</p> : null}
      </section>
    </div>
  );
}
