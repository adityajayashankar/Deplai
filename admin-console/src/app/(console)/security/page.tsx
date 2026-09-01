'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { adminFetch } from '@/lib/admin-api';
import { formatDate } from '@/lib/utils';

type SecurityRow = {
  id: string;
  adminId: string | null;
  eventType: string;
  ip: string | null;
  createdAt: string;
};

export default function SecurityPage() {
  const [rows, setRows] = useState<SecurityRow[]>([]);

  useEffect(() => {
    adminFetch<{ events: SecurityRow[] }>('/api/admin/audit?kind=security')
      .then((data) => setRows(data.events));
  }, []);

  return (
    <div>
      <PageHeader title="Security Events" description="Authentication and control-plane security signals." />
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Event</th><th>Admin</th><th>IP</th><th>Time</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.eventType}</td>
                <td className="font-[family-name:var(--font-mono)] text-xs">{row.adminId || '—'}</td>
                <td>{row.ip || '—'}</td>
                <td>{formatDate(row.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
