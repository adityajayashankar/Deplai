'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { adminFetch } from '@/lib/admin-api';
import { formatDate } from '@/lib/utils';

type ApiKeyRow = {
  userId: string;
  email: string;
  masked: string;
  lastUsedAt: string | null;
  createdAt: string;
};

export default function ApiKeysPage() {
  const [rows, setRows] = useState<ApiKeyRow[]>([]);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    adminFetch<{ keys: ApiKeyRow[] }>('/api/admin/api-keys').then((data) => setRows(data.keys));
  }, []);

  async function revoke(userId: string) {
    setMessage('');
    try {
      const password = prompt('Confirm owner password for API key revocation') || '';
      await adminFetch('/api/auth/step-up', {
        method: 'POST',
        body: JSON.stringify({ password, scope: 'api_key.revoke_all' }),
      });
      await adminFetch('/api/admin/api-keys', {
        method: 'POST',
        body: JSON.stringify({ userId, reason }),
      });
      setRows((current) => current.filter((row) => row.userId !== userId));
      setMessage('API key revoked.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Revocation failed');
    }
  }

  return (
    <div>
      <PageHeader title="API Keys" description="Platform-generated API keys are shown masked only." />
      <input className="input max-w-md mb-4" placeholder="Reason for revocation actions" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>User</th><th>Masked key</th><th>Last used</th><th>Created</th><th /></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.userId}>
                <td>{row.email}</td>
                <td className="font-[family-name:var(--font-mono)]">{row.masked}</td>
                <td>{row.lastUsedAt ? formatDate(row.lastUsedAt) : '—'}</td>
                <td>{formatDate(row.createdAt)}</td>
                <td><button className="btn btn-danger" type="button" onClick={() => revoke(row.userId)}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {message ? <p className="text-sm text-muted mt-3">{message}</p> : null}
    </div>
  );
}
