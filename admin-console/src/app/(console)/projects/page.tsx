'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { adminFetch, confirmStepUp } from '@/lib/admin-api';
import { formatDate } from '@/lib/utils';

type ProjectRow = {
  id: string;
  name: string;
  projectType: string;
  ownerEmail: string;
  organizationName: string | null;
  disabled: boolean;
  createdAt: string;
};

export default function ProjectsPage() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');

  async function load() {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    const data = await adminFetch<{ projects: ProjectRow[] }>(`/api/admin/projects?${params}`);
    setRows(data.projects);
  }

  useEffect(() => {
    load().catch(() => setRows([]));
  }, [q]);

  async function toggleProject(project: ProjectRow) {
    setMessage('');
    const action = project.disabled ? 'enable' : 'disable';
    const promptReason = reason.trim() || window.prompt(`Reason to ${action} project`) || '';
    if (!promptReason.trim()) {
      setMessage('Reason is required');
      return;
    }
    try {
      await confirmStepUp('project.delete');
      await adminFetch('/api/admin/projects', {
        method: 'POST',
        body: JSON.stringify({ projectId: project.id, action, reason: promptReason }),
      });
      setMessage(`Project ${action}d.`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Action failed');
    }
  }

  return (
    <div>
      <PageHeader title="Projects" description="Repository and local project inventory." />
      <div className="flex flex-wrap gap-3 mb-4">
        <input className="input max-w-md" placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} />
        <input className="input max-w-md" placeholder="Default reason for disable/enable" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {message ? <p className="text-sm text-muted mb-4">{message}</p> : null}
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Project</th><th>Type</th><th>Owner</th><th>Organization</th><th>Status</th><th>Created</th><th /></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.name}<div className="text-xs text-muted font-[family-name:var(--font-mono)]">{row.id}</div></td>
                <td>{row.projectType}</td>
                <td>{row.ownerEmail}</td>
                <td>{row.organizationName || '—'}</td>
                <td>{row.disabled ? 'Disabled' : 'Active'}</td>
                <td>{formatDate(row.createdAt)}</td>
                <td>
                  <button
                    className={row.disabled ? 'btn btn-outline' : 'btn btn-danger'}
                    type="button"
                    onClick={() => toggleProject(row)}
                  >
                    {row.disabled ? 'Enable' : 'Disable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
