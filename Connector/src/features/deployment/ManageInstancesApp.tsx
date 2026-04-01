'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, ExternalLink, RefreshCw, Server } from 'lucide-react';
import { extractDeploymentSummary, listProjectDeploymentRecords, type ProjectRecord } from './state';

export default function ManageInstancesApp() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadProjects = async () => {
    setRefreshing(true);
    try {
      const response = await fetch('/api/projects', { cache: 'no-store' });
      const data = await response.json().catch(() => ({})) as { projects?: ProjectRecord[] };
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadProjects();
  }, []);

  const records = useMemo(() => listProjectDeploymentRecords(projects), [projects]);

  return (
    <div className="flex h-screen overflow-hidden bg-black font-sans text-zinc-300">
      <div className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-16 items-center justify-between border-b border-[#1A1A1A] bg-[#050505] px-8">
          <div className="flex items-center gap-2 text-sm">
            <button onClick={() => router.push('/dashboard')} className="font-medium text-zinc-500 hover:text-white">Dashboard</button>
            <ChevronRight className="h-4 w-4 text-zinc-700" />
            <span className="font-medium text-zinc-100">Manage Instances</span>
          </div>
          <button onClick={() => void loadProjects()} className="flex items-center gap-2 rounded-md border border-[#262626] bg-[#111111] px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-[#181818]">
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </header>
        <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
          <div className="mx-auto max-w-6xl space-y-6">
            <div>
              <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Deployments & Instances</h1>
              <p className="text-sm text-zinc-400">Historical deploy records and the latest instance details per project.</p>
            </div>
            {records.length === 0 && (
              <div className="rounded-lg border border-dashed border-[#1A1A1A] bg-[#050505] p-10 text-center text-sm text-zinc-500">
                No deployments recorded yet.
              </div>
            )}
            {records.map((record) => {
              const summary = extractDeploymentSummary(record.latest?.deployResult || record.snapshot.deployResult);
              return (
                <div key={record.projectId} className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6">
                  <div className="flex items-start justify-between gap-6">
                    <div className="flex items-start gap-4">
                      <div className="flex h-10 w-10 items-center justify-center rounded-md border border-[#1A1A1A] bg-black">
                        <Server className="h-5 w-5 text-zinc-300" />
                      </div>
                      <div>
                        <h2 className="text-lg font-semibold text-zinc-100">{record.projectName}</h2>
                        <p className="mt-1 text-xs text-zinc-500">Last updated {new Date(record.snapshot.updatedAt).toLocaleString()}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`rounded border px-2.5 py-1 text-[11px] font-medium ${record.snapshot.status === 'done' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400' : record.snapshot.status === 'running' ? 'border-indigo-500/20 bg-indigo-500/10 text-indigo-300' : 'border-zinc-700/30 bg-zinc-800/20 text-zinc-400'}`}>
                        {record.snapshot.status.toUpperCase()}
                      </span>
                      <button onClick={() => router.push(`/dashboard/deploy?projectId=${encodeURIComponent(record.projectId)}`)} className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-semibold text-black hover:bg-white">
                        Open Deployment
                      </button>
                    </div>
                  </div>
                  <div className="mt-6 grid grid-cols-2 gap-6 lg:grid-cols-4">
                    <div><p className="mb-1 text-[10px] font-bold uppercase text-zinc-500">Instance ID</p><p className="font-mono text-sm text-zinc-200">{summary.instanceId}</p></div>
                    <div><p className="mb-1 text-[10px] font-bold uppercase text-zinc-500">Public IP</p><p className="font-mono text-sm text-zinc-200">{summary.publicIp}</p></div>
                    <div><p className="mb-1 text-[10px] font-bold uppercase text-zinc-500">VPC</p><p className="font-mono text-sm text-zinc-200">{summary.vpcId}</p></div>
                    <div><p className="mb-1 text-[10px] font-bold uppercase text-zinc-500">Subnet</p><p className="font-mono text-sm text-zinc-200">{summary.subnetId}</p></div>
                  </div>
                  <div className="mt-4 flex items-center gap-2 text-sm">
                    <span className="text-zinc-500">CloudFront:</span>
                    <span className="font-mono text-zinc-200">{summary.cloudfrontUrl}</span>
                    {summary.cloudfrontUrl !== 'n/a' && (
                      <button onClick={() => window.open(summary.cloudfrontUrl.startsWith('http') ? summary.cloudfrontUrl : `https://${summary.cloudfrontUrl}`, '_blank', 'noopener,noreferrer')} className="text-zinc-500 hover:text-zinc-200">
                        <ExternalLink className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: `.custom-scrollbar::-webkit-scrollbar{width:6px}.custom-scrollbar::-webkit-scrollbar-track{background:transparent}.custom-scrollbar::-webkit-scrollbar-thumb{background-color:#262626;border-radius:10px}.custom-scrollbar::-webkit-scrollbar-thumb:hover{background-color:#3f3f46}` }} />
    </div>
  );
}
