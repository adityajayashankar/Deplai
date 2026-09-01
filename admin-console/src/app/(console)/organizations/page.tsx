'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { adminFetch } from '@/lib/admin-api';
import { formatDate } from '@/lib/utils';

type OrgRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  ownerEmail: string | null;
  memberCount: number;
  createdAt: string;
};

export default function OrganizationsPage() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<OrgRow[]>([]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    adminFetch<{ organizations: OrgRow[] }>(`/api/admin/organizations?${params}`)
      .then((data) => setRows(data.organizations));
  }, [q]);

  return (
    <div>
      <PageHeader title="Organizations" description="Tenancy and governance boundaries." />
      <input className="input max-w-md mb-4" placeholder="Search organizations" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Organization</th><th>Owner</th><th>Members</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/organizations/${row.id}`} className="hover:text-accent">
                    {row.name}
                  </Link>
                  <div className="text-xs text-muted">{row.slug}</div>
                </td>
                <td>{row.ownerEmail || '—'}</td>
                <td>{row.memberCount}</td>
                <td>{row.status}</td>
                <td>{formatDate(row.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
