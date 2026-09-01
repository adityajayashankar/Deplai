'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { adminFetch } from '@/lib/admin-api';
import { formatDate, formatPaise } from '@/lib/utils';

type RefundRow = {
  id: string;
  checkoutIntentId: string;
  providerRefundId: string | null;
  amountPaise: number;
  status: string;
  reason: string;
  createdAt: string;
};

export default function RefundsPage() {
  const [rows, setRows] = useState<RefundRow[]>([]);

  useEffect(() => {
    adminFetch<{ refunds: RefundRow[] }>('/api/admin/refunds').then((data) => setRows(data.refunds));
  }, []);

  return (
    <div>
      <PageHeader title="Refunds" description="Recorded refund actions with audit trail." />
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Refund</th><th>Payment</th><th>Amount</th><th>Status</th><th>Reason</th><th>Created</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.providerRefundId || row.id}</td>
                <td>{row.checkoutIntentId}</td>
                <td>{formatPaise(row.amountPaise)}</td>
                <td>{row.status}</td>
                <td>{row.reason}</td>
                <td>{formatDate(row.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
