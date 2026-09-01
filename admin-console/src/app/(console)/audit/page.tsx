'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { adminFetch } from '@/lib/admin-api';
import { formatDate } from '@/lib/utils';

type AuditRow = {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  actorAdminId: string | null;
  success: boolean;
  reason: string | null;
  createdAt: string;
};

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);

  useEffect(() => {
    adminFetch<{ events: AuditRow[] }>('/api/admin/audit').then((data) => setRows(data.events));
  }, []);

  return (
    <div>
      <PageHeader title="Audit Log" description="Tamper-evident owner action history." />
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Action</th><th>Target</th><th>Actor</th><th>Success</th><th>Reason</th><th>Time</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.action}</td>
                <td>{row.targetType ? `${row.targetType}:${row.targetId}` : '—'}</td>
                <td className="font-[family-name:var(--font-mono)] text-xs">{row.actorAdminId || '—'}</td>
                <td>{row.success ? 'yes' : 'no'}</td>
                <td>{row.reason || '—'}</td>
                <td>{formatDate(row.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
