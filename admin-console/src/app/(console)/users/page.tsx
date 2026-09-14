'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { adminFetch } from '@/lib/admin-api';
import { formatDate } from '@/lib/utils';

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  organizationCount: number;
  projectCount: number;
  planName: string | null;
  subscriptionStatus: string | null;
};

export default function UsersPage() {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    params.set('offset', String(offset));
    params.set('limit', '50');
    if (q) params.set('q', q);
    adminFetch<{ users: UserRow[]; total: number }>(`/api/admin/users?${params}`)
      .then((data) => {
        if (!active) return;
        setUsers(data.users);
        setTotal(data.total);
      })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Failed to load users'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [q, offset]);

  return (
    <div>
      <PageHeader title="Users" description={`${total} accounts in the platform directory.`} />
      <div className="mb-4">
        <input className="input max-w-md" placeholder="Search email, name, or user ID" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
      </div>
      {error ? <p className="text-danger">{error}</p> : null}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Billing plan</th>
              <th>Organizations</th>
              <th>Projects</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <Link href={`/users/${user.id}`} className="text-accent hover:underline">
                    {user.email}
                  </Link>
                  <div>{user.name}</div>
                  <div className="text-xs text-muted font-[family-name:var(--font-mono)]">{user.id}</div>
                </td>
                <td>{user.planName || '—'}<div className="text-xs text-muted">{user.subscriptionStatus || 'none'}</div></td>
                <td>{user.organizationCount}</td>
                <td>{user.projectCount}</td>
                <td>{formatDate(user.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3 mt-4" aria-live="polite">
        <button className="btn btn-outline" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button>
        <span>{loading ? 'Loading accounts...' : total ? `${offset + 1}–${Math.min(offset + users.length, total)} of ${total}` : 'No matching accounts'}</span>
        <button className="btn btn-outline" disabled={loading || offset + 50 >= total} onClick={() => setOffset(offset + 50)}>Next</button>
      </div>
    </div>
  );
}
