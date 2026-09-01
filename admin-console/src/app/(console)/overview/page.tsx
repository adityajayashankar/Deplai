'use client';

import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/admin-api';
import { MetricCard, PageHeader } from '@/components/PageHeader';
import { formatDate, formatPaise } from '@/lib/utils';

type Dashboard = {
  totalUsers: number;
  newUsers7d: number;
  totalOrganizations: number;
  totalProjects: number;
  activeSubscriptions: number;
  capturedPayments30d: number;
  refunds30d: number;
  recentSignups: Array<{ id: string; email: string; createdAt: string }>;
  recentPayments: Array<{ id: string; amountPaise: number; status: string; createdAt: string }>;
  recentAudit: Array<{ id: string; action: string; createdAt: string }>;
};

export default function OverviewPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    adminFetch<Dashboard>('/api/admin/dashboard')
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load dashboard'));
  }, []);

  if (error) return <div className="text-danger">{error}</div>;
  if (!data) return <div className="text-muted">Loading operational metrics...</div>;

  return (
    <div>
      <PageHeader title="Overview" description="Live platform metrics from the Deplai control plane." />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4 mb-6">
        <MetricCard label="Total users" value={data.totalUsers} />
        <MetricCard label="New users (7d)" value={data.newUsers7d} />
        <MetricCard label="Organizations" value={data.totalOrganizations} />
        <MetricCard label="Projects" value={data.totalProjects} />
        <MetricCard label="Active subscriptions" value={data.activeSubscriptions} />
        <MetricCard label="Captured payments (30d)" value={data.capturedPayments30d} />
        <MetricCard label="Refunds (30d)" value={data.refunds30d} />
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <section className="card p-4">
          <h2 className="font-medium mb-3">Recent signups</h2>
          <ul className="space-y-2 text-sm">
            {data.recentSignups.map((item) => (
              <li key={item.id} className="flex justify-between gap-3">
                <span>{item.email}</span>
                <span className="text-muted">{formatDate(item.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card p-4">
          <h2 className="font-medium mb-3">Recent payments</h2>
          <ul className="space-y-2 text-sm">
            {data.recentPayments.map((item) => (
              <li key={item.id} className="flex justify-between gap-3">
                <span>{formatPaise(item.amountPaise)}</span>
                <span className="text-muted">{item.status}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card p-4">
          <h2 className="font-medium mb-3">Recent admin actions</h2>
          <ul className="space-y-2 text-sm">
            {data.recentAudit.map((item) => (
              <li key={item.id} className="flex justify-between gap-3">
                <span>{item.action}</span>
                <span className="text-muted">{formatDate(item.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
