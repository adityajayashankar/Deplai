'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { adminFetch } from '@/lib/admin-api';
import { formatDate, formatPaise } from '@/lib/utils';

type PaymentRow = {
  id: string;
  userEmail: string;
  organizationName: string | null;
  totalPaise: number;
  status: string;
  paymentMode: string;
  razorpayPaymentId: string | null;
  createdAt: string;
};

export default function PaymentsPage() {
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [selected, setSelected] = useState<PaymentRow | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    adminFetch<{ payments: PaymentRow[] }>('/api/admin/payments')
      .then((data) => setRows(data.payments));
  }, []);

  async function issueRefund() {
    if (!selected) return;
    setMessage('');
    try {
      const password = prompt('Confirm owner password for refund step-up') || '';
      await adminFetch('/api/auth/step-up', {
        method: 'POST',
        body: JSON.stringify({ password, scope: 'refund.create' }),
      });
      const result = await adminFetch<{ refund: { providerRefundId: string; amountPaise: number } }>('/api/admin/refunds', {
        method: 'POST',
        body: JSON.stringify({ checkoutIntentId: selected.id, reason }),
      });
      setMessage(`Refund ${result.refund.providerRefundId} issued for ${formatPaise(result.refund.amountPaise)}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Refund failed');
    }
  }

  return (
    <div>
      <PageHeader title="Payments" description="Captured Razorpay checkout intents." />
      <div className="table-wrap mb-6">
        <table className="data-table">
          <thead><tr><th>Payment</th><th>User</th><th>Amount</th><th>Status</th><th>Mode</th><th>Created</th><th /></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.razorpayPaymentId || row.id}</td>
                <td>{row.userEmail}</td>
                <td>{formatPaise(row.totalPaise)}</td>
                <td>{row.status}</td>
                <td>{row.paymentMode}</td>
                <td>{formatDate(row.createdAt)}</td>
                <td><button className="btn btn-outline" type="button" onClick={() => setSelected(row)}>Refund</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected ? (
        <section className="card p-4 space-y-3">
          <h2 className="font-medium">Refund {selected.razorpayPaymentId || selected.id}</h2>
          <p className="text-sm text-muted">Full refundable amount will be computed server-side from Razorpay and recorded refunds.</p>
          <input className="input" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn btn-danger" type="button" onClick={issueRefund}>Issue refund</button>
          {message ? <p className="text-sm text-muted">{message}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
