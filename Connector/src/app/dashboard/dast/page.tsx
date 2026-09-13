'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Globe } from 'lucide-react';
import { SELECTED_PROJECT_STORAGE_KEY } from '@/features/deployment/state';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import { appBtnInk, appInput, appPaper } from '@/features/workspace/theme';
import { DastAssetManager, type DastAsset, type DastScanProfile } from '@/features/security/DastAssetManager';
import { storeDastTarget } from '@/features/security/dastTarget';

export default function DashboardDastPage() {
  const router = useRouter();
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState<DastAsset | null>(null);
  const [profile, setProfile] = useState<DastScanProfile>('BASELINE');

  useEffect(() => {
    const stored = new URLSearchParams(window.location.search).get('projectId') || window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY) || '';
    setProjectId(stored);
    void fetch('/api/projects', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        const rows = Array.isArray(data?.projects) ? data.projects : [];
        setProjects(rows.map((item: { id: string; name?: string }) => ({ id: item.id, name: item.name || item.id })));
      })
      .catch(() => setProjects([]));
  }, []);

  const canStart = Boolean(projectId && selected?.status === 'VERIFIED');

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent font-sans">
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <WorkspaceCommandHeader section="Dynamic Testing" onExit={() => router.push('/dashboard')} />
        <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
          <div className="mx-auto max-w-2xl">
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Security Pipeline</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-black">Dynamic Testing</h2>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">
              Run authorized DAST from the Security Pipeline against a verified host you own. Unrelated public websites are blocked server-side.
            </p>

            <section className={`${appPaper} mt-8 space-y-4 p-6`}>
              <Globe className="h-5 w-5" />
              <h3 className="font-display text-lg text-black">Project</h3>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-neutral-500">
                Project
                <select
                  value={projectId}
                  onChange={(event) => {
                    setProjectId(event.target.value);
                    setSelected(null);
                  }}
                  className={`mt-2 ${appInput}`}
                >
                  <option value="">Select a project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))}
                </select>
              </label>
            </section>

            {projectId ? (
              <div className="mt-6">
                <DastAssetManager
                  projectId={projectId}
                  selectedId={selected?.id || ''}
                  onSelect={setSelected}
                  profile={profile}
                  onProfileChange={setProfile}
                />
              </div>
            ) : null}

            <button
              type="button"
              disabled={!canStart}
              onClick={() => {
                if (!selected) return;
                storeDastTarget(projectId, selected.target_url);
                const query = new URLSearchParams({
                  surface: 'dynamic',
                  dastAsset: selected.id,
                  dastTarget: selected.target_url,
                  dastProfile: profile,
                  run: 'dast',
                });
                router.push(`/dashboard/security-analysis/${encodeURIComponent(projectId)}?${query.toString()}`);
              }}
              className={`mt-6 ${appBtnInk}`}
            >
              Review scope and start scan
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
