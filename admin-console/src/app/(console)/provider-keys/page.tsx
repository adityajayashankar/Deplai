'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { adminFetch } from '@/lib/admin-api';
import { formatDate } from '@/lib/utils';

type ProviderKeyRow = {
  id: string;
  email: string;
  provider: string;
  label: string | null;
  status: string;
  masked: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export default function ProviderKeysPage() {
  const [rows, setRows] = useState<ProviderKeyRow[]>([]);

  useEffect(() => {
    adminFetch<{ keys: ProviderKeyRow[] }>('/api/admin/api-keys?kind=provider')
      .then((data) => setRows(data.keys));
  }, []);

  return (
    <div>
      <PageHeader title="Provider Keys / BYOK" description="Bring-your-own-key credentials are never displayed in plaintext." />
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>User</th><th>Provider</th><th>Label</th><th>Masked</th><th>Status</th><th>Last used</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.email}</td>
                <td>{row.provider}</td>
                <td>{row.label || '—'}</td>
                <td className="font-[family-name:var(--font-mono)]">{row.masked}</td>
                <td>{row.status}</td>
                <td>{row.lastUsedAt ? formatDate(row.lastUsedAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
